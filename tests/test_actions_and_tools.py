"""Unit tests for Action Catalog, Executor, Approvals, and Tools."""

import os
import time
import pytest
from alexia.actions.approvals import ApprovalManager
from alexia.actions.catalog import get_action_tier, validate_action_params
from alexia.actions.executor import ActionExecutor
from alexia.core.schemas import Action
from alexia.tools.github import open_github_pr
from alexia.tools.reports import generate_cert_in_report, generate_dpdp_report, generate_gdpr_report
from alexia.tools.sandbox import SandboxRunner
from alexia.tools.snapshots import create_snapshot, restore_snapshot
from alexia.tools.tavily import TavilySearchClient

TEST_DB_PATH = "data/test_actions.db"


@pytest.fixture(autouse=True)
def clean_test_db():
    if os.path.exists(TEST_DB_PATH):
        try:
            os.remove(TEST_DB_PATH)
        except Exception:
            pass
    yield
    if os.path.exists(TEST_DB_PATH):
        try:
            os.remove(TEST_DB_PATH)
        except Exception:
            pass


def test_action_catalog_tiers():
    assert get_action_tier("restart_container") == 0
    assert get_action_tier("rollback_to_last_good_image") == 0
    assert get_action_tier("block_ip_temporarily") == 0
    assert get_action_tier("take_snapshot") == 0

    assert get_action_tier("restore_snapshot") == 1
    assert get_action_tier("rotate_secret") == 1
    assert get_action_tier("isolate_container_network") == 1

    # Tier 2 - Forbidden
    assert get_action_tier("drop_database") == 2
    assert get_action_tier("rm_rf_root") == 2
    assert get_action_tier("arbitrary_bash_cmd") == 2


def test_executor_tier_enforcement():
    executor = ActionExecutor(db_path=TEST_DB_PATH)

    # 1. Tier 0 auto execution
    act0 = Action(action="restart_container", target="shoplite-api", tier=0)
    success, msg, res = executor.execute(act0)
    assert success is True
    assert act0.status == "executed"

    # 2. Tier 2 strictly forbidden
    act2 = Action(action="delete_all_volumes", target="shoplite-api", tier=2)
    success, msg, res = executor.execute(act2)
    assert success is False
    assert act2.status == "rejected"
    assert "FORBIDDEN" in msg

    # 3. Tier 1 requires approval
    act1 = Action(
        action="restore_snapshot",
        target="shoplite-api",
        params={"snapshot_id": "snap_123"},
        tier=1,
    )
    success, msg, res = executor.execute(act1)
    assert success is True
    assert res.get("queued") is True
    assert act1.status == "pending"
    assert act1.approval_token is not None


def test_executor_kill_switch():
    executor = ActionExecutor(db_path=TEST_DB_PATH)
    assert executor.is_autonomy_paused() is False

    # Pause autonomy
    executor.pause_autonomy(paused_by="user:phone")
    assert executor.is_autonomy_paused() is True

    # Tier 0 action must be queued instead of executed automatically
    act = Action(action="restart_container", target="shoplite-api", tier=0)
    success, msg, res = executor.execute(act)
    assert success is True
    assert res.get("queued") is True
    assert act.status == "pending"

    # Resume autonomy
    executor.resume_autonomy(resumed_by="user:phone", step_up_method="passkey")
    assert executor.is_autonomy_paused() is False


def test_approvals_lifecycle_and_single_use():
    mgr = ApprovalManager(db_path=TEST_DB_PATH)
    action = Action(
        action="rotate_secret",
        target="shoplite-api",
        params={"secret_name": "STRIPE_SECRET_KEY"},
        tier=1,
        reason="Secret leaked in commit",
    )
    token = mgr.create_pending_approval(action)
    assert token is not None

    # Decide approve
    ok, msg, data = mgr.decide(
        action_id=action.id,
        decision="approved",
        decided_by="user:sammy",
        step_up_method="biometric",
    )
    assert ok is True
    assert data["status"] == "approved"

    # Replay attempt must fail (single-use token / already decided)
    ok_replay, msg_replay, _ = mgr.decide(
        action_id=action.id,
        decision="approved",
        decided_by="user:attacker",
    )
    assert ok_replay is False
    assert "already" in msg_replay.lower()


def test_tavily_search_tool():
    tavily = TavilySearchClient(db_path=TEST_DB_PATH)
    results = tavily.search("SQL injection python sqlite parameterized queries")
    assert len(results) > 0
    assert any("sql" in r.title.lower() or "owasp" in r.title.lower() for r in results)


def test_sandbox_red_to_green_cycle():
    sandbox = SandboxRunner()
    result = sandbox.verify_patch(
        failing_test_code="def test_vulnerability():\n    assert False\n",
        patch_diff="--- a/test.py\n+++ b/test.py\n",
    )
    assert result["failed_before"] is True
    assert result["passed_after"] is True
    assert result["success"] is True


def test_snapshot_create_and_restore():
    snap = create_snapshot(target="shoplite-api", description="Test snapshot")
    assert snap["id"].startswith("snap_")
    assert len(snap["sha256"]) == 64
    assert os.path.exists(snap["path"])

    restore_res = restore_snapshot(snap["id"])
    assert restore_res["success"] is True
    assert restore_res["snapshot_id"] == snap["id"]


def test_breach_report_drafting():
    cert_in = generate_cert_in_report(
        incident_id="inc_sec_01",
        incident_type="SQL Injection Vulnerability",
        systems_affected=["shoplite-api", "shoplite-db"],
        indicators={"attacker_ips": ["192.168.1.100"], "payloads": ["' OR 1=1 --"]},
        actions_taken=["Blocked IP 192.168.1.100", "Deployed parameterization fix"],
    )
    assert "CERT-In" in cert_in
    assert "6-Hour" in cert_in
    assert "DRAFT" in cert_in

    dpdp = generate_dpdp_report(
        incident_id="inc_sec_01",
        nature_of_breach="SQL injection query parameter abuse",
        exposed_records_count=250,
        exposed_fields=["email", "phone"],
        mitigation_steps=["Parameter-bound query patch applied", "IP temporary block"],
    )
    assert "Digital Personal Data Protection" in dpdp
    assert "250 records" in dpdp

    gdpr = generate_gdpr_report(
        incident_id="inc_sec_01",
        root_cause="SQL injection in search endpoint",
        records_count=250,
        consequences="Potential exposure of customer emails and phones.",
        remedial_measures=["IP containment", "Parameterized queries"],
    )
    assert "Article 33" in gdpr
    assert "Supervisory Authority" in gdpr
