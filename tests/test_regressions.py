"""Regression tests for defects found during live end-to-end verification (evals/live_e2e.py)."""

import os

import pytest
from fastapi.testclient import TestClient

from alexia.api.demo import normalize_scenario_id
from alexia.api.main import app
from alexia.core.bus import get_event_bus
from alexia.core.llm import get_llm_client
from alexia.core.memory import get_runbook_memory
from alexia.core.router import get_model_router
from alexia.core.schemas import Action, Diagnosis
from alexia.remote.auth import get_auth_manager


def test_step_up_token_round_trips():
    """Tokens were signed over the float expiry but carried the int one, so verification always failed."""
    auth = get_auth_manager()
    valid, user, method = auth.verify_step_up_token(auth.create_step_up_token("demo", method="totp"))
    assert (valid, user, method) == (True, "demo", "totp")
    valid, user, device = auth.verify_session_token(auth.create_session_token("demo", "phone1"))
    assert (valid, user, device) == (True, "demo", "phone1")


def test_resume_autonomy_requires_valid_step_up():
    client = TestClient(app)
    assert client.post("/remote/autonomy", json={"pause": True}).status_code == 200
    assert client.post("/remote/autonomy", json={"pause": False}).status_code == 400
    assert client.post("/remote/auth/step-up", json={}).status_code == 400  # no TOTP and no passkey assertion
    token = client.post("/remote/auth/step-up", json={"totp_code": "123456"}).json()["step_up_token"]
    r = client.post("/remote/autonomy", json={"pause": False, "step_up_token": token})
    assert r.status_code == 200 and r.json()["is_paused"] is False


def test_no_hardcoded_admin_login():
    client = TestClient(app)
    assert client.post("/remote/auth/login", json={"username": "admin", "password": "admin"}).status_code == 401


def test_investigate_reports_restart_and_spa_routes():
    with TestClient(app) as seeded:  # lifespan seeds the demo incidents on an empty database
        inc_id = seeded.get("/api/v1/incidents").json()[0]["id"]
    client = TestClient(app)
    r = client.post(f"/api/v1/incidents/{inc_id}/investigate")
    assert r.status_code == 200 and r.json()["status"] == "completed"

    assert client.get("/api/v1/reports").status_code == 200
    assert client.post("/api/v1/services/svc_shoplite_api/restart").status_code == 200
    assert client.post("/api/v1/services/svc_missing/restart").status_code == 404

    assert client.get("/api/v1/definitely-missing").status_code == 404
    if os.path.exists("dashboard/static/index.html"):
        deep_link = client.get("/m/approvals/act_123")
        assert deep_link.status_code == 200 and '<div id="root"' in deep_link.text


def test_singletons_stable_with_data_dir():
    """With ALEXIA_DATA_DIR set (service installs) every get_event_bus() call used to build a new bus."""
    assert os.environ.get("ALEXIA_DATA_DIR")
    assert get_event_bus() is get_event_bus()
    assert get_event_bus().db_path.startswith(os.environ["ALEXIA_DATA_DIR"])


def test_scenario_id_aliases():
    assert normalize_scenario_id("S6_sqli_breach") == "s6"
    assert normalize_scenario_id("S3_DISK") == "s3"
    assert normalize_scenario_id("bruteforce") == "s5"
    assert normalize_scenario_id("S99_nope") == "s99_nope"


def test_replay_triage_ignores_category_list_in_prompt():
    """The instruction text lists 'oom', so every replayed triage used to come back as oom."""
    triage, _ = get_model_router().triage_event(
        event_kind="disk_high", service="shoplite-api", payload={"error": "Log volume at 96.2% capacity"}
    )
    assert triage.category == "disk_full"


def test_runbook_replay_issues_fresh_action_ids():
    memory = get_runbook_memory()
    original = Action(action="restart_container", target="shoplite-api", tier=0, status="executed")
    memory.record_runbook(
        category="crash", service="shoplite-api", error_indicator="regression-runbook-sig",
        root_cause="test", actions=[original],
    )
    actions, _ = get_model_router().plan_fix(
        category="crash", service="shoplite-api", diagnosis=Diagnosis(root_cause="test"),
        error_indicator="regression-runbook-sig",
    )
    assert actions and all(a.id != original.id and a.status == "pending" for a in actions)


def test_gateway_mode_reports_sandbox_without_real_key():
    client = TestClient(app)
    expected = "live" if get_llm_client().is_live() else "sandbox"
    assert client.get("/health").json()["gateway"]["mode"] == expected


def test_public_demo_scenario_guard(monkeypatch):
    """With a cooldown configured, proxied (public) callers get one scenario per window; the local operator is exempt."""
    monkeypatch.setenv("ALEXIA_SCENARIO_COOLDOWN_SECONDS", "60")
    import alexia.api.main as api_main

    monkeypatch.setattr(api_main, "_last_public_scenario_at", 0.0)
    client = TestClient(app)
    public = {"X-Forwarded-For": "198.51.100.7"}
    assert client.post("/api/v1/scenarios/S3_DISK/run", headers=public).status_code == 200
    second = client.post("/api/v1/scenarios/S5_BRUTE/run", headers=public)
    assert second.status_code == 429 and "Retry-After" in second.headers
    assert client.post("/api/v1/scenarios/S5_BRUTE/run").status_code == 200  # operator on the box


def test_agents_endpoint_reports_live_state():
    client = TestClient(app)
    agents = client.get("/api/v1/agents").json()
    assert {a["id"] for a in agents} == {"sentinel", "healer", "builder", "deployer", "integrity"}
    assert all(a["state"] in ("Idle", "Working", "Waiting for approval") for a in agents)


def test_mini_runner_reports_pass_and_fail(tmp_path):
    """The exe's built-in runner (no pytest bundled) must report failures honestly."""
    import subprocess
    import sys

    (tmp_path / "test_ok.py").write_text("def test_a():\n    assert 1 + 1 == 2\n")
    (tmp_path / "test_bad.py").write_text("def test_b():\n    assert 1 + 1 == 3, 'math'\n")
    run = lambda f: subprocess.run([sys.executable, "-m", "alexia.tools.mini_pytest", f], cwd=tmp_path,
                                   capture_output=True, text=True, env={**os.environ, "PYTHONPATH": os.getcwd()})
    ok, bad = run("test_ok.py"), run("test_bad.py")
    assert ok.returncode == 0 and "1 passed, 0 failed" in ok.stdout
    assert bad.returncode == 1 and "AssertionError: math" in bad.stdout


def test_seed_on_fresh_database_completes(tmp_path, monkeypatch):
    """First start of a fresh install seeds demo state; it used to crash on a missing BudgetGuard method."""
    import alexia.actions.approvals as approvals_mod
    import alexia.core.audit as audit_mod
    import alexia.core.budget as budget_mod
    import alexia.core.bus as bus_mod
    from alexia.api.demo import seed_initial_demo_state

    monkeypatch.setenv("ALEXIA_DATA_DIR", str(tmp_path))
    for mod, name in ((bus_mod, "_global_bus"), (audit_mod, "_global_audit_log"),
                      (budget_mod, "_global_budget_guard"), (approvals_mod, "_global_approval_mgr")):
        monkeypatch.setattr(mod, name, None)
    seed_initial_demo_state()  # must not raise
    assert bus_mod.get_event_bus().get_incident("inc_s6_sqli_breach") is not None
    assert budget_mod.get_budget_guard().get_daily_stats()["total_tavily_calls"] >= 1
