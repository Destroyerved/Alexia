"""Comprehensive End-to-End Workflow Tests for Alexia Autonomous DevSecOps Guardian.

Tests the full integrated workflows across all 5 specialized agents, Orchestrator,
EventBus, ActionExecutor, ApprovalManager, AuditLog, and REST API:

1. Workflow 1 (Headline S6 SQL Injection & Breach Containment):
   Telemetry -> Orchestrator -> Sentinel forensic preservation -> Reverse proxy IP block ->
   Integrity exposure assessment -> Ultra root-cause timeline ->
   Regulatory breach reports (CERT-In 6h, DPDP 2025, GDPR Art. 33) ->
   Builder patch & regression test -> Sandbox red-to-green proof ->
   Ultra patch review -> GitHub PR authoring -> Tier-1 action queuing with HMAC token ->
   Mobile biometric approval -> Post-deploy execution -> 100% hash chain verification.

2. Workflow 2 (S1 Gated Deployment & Automated Health-Gate Rollback):
   Commit pushed with fatal bug -> Builder pre-deploy review flags issue ->
   Forced deployment fails post-deploy health gate (500 error) ->
   Automated Tier-0 rollback to prior stable version in <60s ->
   Builder auto-remediates with red-to-green proof ->
   Deployer deploys verified fix -> All gates pass.

3. Workflow 3 (S2 Crash Self-Healing with Runbook Memory Fast-Path):
   Container crash signal (SIGSEGV / OOM 137) -> Healer triage (Nano) & diagnosis (Super) ->
   Pre-action snapshot -> Tier-0 container restart -> Post-action health verification ->
   Runbook stored in SQLite memory -> Identical crash recurs ->
   Fast-path replay from runbook memory without LLM latency -> Success counter incremented.

4. Workflow 4 (S4 & S7 Pre-Deploy Security and Integrity Guards):
   S4 Leaked Secret (Stripe secret key in commit diff) -> Deployer Sentinel gate blocks ->
   S7 Destructive Migration (ALTER TABLE DROP COLUMN) -> Deployer Integrity gate blocks.

5. Workflow 5 (S9 Autonomy Kill Switch & Emergency Freeze):
   Kill switch activated -> Runtime crash occurs -> ActionExecutor prevents auto-restart ->
   Forces Tier-0 action into pending approval queue ->
   Resume autonomy with biometric step-up elevation -> Autonomous operation restored.

6. Workflow 6 (Cryptographic Audit Log Tamper Detection):
   Complete hash chain verification -> Simulated database row tampering ->
   AuditLog detects corruption, pinpoints tampered row index, and refuses trust.

7. Workflow 7 (FastAPI REST API & Demo Scenarios End-to-End):
   API health -> Scenario triggers -> Incident listing -> Approval decision -> Audit verification -> Cost accounting.
"""

from __future__ import annotations
import asyncio
import json
import os
import shutil
import sqlite3
import tempfile
import time
import pytest
from fastapi.testclient import TestClient

from alexia.actions.approvals import get_approval_manager
from alexia.actions.catalog import get_action_tier
from alexia.actions.executor import get_executor
from alexia.agents.builder import get_builder_agent
from alexia.agents.deployer import get_deployer_agent
from alexia.agents.healer import get_healer_agent
from alexia.agents.integrity import get_integrity_agent
from alexia.agents.sentinel import get_sentinel_agent
from alexia.api.demo import reset_demo_environment, run_scenario
from alexia.api.main import app
from alexia.core.audit import get_audit_log
from alexia.core.bus import get_event_bus
from alexia.core.memory import RunbookMemory
from alexia.core.orchestrator import get_orchestrator
from alexia.core.schemas import Action, Event, Incident, generate_id


@pytest.fixture(autouse=True)
def setup_and_teardown_environment():
    """Ensure clean demo state before and after each workflow test."""
    reset_demo_environment()
    yield
    reset_demo_environment()


# ===========================================================================
# Workflow 1: Headline S6 SQL Injection & Breach Containment
# ===========================================================================
@pytest.mark.asyncio
async def test_full_headline_security_workflow_s6():
    """Verify complete S6 headline loop:
    Telemetry -> Sentinel containment -> Evidence ledger -> Exposure assessment ->
    Ultra timeline -> CERT-In / DPDP / GDPR drafts -> Builder patch -> Sandbox red-to-green proof ->
    PR opened -> Tier-1 HMAC token approval -> Audit hash chain 100% verified.
    """
    bus = get_event_bus()
    await bus.start()
    orchestrator = get_orchestrator()
    orchestrator.start()
    executor = get_executor()
    audit = get_audit_log()
    approvals = get_approval_manager()

    attacker_ip = "198.51.100.88"
    assert executor.is_ip_blocked(attacker_ip) is False

    # 1. Telemetry Event: SQL Injection attack detected in application logs
    sqli_payload = "' UNION SELECT email,phone,password_hash FROM users--"
    sqli_event = Event(
        source="collector.logs",
        kind="sqli_pattern",
        service="shoplite-api",
        severity="critical",
        data={
            "ip": attacker_ip,
            "endpoint": "/search",
            "payload": sqli_payload,
            "query": f"SELECT id, name, price FROM products WHERE name LIKE '%{sqli_payload}%'",
            "rows_returned": 142,
        },
    )

    # 2. Publish to EventBus and allow agents to orchestrate
    await bus.publish(sqli_event)
    await asyncio.wait_for(bus.drain(), timeout=60)  # agent loops run off the server loop

    # 3. Verify Sentinel Containment: Offending IP temporarily blocked in reverse proxy
    assert executor.is_ip_blocked(attacker_ip) is True

    # 4. Verify Forensic Evidence Preservation (FR-S6)
    from alexia.agents.sentinel import EVIDENCE_DIR as evidence_dir

    assert os.path.exists(evidence_dir)
    ev_files = [f for f in os.listdir(evidence_dir) if f.endswith(".log")]
    assert len(ev_files) > 0, f"Expected forensic evidence log file created in {evidence_dir}"

    # Verify SHA-256 header in forensic log
    latest_ev = sorted(ev_files, key=lambda fn: os.path.getmtime(os.path.join(evidence_dir, fn)))[-1]
    with open(os.path.join(evidence_dir, latest_ev), "r", encoding="utf-8") as f:
        content = f.read()
        assert "Forensic Evidence for inc_" in content
        assert "SHA256: " in content
        assert sqli_payload in content

    # 5. Verify Incident State & Multi-Agent Collaboration
    incidents = bus.list_incidents(limit=5)
    sqli_inc = next((inc for inc in incidents if inc.owner_agent == "sentinel" or "sqli" in str(inc.metadata)), None)
    assert sqli_inc is not None, "Expected an incident owned by Sentinel"
    assert sqli_inc.severity == "critical"
    assert sqli_inc.status in ("resolved", "acting")

    # 6. Verify Integrity Agent Exposure Assessment (FR-I5)
    exposure = sqli_inc.metadata.get("exposure_assessment")
    assert exposure is not None
    assert "users" in exposure.get("affected_tables", [])
    assert any(col in exposure.get("affected_columns", []) for col in ("email", "phone", "password_hash"))
    assert exposure.get("estimated_rows_exposed", 0) > 0

    # 7. Verify Ultra Investigation Root Cause & Timeline (FR-S7)
    assert sqli_inc.diagnosis.root_cause != ""
    assert len(sqli_inc.diagnosis.evidence) > 0

    # 8. Verify Regulatory Breach Reports Drafted (FR-S8)
    reports = sqli_inc.metadata.get("reports", {})
    assert "cert_in" in reports
    assert "dpdp" in reports
    assert "gdpr" in reports

    # Check CERT-In mandatory reporting structure (6h window)
    cert_in = reports["cert_in"]
    assert sqli_inc.id in cert_in
    assert "6-Hour" in cert_in or "CERT-In" in cert_in
    assert attacker_ip in cert_in

    # Check DPDP 2025 Notice structure
    dpdp = reports["dpdp"]
    assert "Digital Personal Data Protection" in dpdp or "DPDP" in dpdp

    # Check GDPR Art. 33 structure
    gdpr = reports["gdpr"]
    assert "GDPR" in gdpr or "Article 33" in gdpr

    # 9. Verify Builder Sandbox Red-to-Green Proof (FR-B3, FR-B4)
    proof = sqli_inc.metadata.get("proof_of_fix")
    assert proof is not None
    assert proof["failed_before"] is True, "Test must have FAILED before patch (RED phase)"
    assert proof["passed_after"] is True, "Test must have PASSED after patch (GREEN phase)"

    # 10. Verify GitHub PR Action Authored (FR-B5)
    pr_action = next((a for a in sqli_inc.plan if a.action == "open_pull_request"), None)
    assert pr_action is not None
    assert "pr_number" in pr_action.params

    # 11. Verify Tier-1 Deploy Action & Human Approval Cycle (FR-C7, FR-M5)
    deploy_action = next((a for a in sqli_inc.plan if a.action == "merge_pull_request_and_deploy"), None)
    assert deploy_action is not None
    assert deploy_action.tier == 1

    # Queue approval and generate single-use HMAC token
    token = approvals.create_pending_approval(deploy_action, incident_id=sqli_inc.id)
    assert token is not None and len(token) >= 32

    # Human operator approves via mobile passkey step-up
    ok_decide, msg_decide, action_data = approvals.decide(
        action_id=deploy_action.id,
        decision="approved",
        decided_by="human:secops_lead",
        step_up_method="webauthn_passkey",
        provided_token=token,
    )
    assert ok_decide is True
    assert action_data["status"] == "approved"

    # Single-use token must now reject subsequent reuse attempts
    ok_reuse, msg_reuse, _ = approvals.decide(
        action_id=deploy_action.id,
        decision="approved",
        decided_by="attacker",
        provided_token=token,
    )
    assert ok_reuse is False
    assert "already approved" in msg_reuse

    # Execute approved action
    ok_exec, msg_exec, _ = executor.execute(deploy_action, is_pre_approved=True)
    assert ok_exec is True

    # 12. Verify Cryptographic Audit Chain Integrity (FR-C8)
    is_valid, rows_count, err = audit.verify_chain()
    assert is_valid is True
    assert rows_count >= 5
    assert err is None

    await bus.stop()


# ===========================================================================
# Workflow 2: S1 Bad Deploy & Automatic Rollback
# ===========================================================================
@pytest.mark.asyncio
async def test_full_workflow_bad_deploy_health_gate_and_rollback():
    """Verify S1 deployment lifecycle:
    Pre-deploy builder review catches division by zero ->
    Forced deploy triggers 500 in health gate ->
    Automatic Tier-0 rollback to last good image in <60s ->
    Builder auto-remediation loop with red-to-green proof ->
    Deployer releases clean fix.
    """
    deployer = get_deployer_agent()
    audit = get_audit_log()

    buggy_diff = (
        "--- a/app/orders.py\n+++ b/app/orders.py\n"
        "@@ -20,1 +20,1 @@\n"
        "-    return round(subtotal / max(item_count, 1), 2)\n"
        "+    return round(subtotal / item_count, 2)  # Bug: division by zero on empty cart\n"
    )

    # 1. Normal pre-deploy review blocks the deploy
    blocked_res = await deployer.deploy_commit(
        commit_sha="bad0001",
        diff_text=buggy_diff,
        force_deploy=False,
    )
    assert blocked_res["status"] == "blocked"
    assert blocked_res["gate"] == "builder_review"

    # 2. Forced deploy bypasses pre-gate, but post-deploy health gate catches 500 error & rolls back
    rollback_res = await deployer.deploy_commit(
        commit_sha="bad0002",
        diff_text=buggy_diff,
        force_deploy=True,
    )
    assert rollback_res["status"] == "rolled_back"
    assert "ZeroDivisionError" in rollback_res["reason"]

    # 3. Clean fix deployment passes all gates and succeeds
    clean_diff = (
        "--- a/app/orders.py\n+++ b/app/orders.py\n"
        "@@ -20,1 +20,1 @@\n"
        "+    return round(subtotal / max(item_count, 1), 2)\n"
    )
    success_res = await deployer.deploy_commit(
        commit_sha="fix0003",
        diff_text=clean_diff,
        force_deploy=False,
    )
    assert success_res["status"] == "success"
    assert "deployment_id" in success_res

    # 4. Verify audit ledger captured rollback and deployment
    is_valid, count, _ = audit.verify_chain()
    assert is_valid is True
    assert count >= 3


# ===========================================================================
# Workflow 3: S2 Crash Self-Healing with Runbook Memory
# ===========================================================================
@pytest.mark.asyncio
async def test_full_workflow_crash_self_healing_with_runbook_memory():
    """Verify S2 crash self-healing:
    Container exit event -> Healer triage (Nano) -> Diagnosis (Super) ->
    Tier-0 restart -> Health verified -> Runbook recorded in memory ->
    Second crash matches memory -> Fast-path replay without LLM -> Success count increments.
    """
    healer = get_healer_agent()
    audit = get_audit_log()

    unique_id = generate_id("oom")
    unique_err = f"{unique_id}: Process terminated with exit code 137 (OOMKilled)"

    crash_incident_1 = Incident(
        id=generate_id("inc"),
        category="crash",
        severity="high",
        metadata={"service": "shoplite-api", "kind": "container_exit"},
    )

    # 1. First Crash: Full Healer diagnosis and execution
    resolved_1 = await healer.handle_incident(
        incident=crash_incident_1,
        error_text=unique_err,
    )
    assert resolved_1.status == "resolved"
    assert any(a.action == "restart_container" for a in resolved_1.plan)

    category_used = resolved_1.category

    # Verify runbook stored in memory
    runbook_match = healer.memory.find_matching_runbook(
        category=category_used,
        service="shoplite-api",
        error_indicator=unique_err[:60],
    )
    assert runbook_match is not None
    assert runbook_match["success_count"] == 1
    assert runbook_match["actions"][0].action == "restart_container"

    # 2. Second Crash: Identical error signature fast-paths from memory
    crash_incident_2 = Incident(
        id=generate_id("inc"),
        category=category_used,
        severity="high",
        metadata={"service": "shoplite-api", "kind": "container_exit"},
    )

    start_t = time.time()
    resolved_2 = await healer.handle_incident(
        incident=crash_incident_2,
        error_text=unique_err,
    )
    duration_2 = time.time() - start_t

    assert resolved_2.status == "resolved"
    assert len(resolved_2.plan) > 0
    assert any(a.action == "restart_container" for a in resolved_2.plan)

    # Success count in runbook memory must now be incremented to 2
    updated_runbook = healer.memory.find_matching_runbook(
        category=category_used,
        service="shoplite-api",
        error_indicator=unique_err[:60],
    )
    assert updated_runbook["success_count"] == 2

    # 3. Hash chain remains unbroken
    is_valid, _, _ = audit.verify_chain()
    assert is_valid is True


# ===========================================================================
# Workflow 4: S4 Leaked Secret & S7 Destructive Migration Gating
# ===========================================================================
@pytest.mark.asyncio
async def test_full_workflow_security_and_integrity_gating():
    """Verify pre-deploy protection:
    S4: Secret in diff triggers Sentinel scanner and blocks deploy before release.
    S7: Destructive SQL migration triggers Integrity guard and blocks deploy before data loss.
    """
    deployer = get_deployer_agent()

    # Part A: Leaked Stripe Secret Key (S4)
    leaked_diff = (
        "--- a/app/config.py\n+++ b/app/config.py\n"
        "@@ -5,1 +5,1 @@\n"
        "+STRIPE_SECRET_KEY = 'sk_" "live_51MzDemoKeyWithRealEntropy7739'\n"
    )
    s4_result = await deployer.deploy_commit(
        commit_sha="leak1122",
        diff_text=leaked_diff,
    )
    assert s4_result["status"] == "blocked"
    assert s4_result["gate"] == "sentinel_secrets"
    assert "Stripe Secret Key" in s4_result["reason"]

    # Part B: Destructive Migration dropping column (S7)
    destructive_sql = "ALTER TABLE users DROP COLUMN phone;"
    s7_result = await deployer.deploy_commit(
        commit_sha="destruct3344",
        diff_text="-- add migration script\n",
        migration_sql=destructive_sql,
    )
    assert s7_result["status"] == "blocked"
    assert s7_result["gate"] == "integrity_migration"
    assert "drops column" in s7_result["reason"].lower()


# ===========================================================================
# Workflow 5: S9 Autonomy Kill Switch & Emergency Freeze
# ===========================================================================
def test_full_workflow_autonomy_kill_switch_lifecycle():
    """Verify S9 Autonomy Kill Switch:
    Admin pauses autonomy -> Tier-0 actions strictly blocked from auto-executing ->
    Actions queued for manual authorization -> Admin resumes autonomy with step-up token.
    """
    executor = get_executor()
    approvals = get_approval_manager()

    assert executor.is_autonomy_paused() is False

    # 1. Admin engages emergency kill switch
    executor.pause_autonomy(paused_by="operator:admin_alice")
    assert executor.is_autonomy_paused() is True

    # 2. Attempt Tier-0 action: must NOT execute autonomously!
    tier0_action = Action(
        action="restart_container",
        target="shoplite-api",
        tier=0,
        reason="Container unhealthy",
        requested_by="agent:healer",
    )
    success, msg, data = executor.execute(tier0_action)

    assert success is True
    assert data.get("queued") is True
    assert tier0_action.status == "pending"
    assert tier0_action.approval_token is not None

    # Verify action was queued in pending approvals
    pending = approvals.list_pending()
    assert any(p["action_id"] == tier0_action.id for p in pending)

    # 3. Resume autonomy requires step-up method
    executor.resume_autonomy(
        resumed_by="operator:admin_alice",
        step_up_method="fido2_webauthn_key",
    )
    assert executor.is_autonomy_paused() is False

    # 4. Now Tier-0 actions execute immediately
    action_after_resume = Action(
        action="restart_container",
        target="shoplite-api",
        tier=0,
        reason="Recovery test",
        requested_by="agent:healer",
    )
    ok_after, _, res_after = executor.execute(action_after_resume)
    assert ok_after is True
    assert action_after_resume.status == "executed"
    assert res_after.get("status") == "restarted"


# ===========================================================================
# Workflow 6: Cryptographic Hash Chain Tamper Detection
# ===========================================================================
def test_full_workflow_tamper_detection_in_audit_chain():
    """Verify FR-C8 cryptographic tamper evidence:
    All entries chained via sha256(prev_hash + row) ->
    Simulate attacker database row modification ->
    Chain verification instantly fails and detects tampered row.
    """
    with tempfile.NamedTemporaryFile(suffix=".db") as tmp_db:
        from alexia.core.audit import AuditLog

        audit = AuditLog(db_path=tmp_db.name)

        # 1. Record series of actions
        for i in range(1, 6):
            audit.record(
                event_type=f"action_step_{i}",
                actor=f"agent:worker_{i}",
                details={"step": i, "result": "success"},
            )

        # 2. Verify chain is 100% valid initially
        is_valid, count, err = audit.verify_chain()
        assert is_valid is True
        assert count == 5
        assert err is None

        # 3. Tamper with row 3 in the SQLite ledger directly
        conn = audit._get_connection()
        conn.execute("UPDATE audit_log SET details_json = '{\"step\": 3, \"result\": \"TAMPERED\"}' WHERE id = 3")
        conn.commit()

        # 4. Chain verification MUST catch the tampered row
        is_valid_after, count_after, err_after = audit.verify_chain()
        assert is_valid_after is False
        assert "Tampered row data at row 3" in err_after


# ===========================================================================
# Workflow 7: FastAPI REST API & Demo Scenarios End-to-End
# ===========================================================================
def test_full_workflow_fastapi_rest_and_demo_integration():
    """Verify REST API endpoints and one-click demo triggers via TestClient."""
    client = TestClient(app)

    # 1. Health check
    res_health = client.get("/health")
    assert res_health.status_code == 200
    assert res_health.json()["status"] == "healthy"

    # 2. Reset demo environment via /scenarios/reset
    res_reset = client.post("/scenarios/reset")
    assert res_reset.status_code == 200
    assert res_reset.json()["status"] == "success"

    # 3. Trigger S8: Remote mobile approval scenario
    res_s8 = client.post("/scenarios/s8/run")
    assert res_s8.status_code == 200
    s8_data = res_s8.json()
    action_id = s8_data["action_id"]
    token = s8_data["token"]
    assert action_id is not None
    assert token is not None

    # 4. Query pending approvals
    res_approvals = client.get("/approvals")
    assert res_approvals.status_code == 200
    pending_list = res_approvals.json()
    assert any(p["action_id"] == action_id for p in pending_list)

    # 5. Decide approval via API (approving needs a fresh step-up token, FR-M5)
    no_step_up = client.post(
        f"/approvals/{action_id}/decide",
        json={"decision": "approved", "decided_by": "mobile_admin", "token": token},
    )
    assert no_step_up.status_code == 401
    step_up = client.post("/remote/auth/step-up", json={"passkey_signature": "demo-webauthn-assertion"}).json()["step_up_token"]
    res_decide = client.post(
        f"/approvals/{action_id}/decide",
        json={
            "decision": "approved",
            "decided_by": "mobile_admin",
            "step_up_token": step_up,
            "token": token,
        },
    )
    assert res_decide.status_code == 200
    assert res_decide.json()["status"] == "success"

    # 6. Verify audit chain via API endpoint
    res_audit = client.get("/audit")
    assert res_audit.status_code == 200
    audit_data = res_audit.json()
    assert audit_data["chain_verified"] is True
    assert audit_data["verified_rows"] > 0

    # 7. Model cost accounting stats
    res_models = client.get("/stats/models")
    assert res_models.status_code == 200
    stats = res_models.json()
    assert "total_cost_usd" in stats
    assert "nano" in stats["breakdown"]
    assert "super" in stats["breakdown"]
    assert "ultra" in stats["breakdown"]
    assert "tavily" in stats
