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
    client = TestClient(app)
    inc_id = client.get("/api/v1/incidents").json()[0]["id"]
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
