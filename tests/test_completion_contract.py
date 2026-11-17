"""Executable proof for Alexia's non-negotiable completion contract.

Each test maps to a row in ``docs/COMPLETION.md``.  The suite is intentionally
offline: unsafe Builder output is rejected before execution, collectors use a
fake bus, and Docker assets are validated statically so the contract can be
checked on any host.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
from pathlib import Path

import pytest
import yaml

from alexia.actions.catalog import get_action_tier
from alexia.actions.executor import get_executor
from alexia.agents.base import GuardianAgent
from alexia.agents.builder import get_builder_agent
from alexia.agents.contracts import (
    AGENT_CONTRACTS,
    AGENT_IDS,
    all_agents,
    get_agent,
    validate_agent_contracts,
)
from alexia.agents.deployer import get_deployer_agent
from alexia.agents.healer import get_healer_agent
from alexia.agents.integrity import get_integrity_agent
from alexia.agents.sentinel import get_sentinel_agent
from alexia.collectors.authlog import AuthLogCollector
from alexia.collectors.dbstats import DBStatsCollector
from alexia.collectors.git_webhook import verify_github_signature
from alexia.collectors.health import HealthCollector
from alexia.collectors.logs import LogsCollector
from alexia.collectors.supervisor import collectors_enabled
from alexia.core.audit import AuditLog, get_audit_log
from alexia.core.schemas import Action
from alexia.core.sqlite import connect as sqlite_connect, quick_check_connection
from alexia.tools.backup import restore_backup, run_backup
from alexia.tools.diffutil import apply_diff_to_dir, make_diff
from alexia.tools.sandbox import SandboxRunner
from alexia.tools.sandbox_policy import (
    safe_environment,
    validate_generated_test,
    validate_patch,
)


def _fake_stripe_key(suffix: str = "A" * 24) -> str:
    """Build a Stripe-shaped fake at runtime so secret scanners never see one."""
    return "sk" + "_" + "live" + "_" + suffix


class _FakeBus:
    """Minimal async bus used to observe collector detections without plumbing."""

    def __init__(self) -> None:
        self.events = []

    async def publish(self, event) -> None:
        self.events.append(event)


# ---------------------------------------------------------------------------
# Agents: independence, registry, and defined interfaces
# ---------------------------------------------------------------------------
def test_agents_are_independent_and_registered():
    agents = all_agents()
    assert set(agents) == set(AGENT_IDS) == {
        "builder",
        "deployer",
        "healer",
        "sentinel",
        "integrity",
    }
    assert len({id(agent) for agent in agents.values()}) == 5
    assert len({type(agent) for agent in agents.values()}) == 5
    for agent_id, agent in agents.items():
        assert isinstance(agent, GuardianAgent)
        assert agent.agent_id == agent_id
        description = agent.describe()
        assert description["id"] == agent_id
        assert description["role"]
        assert description["capabilities"]
        assert description["entrypoints"]


def test_agent_contracts_validate():
    assert validate_agent_contracts() == []
    for agent_id, contract in AGENT_CONTRACTS.items():
        agent = get_agent(agent_id)
        assert agent is get_agent(agent_id)  # lazy singleton, not a new instance per call
        # Capabilities are behavior labels; entrypoints are the callable surface.
        assert tuple(agent.capabilities) == contract.capabilities
        assert tuple(agent.entrypoints) == contract.entrypoints
        assert len(set(contract.capabilities)) == len(contract.capabilities)
        assert len(set(contract.entrypoints)) == len(contract.entrypoints)
        description = agent.describe()
        assert description["capabilities"] == list(contract.capabilities)
        assert description["entrypoints"] == list(contract.entrypoints)
        for entrypoint in contract.entrypoints:
            assert callable(getattr(agent, entrypoint, None)), f"{agent_id}.{entrypoint}"


def test_agent_contract_validator_detects_drift(monkeypatch):
    builder = get_builder_agent()
    monkeypatch.setattr(type(builder), "capabilities", ("drifted",))
    monkeypatch.setattr(type(builder), "review_diff", None)

    errors = validate_agent_contracts()
    assert any("builder: capabilities differ from registry" in error for error in errors)
    assert any("builder: missing entrypoint review_diff()" in error for error in errors)
    assert any("builder: describe() capabilities differ from registry" in error for error in errors)


# ---------------------------------------------------------------------------
# Builder: static policy, path safety, credential-free sandbox
# ---------------------------------------------------------------------------
SAFE_TEST = """
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_health():
    assert client.get("/health").status_code == 200
"""


def test_builder_rejects_unsafe_tests():
    ok, _ = validate_generated_test(SAFE_TEST)
    assert ok is True

    unsafe_sources = [
        "import os\n",
        "from subprocess import run\n",
        "import socket\n",
        "def test_x():\n    open('secret.txt')\n",
        "def test_x():\n    __import__('os')\n",
        "def test_x():\n    eval('1 + 1')\n",
        "def test_x():\n    (1).__class__.__mro__\n",
    ]
    for source in unsafe_sources:
        accepted, reason = validate_generated_test(source)
        assert accepted is False, source
        assert reason


def test_builder_rejects_unsafe_patches():
    safe_patch = make_diff(
        "app/main.py",
        "def answer():\n    return 1\n",
        "def answer():\n    return 2\n",
    )
    ok, reason = validate_patch(safe_patch)
    assert ok is True, reason

    outside_patch = make_diff("README.md", "old\n", "new\n")
    assert validate_patch(outside_patch)[0] is False

    traversal_patch = make_diff("../outside.py", "old\n", "new\n")
    assert validate_patch(traversal_patch)[0] is False

    dangerous_patch = make_diff(
        "app/main.py",
        "def answer():\n    return 1\n",
        "import subprocess\ndef answer():\n    return 1\n",
    )
    accepted, reason = validate_patch(dangerous_patch)
    assert accepted is False
    assert "subprocess" in reason.lower()


def test_builder_patch_cannot_escape_sandbox(tmp_path):
    root = tmp_path / "sandbox"
    root.mkdir()
    patch = make_diff("../outside.txt", "old\n", "new\n")
    applied, reason, _ = apply_diff_to_dir(str(root), patch)
    assert applied is False
    assert "outside" in reason.lower()
    assert not (tmp_path / "outside.txt").exists()


def test_builder_sandbox_environment_strips_secrets():
    env = safe_environment(
        {
            "PATH": "C:/Python",
            "HOME": "C:/Users/tester",
            "NEBIUS_API_KEY": "nebius-secret",
            "TAVILY_API_KEY": "tvly-secret",
            "GITHUB_TOKEN": "ghp_secret",
            "AWS_SECRET_ACCESS_KEY": "aws-secret",
            "ALEXIA_SECRET_KEY": "hmac-secret",
        }
    )
    assert env["PATH"] == "C:/Python"
    assert env["HOME"] == "C:/Users/tester"
    assert env["ALEXIA_SANDBOX"] == "1"
    for secret_name in (
        "NEBIUS_API_KEY",
        "TAVILY_API_KEY",
        "GITHUB_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
        "ALEXIA_SECRET_KEY",
    ):
        assert secret_name not in env

    runner = SandboxRunner()
    result = runner.verify_patch("import os\n", make_diff("app/main.py", "a\n", "b\n"))
    assert result["success"] is False
    assert result["policy_violation"]
    assert result["patch_applied"] is False


def test_sandbox_only_runs_its_own_interpreter():
    runner = SandboxRunner()
    with pytest.raises(ValueError):
        runner._run_command(["cmd.exe", "/c", "whoami"], cwd=".", timeout=1)
    with pytest.raises(ValueError):
        runner._run_command([], cwd=".", timeout=1)


# ---------------------------------------------------------------------------
# Deployer: rollback and auditable execution
# ---------------------------------------------------------------------------
def test_deployer_rollback_is_audited(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'shoplite.db').as_posix()}")
    executor = get_executor()
    if executor.is_autonomy_paused():
        executor.resume_autonomy("contract-test", "test")

    deployer = get_deployer_agent()
    result = deployer.rollback(
        service="shoplite-api",
        deployment_id="dep_contract_test",
        reason="completion contract rollback proof",
    )
    assert result["success"] is True, result
    assert result["action"].action == "rollback_to_last_good_image"
    assert result["action"].status == "executed"

    audit = get_audit_log()
    entries = audit.get_entries(limit=50)
    statuses = [
        entry.details.get("status")
        for entry in entries
        if entry.event_type == "deploy_pipeline_step"
        and entry.details.get("deployment_id") == "dep_contract_test"
    ]
    assert "rolled_back" in statuses
    assert any(
        entry.event_type == "action_executed"
        and entry.details.get("action") == "rollback_to_last_good_image"
        for entry in entries
    )
    valid, _, error = audit.verify_chain()
    assert valid is True, error


# ---------------------------------------------------------------------------
# Healer: authorization gates and honest verification
# ---------------------------------------------------------------------------
def test_tier1_actions_require_approval():
    executor = get_executor()
    if executor.is_autonomy_paused():
        executor.resume_autonomy("contract-test", "test")

    action = Action(
        action="rotate_secret",
        target="shoplite-api",
        tier=1,
        params={"secret_name": "STRIPE_SECRET_KEY"},
        reason="contract test",
        requested_by="agent:healer",
    )
    ok, _, data = executor.execute(action)
    assert ok is True
    assert data.get("queued") is True
    assert action.status == "pending"
    assert action.approval_token

    decided, _, _ = executor.approvals.decide(
        action.id, "rejected", decided_by="test:contract"
    )
    assert decided is True


def test_kill_switch_queues_tier0_actions():
    executor = get_executor()
    executor.resume_autonomy("contract-test", "test")
    executor.pause_autonomy("contract-test")
    try:
        action = Action(
            action="restart_container",
            target="shoplite-api",
            tier=0,
            requested_by="agent:healer",
        )
        ok, message, data = executor.execute(action)
        assert ok is True
        assert data.get("queued") is True
        assert action.status == "pending"
        assert "paused" in message.lower()

        forbidden = Action(
            action="rm -rf / --no-preserve-root",
            target="host",
            tier=2,
            requested_by="attacker",
        )
        ok_forbidden, forbidden_message, _ = executor.execute(forbidden)
        assert ok_forbidden is False
        assert "FORBIDDEN" in forbidden_message
        assert get_action_tier(forbidden.action) == 2
    finally:
        executor.resume_autonomy("contract-test", "test")
        if action.status == "pending":
            executor.approvals.decide(action.id, "rejected", decided_by="test:contract")


@pytest.mark.asyncio
async def test_production_health_probe_does_not_simulate_success(monkeypatch):
    import httpx

    def refuse(*_args, **_kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "get", refuse)
    monkeypatch.setenv("ALEXIA_ALLOW_SIMULATED_HEALTH", "1")
    monkeypatch.setenv("ALEXIA_ENV", "production")

    healthy, probe = await get_healer_agent()._verify_health("shoplite-api", max_retries=1)
    assert healthy is False
    assert probe["status"] == "unreachable"
    assert "ConnectError" in probe["error"]

    # Development may simulate, but it must say so instead of claiming a live probe.
    monkeypatch.setenv("ALEXIA_ENV", "test")
    healthy, probe = await get_healer_agent()._verify_health("shoplite-api", max_retries=1)
    assert healthy is True
    assert "simulated" in probe["mode"]


def test_log_collector_skips_history_and_waits_for_complete_lines(tmp_path):
    log_path = tmp_path / "app.log"
    log_path.write_text("old error before startup\n", encoding="utf-8")
    collector = LogsCollector(log_path=str(log_path))
    collector.bus = _FakeBus()

    # Startup must not replay (and re-alert on) historical lines.
    assert collector.read_new_lines(from_end=True) == []

    with log_path.open("a", encoding="utf-8") as handle:
        handle.write("new failure\npartial")
    assert collector.read_new_lines() == ["new failure"]

    # The partial tail is retained until its newline arrives, not dropped.
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(" line completed\n")
    assert collector.read_new_lines() == ["partial line completed"]


# ---------------------------------------------------------------------------
# Sentinel: suspicious activity and webhook integrity
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_bruteforce_and_sqli_detection():
    bus = _FakeBus()

    auth = AuthLogCollector(failure_threshold=3, window_seconds=60)
    auth.bus = bus
    event = None
    for _ in range(3):
        event = await auth.record_login_attempt("203.0.113.9", False, "admin")
    assert event is not None
    assert event.kind == "bruteforce"
    assert event.data["ip"] == "203.0.113.9"
    assert event.data["failed_count"] >= 3

    db = DBStatsCollector()
    db.bus = bus
    sqli = await db.inspect_query("' OR 1=1 --", rows_returned=5, client_ip="203.0.113.9")
    assert sqli is not None
    assert sqli.kind == "sqli_pattern"
    assert sqli.severity == "critical"

    anomaly = await db.inspect_query("select * from products", rows_returned=1000)
    assert anomaly is not None
    assert anomaly.kind == "row_read_anomaly"


def test_sentinel_secret_scan():
    sentinel = get_sentinel_agent()
    diff = (
        f"token = '{_fake_stripe_key()}'\n"
        "aws = 'AKIA" + "B" * 16 + "'\n"
        "github = 'ghp_" + "c" * 36 + "'\n"
    )
    findings = sentinel.scan_diff_for_secrets(diff)
    types = {finding["type"] for finding in findings}
    assert {"Stripe Secret Key", "AWS Access Key", "GitHub Personal Access Token"} <= types
    for finding in findings:
        assert "****" in finding["match"]
        assert finding["confirmed"] is True

    assert sentinel.scan_diff_for_secrets("def add(a, b):\n    return a + b\n") == []


@pytest.mark.asyncio
async def test_health_collector_emits_sustained_outage(monkeypatch):
    bus = _FakeBus()
    collector = HealthCollector(
        target_url="http://127.0.0.1:9",
        interval_seconds=1,
        failure_threshold=3,
    )
    collector.bus = bus

    class _FailingClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, *_args, **_kwargs):
            raise RuntimeError("connection refused")

    monkeypatch.setattr("alexia.collectors.health.httpx.AsyncClient", _FailingClient)

    assert await collector.check_once() is False
    assert await collector.check_once() is False
    assert bus.events == []
    assert await collector.check_once() is False
    assert len(bus.events) == 1
    assert bus.events[0].kind == "health_fail"
    assert bus.events[0].data["consecutive_failures"] == 3

    # A continuing outage must not create a new incident every poll.
    assert await collector.check_once() is False
    assert len(bus.events) == 1

    collector.last_probe = {"status_code": 200}
    await collector._record_recovery()
    assert bus.events[-1].kind == "health_recovered"


def test_webhook_signature_enforcement(monkeypatch):
    payload = b'{"ref":"refs/heads/main"}'
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "contract-secret")
    monkeypatch.setenv("ALEXIA_ENV", "test")
    monkeypatch.setenv("ALEXIA_ALLOW_UNSIGNED_WEBHOOKS", "1")

    valid = "sha256=" + hmac.new(b"contract-secret", payload, hashlib.sha256).hexdigest()
    assert verify_github_signature(payload, valid) is True
    assert verify_github_signature(payload, "sha256=deadbeef") is False
    assert verify_github_signature(payload, None) is True  # explicit dev opt-in

    monkeypatch.setenv("ALEXIA_ENV", "production")
    assert verify_github_signature(payload, None) is False
    assert verify_github_signature(payload, "sha256=deadbeef") is False


def test_collectors_can_be_disabled(monkeypatch):
    monkeypatch.setenv("ALEXIA_COLLECTORS", "off")
    assert collectors_enabled() is False
    monkeypatch.setenv("ALEXIA_COLLECTORS", "auto")
    monkeypatch.setenv("ALEXIA_ENV", "test")
    assert collectors_enabled() is False
    monkeypatch.setenv("ALEXIA_ENV", "production")
    assert collectors_enabled() is True


# ---------------------------------------------------------------------------
# Integrity: snapshots, restores, audit history
# ---------------------------------------------------------------------------
def _make_target_db(path: Path) -> None:
    with sqlite_connect(str(path)) as conn:
        conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
        conn.execute("INSERT INTO items (name) VALUES ('original')")
        conn.commit()


def _target_value(path: Path) -> str:
    conn = sqlite3.connect(path)
    try:
        return conn.execute("SELECT name FROM items WHERE id = 1").fetchone()[0]
    finally:
        conn.close()


def test_snapshot_restore_and_tamper_detection(tmp_path, monkeypatch):
    import alexia.tools.snapshots as snapshots

    db_path = tmp_path / "shoplite.db"
    _make_target_db(db_path)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_path.as_posix()}")
    monkeypatch.setattr(snapshots, "SNAPSHOT_DIR", str(tmp_path / "snapshots"))

    metadata = snapshots.create_snapshot("shoplite-api", "completion contract")
    assert Path(metadata["path"]).exists()
    assert snapshots.verify_snapshot(metadata["id"])["ok"] is True

    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE items SET name = 'modified' WHERE id = 1")
    conn.commit()
    conn.close()

    restored = snapshots.restore_snapshot(metadata["id"])
    assert restored["success"] is True
    assert _target_value(db_path) == "original"

    with open(metadata["path"], "ab") as handle:
        handle.write(b"tampered")
    verified = snapshots.verify_snapshot(metadata["id"])
    assert verified["ok"] is False
    with pytest.raises(ValueError):
        snapshots.restore_snapshot(metadata["id"])


def test_audit_chain_detects_tampering(tmp_path):
    audit = AuditLog(db_path=str(tmp_path / "audit.db"))
    for index in range(3):
        audit.record("contract_event", "test:contract", {"index": index, "ok": True})

    valid, count, error = audit.verify_chain()
    assert valid is True
    assert count == 3
    assert error is None

    conn = sqlite3.connect(tmp_path / "audit.db")
    conn.execute(
        "UPDATE audit_log SET details_json = ? WHERE id = 2",
        (json.dumps({"tampered": True}, sort_keys=True, separators=(",", ":")),),
    )
    conn.commit()
    conn.close()

    valid, _, error = audit.verify_chain()
    assert valid is False
    assert "Tampered row data at row 2" in error


def test_integrity_agent_reports_audit_state():
    state = get_integrity_agent().verify_audit_history()
    assert "valid" in state
    assert state["verified_rows"] >= 0
    assert "checked_at" in state


# ---------------------------------------------------------------------------
# SQLite durability and backup/restore
# ---------------------------------------------------------------------------
def test_sqlite_survives_restart_with_wal(tmp_path):
    path = tmp_path / "state.db"
    with sqlite_connect(str(path)) as conn:
        journal = conn.execute("PRAGMA journal_mode").fetchone()[0]
        synchronous = conn.execute("PRAGMA synchronous").fetchone()[0]
        conn.execute("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute("INSERT INTO state VALUES ('incident', 'resolved')")
        conn.commit()
    assert str(journal).lower() == "wal"
    assert synchronous == 2  # FULL

    reopened = sqlite_connect(str(path))
    try:
        ok, detail = quick_check_connection(reopened)
        assert ok is True, detail
        assert reopened.execute("SELECT value FROM state WHERE key = 'incident'").fetchone()[0] == "resolved"
    finally:
        reopened.close()

    # A context-managed connection is closed, not merely committed.
    closed = sqlite_connect(str(path))
    with closed:
        closed.execute("INSERT INTO state VALUES ('after', 'restart')")
    with pytest.raises(sqlite3.ProgrammingError):
        closed.execute("SELECT 1")


def test_backup_and_restore_round_trip(tmp_path, monkeypatch):
    db_path = tmp_path / "alexia.db"
    with sqlite_connect(str(db_path)) as conn:
        conn.execute("CREATE TABLE marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute("INSERT INTO marker (value) VALUES ('before-backup')")
        conn.commit()

    monkeypatch.setenv("ALEXIA_DB", str(db_path))
    monkeypatch.setenv("ALEXIA_BACKUP_DIR", str(tmp_path / "backups"))

    result = run_backup()
    assert Path(result["path"]).exists()
    assert result["bytes"] > 0

    with sqlite_connect(str(db_path)) as conn:
        conn.execute("UPDATE marker SET value = 'after-backup' WHERE id = 1")
        conn.commit()

    restored = restore_backup()
    assert restored["success"] is True
    with sqlite_connect(str(db_path)) as conn:
        assert conn.execute("SELECT value FROM marker WHERE id = 1").fetchone()[0] == "before-backup"


# ---------------------------------------------------------------------------
# Docker assets and documentation
# ---------------------------------------------------------------------------
def test_docker_assets_are_production_ready():
    root = Path(__file__).resolve().parents[1]
    compose = yaml.safe_load((root / "docker-compose.yml").read_text(encoding="utf-8"))
    services = compose["services"]

    assert {"alexia", "shoplite-api"} <= set(services)
    assert "shoplite-db" not in services  # ShopLite uses SQLite, not Postgres
    assert services["alexia"]["init"] is True
    assert services["alexia"]["healthcheck"]["test"]
    assert services["shoplite-api"]["healthcheck"]["test"]
    assert services["alexia"]["depends_on"]["shoplite-api"]["condition"] == "service_healthy"

    raw_env = services["alexia"]["environment"]
    env = {item.split("=", 1)[0]: item.split("=", 1)[1] for item in raw_env}
    assert env["ALEXIA_ENV"] == "production"
    assert env["ALEXIA_DATA_DIR"] == "/app/data"
    assert env["ALEXIA_COLLECTORS"] == "on"
    assert env["ALEXIA_ALLOW_SIMULATED_HEALTH"] == "0"
    assert env["ALEXIA_ALLOW_UNSIGNED_WEBHOOKS"] == "0"

    dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
    assert "FROM node:22-alpine AS frontend-builder" in dockerfile
    assert "FROM python:3.11-slim" in dockerfile
    assert "HEALTHCHECK" in dockerfile
    assert "STOPSIGNAL SIGTERM" in dockerfile
    assert "uvicorn" in dockerfile

    ignored = {line.strip() for line in (root / ".dockerignore").read_text(encoding="utf-8").splitlines()}
    assert ".env" in ignored
    assert "data" in ignored
    assert "node_modules" in ignored


def test_documentation_covers_architecture_and_install():
    root = Path(__file__).resolve().parents[1]
    readme = (root / "README.md").read_text(encoding="utf-8")
    architecture = (root / "docs" / "architecture.md").read_text(encoding="utf-8")
    completion = (root / "docs" / "COMPLETION.md").read_text(encoding="utf-8")

    assert "Install Backend & Frontend Dependencies" in readme
    assert "docker compose up --build" in readme
    assert "python -m pytest tests/ target-app/tests/" in readme
    assert "Agent Interface Contract" in architecture
    assert "Durable SQLite State" in architecture
    assert "Docker Deployment Topology" in architecture
    assert "Requirement" in completion
    assert "SQLite state survives restarts" in completion
    assert "Docker deployment works reliably" in completion
