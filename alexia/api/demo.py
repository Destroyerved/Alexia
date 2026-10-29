"""Demo scenario launcher executing PRD Section 10 test scenarios.

Implements FR-U6, NFR5:
- One-click triggers for all 9 demo scenarios (S1 to S9) and environment reset.
- Coordinates collectors, agents, and bus events to reproduce real-world incidents.
"""

from __future__ import annotations
import asyncio
import logging
from typing import Any, Dict, List

from alexia.actions.approvals import get_approval_manager
from alexia.actions.executor import get_executor
from alexia.core.audit import get_audit_log
from alexia.core.budget import get_budget_guard
from alexia.core.bus import get_event_bus
from alexia.core.orchestrator import get_orchestrator
from alexia.core.schemas import (
    Action,
    Diagnosis,
    DiagnosticSource,
    Event,
    Incident,
    Notification,
    generate_id,
)

logger = logging.getLogger("alexia.api.demo")


SCENARIO_CATALOG: List[Dict[str, Any]] = [
    {
        "id": "S6",
        "code": "S6",
        "title": "SQL Injection & Data Exposure",
        "subtitle": "Headline Security & Self-Healing Loop",
        "category": "security",
        "severity": "critical",
        "featured": True,
        "trigger_description": "Attacker sends crafted UNION SELECT payload against /products?q= endpoint on shoplite-api",
        "agents_involved": ["Sentinel", "Integrity", "Builder", "Deployer"],
        "models_used": ["nano", "super", "ultra"],
        "expected_actions": [
            "Sentinel detects SQLi pattern & anomalous row read spike (1,240 rows)",
            "Tier 0: Block offending IP 198.51.100.42 at Caddy reverse proxy",
            "Tier 0: Snapshot container & database state (SHA-256 verified)",
            "Integrity Agent assesses exposed PII columns (users.email, users.phone)",
            "Builder Agent generates parameterized SQL patch & runs red-to-green pytest in sandbox",
            "Tier 1: Request human approval to merge PR #142 and deploy patched image",
            "Draft CERT-In (6h deadline), DPDP Act, and GDPR breach notification reports",
        ],
        "verification_proof": "Exploit payload blocked (HTTP 400); regression suite 24/24 PASS; /health 200 OK; audit chain verified.",
        "estimated_duration_seconds": 12,
    },
    {
        "id": "S1",
        "code": "S1",
        "title": "Bad Deploy & Automated Rollback",
        "subtitle": "Health-Gate Failure & Instant Recovery",
        "category": "deployment",
        "severity": "high",
        "featured": False,
        "trigger_description": "Commit introducing division-by-zero in /checkout is deployed to shoplite-api",
        "agents_involved": ["Deployer", "Healer", "Builder"],
        "models_used": ["nano", "super"],
        "expected_actions": [
            "Deployer detects 5xx error spike (18.4%) during 60s post-deploy observation window",
            "Tier 0: Capture diagnostic snapshot of failing container",
            "Tier 0: Automatic rollback to last-known-good image shoplite:v1.4.1",
            "Builder Agent opens fix PR #141 with ZeroDivisionError guard and unit test",
        ],
        "verification_proof": "Service rolled back in 14s; /health 200 OK; checkout error rate 0.0%.",
        "estimated_duration_seconds": 8,
    },
    {
        "id": "S2",
        "code": "S2",
        "title": "Container OOM Crash & Runbook Replay",
        "subtitle": "Autonomous Self-Healing & Memory Recall",
        "category": "reliability",
        "severity": "medium",
        "featured": False,
        "trigger_description": "Worker process killed with SIGKILL (exit code 137) due to memory spike",
        "agents_involved": ["Healer"],
        "models_used": ["nano", "super"],
        "expected_actions": [
            "Collector detects container_exit (code 137) on shoplite-api",
            "Healer matches incident signature in Runbook Memory",
            "Tier 0: Snapshot logs & restart container with bounded worker recycling",
            "Verify 3 consecutive /health probes pass",
        ],
        "verification_proof": "Container healthy; memory stabilized at 218 MB; runbook hit recorded.",
        "estimated_duration_seconds": 6,
    },
    {
        "id": "S4",
        "code": "S4",
        "title": "Leaked Stripe Live Secret in Commit",
        "subtitle": "Pre-Deploy Secret Interception & Key Rotation",
        "category": "security",
        "severity": "high",
        "featured": False,
        "trigger_description": "Developer pushes commit containing sk_live_51Nx... in config/payments.py",
        "agents_involved": ["Builder", "Sentinel"],
        "models_used": ["nano", "super"],
        "expected_actions": [
            "Builder Agent pre-deploy review detects Stripe live secret pattern",
            "Redaction engine masks secret before any model or log storage",
            "Tier 0: Block deployment pipeline immediately",
            "Tier 1: Queue approval to rotate Stripe API key and inject via secret store",
        ],
        "verification_proof": "Deployment blocked; zero secret leakage in logs/LLM prompts; rotation queued.",
        "estimated_duration_seconds": 7,
    },
    {
        "id": "S3_DISK",
        "code": "S3",
        "title": "Disk Fullness & Safe Log Rotation",
        "subtitle": "Proactive Resource Hygiene",
        "category": "reliability",
        "severity": "low",
        "featured": False,
        "trigger_description": "/var/log volume exceeds 91% capacity due to unrotated access logs",
        "agents_involved": ["Healer", "Integrity"],
        "models_used": ["nano"],
        "expected_actions": [
            "Collector emits disk_high event (91.4% used)",
            "Tier 0: Archive and SHA-256 hash logs to evidence store",
            "Tier 0: Execute rotate_logs catalog action",
        ],
        "verification_proof": "Disk usage reduced to 34%; archived log hash recorded in audit ledger.",
        "estimated_duration_seconds": 5,
    },
    {
        "id": "S5_BRUTE",
        "code": "S5",
        "title": "Credential Stuffing Brute-Force",
        "subtitle": "Real-Time Perimeter Containment",
        "category": "security",
        "severity": "high",
        "featured": False,
        "trigger_description": "500+ failed /login attempts from 203.0.113.88 within 60 seconds",
        "agents_involved": ["Sentinel"],
        "models_used": ["nano", "super"],
        "expected_actions": [
            "Sentinel correlates auth failure burst from single ASN/IP",
            "Tier 0: Block IP 203.0.113.88 for 1h at Caddy reverse proxy",
            "Tier 0: Enable strict rate-limit profile on /login endpoint",
        ],
        "verification_proof": "Attacker IP returns HTTP 403 at proxy edge; legitimate login latency unaffected.",
        "estimated_duration_seconds": 5,
    },
]


async def run_scenario(scenario_id: str) -> Dict[str, Any]:
    """Execute a specified scenario from the PRD matrix."""
    bus = get_event_bus()
    executor = get_executor()
    s_id = scenario_id.lower().strip()
    run_id = generate_id("run")

    # -----------------------------------------------------------------------
    # S1: Bad Deploy (Division by zero)
    # -----------------------------------------------------------------------
    if s_id in ("s1", "bad_deploy"):
        diff = (
            "--- a/app/orders.py\n+++ b/app/orders.py\n"
            "@@ -20,1 +20,1 @@\n"
            "-    return round(subtotal / max(item_count, 1), 2)\n"
            "+    return round(subtotal / item_count, 2)  # Bug: division by zero if empty cart\n"
        )
        evt = Event(
            source="webhook.git",
            kind="deploy_request",
            service="shoplite-api",
            severity="high",
            data={
                "commit_sha": "a1b2c3d4",
                "diff": diff,
                "author": "dev@shoplite.app",
            },
        )
        await bus.publish(evt)
        inc = Incident(
            category="code_bug",
            owner_agent="deployer",
            severity="high",
            status="resolved",
            title="[S1] Bad Deploy Health-Gate Failure & Auto-Rollback on shoplite-api",
            summary="Division-by-zero regression in orders.py triggered 5xx spike; Deployer automatically rolled back to shoplite:v1.4.1 and Builder opened fix PR #141.",
            affected_service="shoplite-api",
            events=[evt.id],
            snapshots=[f"snap_s1_{run_id[-6:]}"],
            diagnosis=Diagnosis(
                root_cause="ZeroDivisionError in app/orders.py when calculating average item price on empty cart",
                confidence=0.98,
                evidence=[
                    "ZeroDivisionError: float division by zero in app/orders.py:20",
                    "Health gate failed: 5xx rate reached 18.4% (threshold 5.0%)",
                    "Rollback to shoplite:v1.4.1 completed in 14s; /health 200 OK",
                ],
                sources=[
                    DiagnosticSource(
                        title="FastAPI Graceful Rollback & Health Checks",
                        url="https://fastapi.tiangolo.com/deployment/docker/",
                        snippet="Configure container healthcheck probes and automated rollback on 5xx threshold breach.",
                    )
                ],
            ),
            plan=[
                Action(
                    action="rollback_deploy",
                    target="shoplite-api",
                    tier=0,
                    status="executed",
                    reason="Rollback bad commit a1b2c3d4 to last-known-good shoplite:v1.4.1",
                    requested_by="agent:deployer",
                ),
                Action(
                    action="open_pull_request",
                    target="shoplite-api",
                    tier=0,
                    status="executed",
                    reason="Open PR #141 guarding item_count == 0 with unit test",
                    requested_by="agent:builder",
                ),
            ],
            cost_usd=0.0031,
            metadata={"scenario": "S1", "service": "shoplite-api"},
        )
        bus.create_incident(inc)
        return {
            "run_id": run_id,
            "incident_id": inc.id,
            "scenario_id": "S1",
            "scenario": "S1: Bad deploy",
            "status": "triggered",
            "description": "Triggered bad deploy with division by zero. Watch pre-deploy gate, health-gate rollback, and Builder fix PR.",
        }

    # -----------------------------------------------------------------------
    # S2: Crash (Container crash / killed)
    # -----------------------------------------------------------------------
    elif s_id in ("s2", "crash"):
        evt = Event(
            source="collector.docker",
            kind="container_exit",
            service="shoplite-api",
            severity="high",
            data={
                "exit_code": 1,
                "error": "Process terminated abruptly with exit code 1 (SIGSEGV)",
            },
        )
        await bus.publish(evt)
        await asyncio.sleep(0.15)
        recent = bus.list_incidents(limit=1)
        return {
            "run_id": run_id,
            "incident_id": recent[0].id if recent else None,
            "scenario_id": "S2",
            "scenario": "S2: Container crash",
            "status": "triggered",
            "description": "Emitted container exit signal. Healer agent will triage, restart, verify health, and store runbook.",
        }

    # -----------------------------------------------------------------------
    # S3: Disk Full (Log volume threshold exceeded)
    # -----------------------------------------------------------------------
    elif s_id in ("s3", "s3_disk", "disk_full"):
        evt = Event(
            source="collector.health",
            kind="disk_high",
            service="shoplite-api",
            severity="medium",
            data={
                "mount": "/var/log/shoplite",
                "disk_usage_pct": 96.2,
                "free_mb": 42,
            },
        )
        await bus.publish(evt)
        await asyncio.sleep(0.15)
        recent = bus.list_incidents(limit=1)
        return {
            "run_id": run_id,
            "incident_id": recent[0].id if recent else None,
            "scenario_id": "S3_DISK",
            "scenario": "S3: Disk full",
            "status": "triggered",
            "description": "Triggered 96% disk fullness alert. Healer and Integrity snapshot and rotate logs.",
        }

    # -----------------------------------------------------------------------
    # S4: Leaked Secret (Stripe secret key in diff)
    # -----------------------------------------------------------------------
    elif s_id in ("s4", "leaked_secret"):
        diff = (
            "--- a/config/payment.py\n+++ b/config/payment.py\n"
            "@@ -10,1 +10,1 @@\n"
            "-    STRIPE_SECRET_KEY = os.getenv('STRIPE_SECRET_KEY')\n"
            "+    STRIPE_SECRET_KEY = 'sk_' 'live_51MzDemoKeyWithRealEntropy7739'\n"
        )
        evt = Event(
            source="webhook.git",
            kind="deploy_request",
            service="shoplite-api",
            severity="critical",
            data={
                "commit_sha": "sec998877",
                "diff": diff,
                "author": "intern@shoplite.app",
            },
        )
        await bus.publish(evt)
        inc_id = generate_id("inc")
        act = Action(
            action="rotate_secret",
            target="shoplite-api",
            tier=1,
            params={"secret_name": "STRIPE_SECRET_KEY"},
            reason="Rotate exposed Stripe live API key detected in commit sec998877",
            expected_outcome="Old Stripe secret revoked; new rotated secret injected into runtime vault",
            rollback="Restore previous secret reference from encrypted snapshot if payment webhook fails",
            requested_by="agent:sentinel",
        )
        mgr = get_approval_manager()
        mgr.create_pending_approval(act, incident_id=inc_id)
        inc = Incident(
            id=inc_id,
            category="security",
            owner_agent="sentinel",
            severity="high",
            status="acting",
            title="[S4] Leaked Stripe Live API Key in Commit sec998877",
            summary="Pre-deploy secret scanner intercepted a hardcoded Stripe live secret. Deployment blocked automatically; Tier 1 key rotation queued for human approval.",
            affected_service="shoplite-api",
            events=[evt.id],
            snapshots=[f"snap_s4_{run_id[-6:]}"],
            diagnosis=Diagnosis(
                root_cause="Hardcoded Stripe live API key committed to config/payment.py line 10",
                confidence=0.99,
                evidence=[
                    "Commit sec998877 diff matched pattern sk_live_[REDACTED]",
                    "Redactor masked secret prior to LLM prompt and audit log persistence",
                    "Deployer pre-deploy security gate blocked image promotion",
                ],
                sources=[
                    DiagnosticSource(
                        title="Stripe API Key Rotation & Incident Response",
                        url="https://docs.stripe.com/keys#rolling-keys",
                        snippet="Immediately roll compromised live API keys and inject via environment secret managers.",
                    )
                ],
            ),
            plan=[act],
            approval_required=True,
            approval_id=act.id,
            cost_usd=0.0019,
            metadata={"scenario": "S4", "service": "shoplite-api", "approval_id": act.id, "approval_required": True},
        )
        bus.create_incident(inc)
        return {
            "run_id": run_id,
            "incident_id": inc.id,
            "action_id": act.id,
            "scenario_id": "S4",
            "scenario": "S4: Leaked secret",
            "status": "triggered",
            "description": "Simulated commit containing live Stripe API key. Sentinel blocks deploy; requests secret rotation.",
        }

    # -----------------------------------------------------------------------
    # S5: Brute Force (500 failed logins)
    # -----------------------------------------------------------------------
    elif s_id in ("s5", "s5_brute", "bruteforce"):
        evt = Event(
            source="collector.auth",
            kind="bruteforce",
            service="shoplite-api",
            severity="high",
            data={
                "ip": "203.0.113.195",
                "failed_attempts": 512,
                "time_window_seconds": 60,
                "targeted_endpoint": "/api/v1/auth/login",
            },
        )
        await bus.publish(evt)
        await asyncio.sleep(0.15)
        recent = bus.list_incidents(limit=1)
        return {
            "run_id": run_id,
            "incident_id": recent[0].id if recent else None,
            "scenario_id": "S5_BRUTE",
            "scenario": "S5: Brute force",
            "status": "triggered",
            "description": "Triggered brute force credential stuffing signal. Sentinel temporarily blocks IP for 1 hour.",
        }

    # -----------------------------------------------------------------------
    # S6: SQL Injection & Data Exposure (Headline Loop)
    # -----------------------------------------------------------------------
    elif s_id in ("s6", "sqli"):
        payload = "' UNION SELECT email,phone,password_hash FROM users--"
        evt = Event(
            source="collector.logs",
            kind="sqli_pattern",
            service="shoplite-api",
            severity="critical",
            data={
                "ip": "198.51.100.88",
                "endpoint": "/search",
                "payload": payload,
                "query": f"SELECT id, name, price FROM products WHERE name LIKE '%{payload}%'",
                "rows_returned": 142,
            },
        )
        await bus.publish(evt)
        await asyncio.sleep(0.25)
        recent = bus.list_incidents(limit=1)
        return {
            "run_id": run_id,
            "incident_id": recent[0].id if recent else None,
            "scenario_id": "S6",
            "scenario": "S6: SQL Injection & Data Exposure",
            "status": "triggered",
            "description": (
                "Executed SQL injection attack. Sentinel contains IP and hashes evidence; Integrity assesses exposure; "
                "Builder writes parameterized patch + regression test (red-to-green proof); opens PR; drafts CERT-In/DPDP reports."
            ),
        }

    # -----------------------------------------------------------------------
    # S7: Destructive Migration
    # -----------------------------------------------------------------------
    elif s_id in ("s7", "destructive_migration"):
        migration_sql = "ALTER TABLE users DROP COLUMN phone;"
        evt = Event(
            source="webhook.git",
            kind="deploy_request",
            service="shoplite-api",
            severity="high",
            data={
                "commit_sha": "mig12345",
                "diff": "add migration dropping phone column",
                "migration_sql": migration_sql,
            },
        )
        await bus.publish(evt)
        inc = Incident(
            category="data_integrity",
            owner_agent="integrity",
            severity="high",
            status="resolved",
            title="[S7] Destructive Database Migration Blocked (DROP COLUMN users.phone)",
            summary="Integrity Agent intercepted destructive schema migration before execution, snapshotted shoplite-db, and blocked deployment.",
            affected_service="shoplite-db",
            events=[evt.id],
            snapshots=[f"snap_s7_{run_id[-6:]}"],
            diagnosis=Diagnosis(
                root_cause="Unapproved destructiveDDL statement ALTER TABLE users DROP COLUMN phone in commit mig12345",
                confidence=0.99,
                evidence=[
                    "Migration SQL contains destructive DROP COLUMN on PII table users",
                    "Pre-migration snapshot snap_db_pre_mig captured and verified",
                    "Deployment blocked by Integrity Gate FR-I2",
                ],
            ),
            cost_usd=0.0012,
            metadata={"scenario": "S7", "service": "shoplite-db"},
        )
        bus.create_incident(inc)
        return {
            "run_id": run_id,
            "incident_id": inc.id,
            "scenario_id": "S7",
            "scenario": "S7: Destructive migration",
            "status": "triggered",
            "description": "Triggered migration dropping users.phone. Integrity guard detects data loss and blocks deploy.",
        }

    # -----------------------------------------------------------------------
    # S8: Remote Approval from Phone
    # -----------------------------------------------------------------------
    elif s_id in ("s8", "phone_approval"):
        from alexia.remote.push import send_push_notification

        act = Action(
            action="merge_pull_request_and_deploy",
            target="shoplite-api",
            tier=1,
            params={"pr_number": 42},
            reason="Approve production deployment of SQL injection fix",
            expected_outcome="PR #42 merged and shoplite-api redeployed with parameterized SQL patch",
            rollback="Rollback to shoplite:v1.4.2 snapshot via Deployer",
            requested_by="agent:builder",
        )
        mgr = get_approval_manager()
        token = mgr.create_pending_approval(act, incident_id="inc_s6_sqli_breach")

        notif = Notification(
            id=generate_id("ntf"),
            incident_id="inc_s6_sqli_breach",
            severity="high",
            title="Approval Required: Merge Fix PR #42",
            body="SQL injection patch ready · 1 click biometric approval required to ship",
            deep_link=f"/m/approvals/{act.id}",
            actions=["review", "reject"],
        )
        send_push_notification(notif)
        bus.broadcast_sse({"type": "notification", "data": notif.model_dump()})

        return {
            "run_id": run_id,
            "scenario_id": "S8",
            "scenario": "S8: Remote approval from phone",
            "status": "triggered",
            "action_id": act.id,
            "token": token,
            "description": "Pushed approval request to mobile companion. Tap notification or open Approvals tab with biometric/passkey.",
        }

    # -----------------------------------------------------------------------
    # S9: Kill Switch (Pause all autonomy)
    # -----------------------------------------------------------------------
    elif s_id in ("s9", "kill_switch"):
        executor.pause_autonomy(paused_by="user:demo_scenario")
        evt = Event(
            source="collector.docker",
            kind="container_exit",
            service="shoplite-api",
            severity="high",
            data={
                "exit_code": 1,
                "error": "Crash while autonomy is paused.",
            },
        )
        await bus.publish(evt)
        await asyncio.sleep(0.15)
        recent = bus.list_incidents(limit=1)
        return {
            "run_id": run_id,
            "incident_id": recent[0].id if recent else None,
            "scenario_id": "S9",
            "scenario": "S9: Kill switch activated",
            "status": "triggered",
            "description": "Autonomy PAUSED. Container crash simulated: notice that Healer queues restart for human approval rather than auto-acting.",
        }

    else:
        return {"error": f"Unknown scenario: {scenario_id}. Choose from s1 to s9."}


def seed_initial_demo_state() -> None:
    """Seed initial realistic DevSecOps state if database is empty."""
    bus = get_event_bus()
    if len(bus.list_incidents(limit=1)) > 0:
        return

    mgr = get_approval_manager()
    guard = get_budget_guard()
    audit = get_audit_log()

    # 1. Pending Tier-1 Approval for S6 SQLi PR merge
    act_s6 = Action(
        id="apr_s6_merge_fix",
        action="merge_pr",
        target="shoplite-api",
        tier=1,
        params={"pr_number": 142, "branch": "alexia/fix-sqli-products"},
        reason="Merge Builder-generated PR #142 (parameterized SQL query in /products?q=) and deploy patched image shoplite:v1.4.3-sec",
        expected_outcome="Eliminates SQL injection vector on /products; passes all 24 regression + exploit tests in sandbox.",
        rollback="Instant image rollback to snapshot snap_pre_s6_01 (shoplite:v1.4.2) within 8 seconds.",
        requested_by="agent:builder",
    )
    mgr.create_pending_approval(act_s6, incident_id="inc_s6_sqli_breach", snapshot_id="snap_pre_s6_01")

    # 2. Pending Tier-1 Approval for S4 Stripe Key Rotation
    act_s4 = Action(
        id="apr_s4_rotate_key",
        action="rotate_secret",
        target="shoplite-api",
        tier=1,
        params={"secret_name": "STRIPE_SECRET_KEY"},
        reason="Rotate compromised Stripe live API key detected in commit 9f3a1c2 (redacted as [REDACTED_STRIPE_KEY])",
        expected_outcome="Old Stripe key revoked; new restricted secret injected via runtime secret store and container reloaded.",
        rollback="Restore previous secret reference from encrypted snapshot snap_pre_s4_01 if payment gateway handshake fails.",
        requested_by="agent:sentinel",
    )
    mgr.create_pending_approval(act_s4, incident_id="inc_s4_secret_leak", snapshot_id="snap_pre_s4_01")

    # 3. Headline Incident S6: SQL Injection & Data Exposure
    inc_s6 = Incident(
        id="inc_s6_sqli_breach",
        title="SQL Injection & PII Exposure on /products?q= (S6)",
        summary="Attacker at 198.51.100.42 exploited unparameterized query on shoplite-api, reading 1,240 user rows. IP blocked at proxy, forensic snapshot hashed, parameterized fix verified in sandbox, awaiting PR #142 merge approval.",
        category="security",
        severity="critical",
        status="acting",
        owner_agent="sentinel",
        affected_service="shoplite-api",
        snapshots=["snap_pre_s6_01"],
        approval_required=True,
        approval_id=act_s6.id,
        cost_usd=0.0113,
        diagnosis=Diagnosis(
            root_cause="Unparameterized f-string SQL query in target-app/routes/products.py line 48 allows UNION-based extraction of users table.",
            explanation="Nemotron 3 Ultra correlated Caddy access logs (`GET /products?q=%27+UNION+SELECT+email,phone,password_hash+FROM+users--`) with PostgreSQL row-read telemetry (1,240 rows returned vs baseline avg of 12). All PII and password hashes in logs were redacted before model ingestion.",
            confidence=0.98,
            evidence=[
                "WAF/Log Alert: payload `' UNION SELECT email,phone,[REDACTED] FROM users--` from IP 198.51.100.42",
                "DB Telemetry: `SELECT` row read spike of 1,240 rows on `users` table within 1.8s",
                "Sandbox Proof: `pytest tests/test_security_sqli.py` -> BEFORE patch: FAIL (200 OK leaked rows) | AFTER patch: PASS (400 Bad Request / 0 leaked rows)",
            ],
            sources=[
                DiagnosticSource(
                    title="OWASP SQL Injection Prevention Cheat Sheet",
                    url="https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html",
                    domain="cheatsheetseries.owasp.org",
                    excerpt="Defense Option 1: Prepared Statements (with Parameterized Queries) ensure that an attacker is not able to change the intent of a query.",
                ),
                DiagnosticSource(
                    title="SQLAlchemy 2.0 Parameterized Text Queries",
                    url="https://docs.sqlalchemy.org/en/20/core/sqlelement.html#sqlalchemy.sql.expression.text",
                    domain="docs.sqlalchemy.org",
                    excerpt="Always bind parameters using `:param` syntax with `session.execute(text(sql), {\"param\": val})` instead of Python string formatting.",
                ),
            ],
        ),
        plan=[act_s6],
        verification={
            "test_before": "FAIL (exploit payload returned 1,240 user rows)",
            "test_after": "PASS (parameterized query returned 0 user rows; 24/24 tests green)",
            "health_check": "HTTP 200 OK (18ms) - IP 198.51.100.42 blocked at edge",
            "deployment_status": "staged_awaiting_approval",
            "snapshot_verified": True,
        },
        metadata={
            "service": "shoplite-api",
            "approval_id": act_s6.id,
            "approval_required": True,
            "exposure_assessment": {
                "affected_tables": ["users"],
                "affected_columns": ["email", "phone", "password_hash"],
                "estimated_rows_exposed": 1240,
            },
        },
    )
    bus.create_incident(inc_s6)

    # 4. Incident S1: Bad Deploy & Automated Rollback
    inc_s1 = Incident(
        id="inc_s1_bad_deploy",
        title="Post-Deploy 5xx Spike & Auto-Rollback on /checkout (S1)",
        summary="Release shoplite:v1.4.2-rc1 introduced a ZeroDivisionError when discount_items=0. Deployer health gate failed after 42s and automatically rolled back to shoplite:v1.4.1.",
        category="code_bug",
        severity="high",
        status="resolved",
        owner_agent="deployer",
        affected_service="shoplite-api",
        snapshots=["snap_pre_s1_01"],
        cost_usd=0.0041,
        diagnosis=Diagnosis(
            root_cause="Unhandled ZeroDivisionError in calculate_bundle_discount() when cart contains only non-promotional items.",
            confidence=0.96,
            evidence=[
                "Traceback: `ZeroDivisionError: float division by zero` in `checkout.py:114`",
                "Health gate failure: `/health/deep` returned HTTP 503; 5xx error rate 18.4% > 5.0% threshold",
                "Rollback verification: `shoplite:v1.4.1` restored; 0 errors over 180s observation window",
            ],
            sources=[
                DiagnosticSource(
                    title="FastAPI Exception Handling & Health Probes",
                    url="https://fastapi.tiangolo.com/tutorial/handling-errors/",
                    domain="fastapi.tiangolo.com",
                    excerpt="Guard arithmetic denominators in checkout pipelines and return structured 422 validation responses.",
                )
            ],
        ),
        metadata={"service": "shoplite-api"},
    )
    bus.create_incident(inc_s1)

    # 5. Incident S2: Container OOM Crash & Runbook Replay
    inc_s2 = Incident(
        id="inc_s2_crash_loop",
        title="Container OOM Exit (Code 137) & Runbook Auto-Heal (S2)",
        summary="shoplite-api worker exited with code 137. Healer matched Runbook #RB-04, restarted container with bounded worker memory, and verified health in 9 seconds.",
        category="oom",
        severity="medium",
        status="resolved",
        owner_agent="healer",
        affected_service="shoplite-api",
        snapshots=["snap_pre_s2_01"],
        cost_usd=0.0005,
        diagnosis=Diagnosis(
            root_cause="Unbounded report export buffer triggered Linux OOM killer (SIGKILL / exit code 137).",
            confidence=0.94,
            evidence=[
                "Docker event: `container_exit` status=137 OOMKilled=true",
                "Runbook Memory match: signature `oom:shoplite-api:exit_137` (99% similarity)",
            ],
        ),
        metadata={"service": "shoplite-api"},
    )
    bus.create_incident(inc_s2)

    # 6. Incident S4: Leaked Stripe Secret in Git Commit
    inc_s4 = Incident(
        id="inc_s4_secret_leak",
        title="Leaked Stripe Live API Key in Commit 9f3a1c2 (S4)",
        summary="Builder pre-deploy review intercepted a hardcoded `sk_live_...` key in `config/payments.py`. Secret redacted across all logs, deploy blocked, and Tier 1 key rotation queued.",
        category="security",
        severity="high",
        status="acting",
        owner_agent="sentinel",
        affected_service="shoplite-api",
        snapshots=["snap_pre_s4_01"],
        approval_required=True,
        approval_id=act_s4.id,
        cost_usd=0.0022,
        diagnosis=Diagnosis(
            root_cause="Developer committed live Stripe secret key directly in `config/payments.py` instead of referencing `.env` secret store.",
            confidence=0.99,
            evidence=[
                "Regex + entropy detector matched `sk_live_[REDACTED_STRIPE_KEY]` in git diff",
                "Redaction layer verified 0 raw secret bytes sent to Nemotron or stored in SQLite",
            ],
        ),
        plan=[act_s4],
        metadata={"service": "shoplite-api", "approval_id": act_s4.id, "approval_required": True},
    )
    bus.create_incident(inc_s4)

    # 7. Seed initial model usage calls for Nemotron 3 Nano, Super, Ultra
    guard.record_model_call(
        model_tier="nano",
        model_id="nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
        prompt_tokens=420,
        completion_tokens=95,
        cost_usd=0.0002,
        latency_ms=142.0,
        task="triage",
        incident_id="inc_s6_sqli_breach",
    )
    guard.record_model_call(
        model_tier="ultra",
        model_id="nvidia/Nemotron-3-Ultra-550b-a55b",
        prompt_tokens=2840,
        completion_tokens=910,
        cost_usd=0.0094,
        latency_ms=1380.0,
        task="investigation",
        incident_id="inc_s6_sqli_breach",
    )
    guard.record_model_call(
        model_tier="super",
        model_id="nvidia/nemotron-3-super-120b-a12b",
        prompt_tokens=1620,
        completion_tokens=640,
        cost_usd=0.0031,
        latency_ms=690.0,
        task="patch_gen",
        incident_id="inc_s6_sqli_breach",
    )
    guard.record_model_call(
        model_tier="super",
        model_id="nvidia/nemotron-3-super-120b-a12b",
        prompt_tokens=1410,
        completion_tokens=720,
        cost_usd=0.0029,
        latency_ms=640.0,
        task="breach_report",
        incident_id="inc_s6_sqli_breach",
    )
    guard.record_tavily_search(
        query="OWASP SQL injection prevention SQLAlchemy parameterized queries",
        incident_id="inc_s6_sqli_breach",
        results_count=2,
        cached=False,
    )

    # 8. Seed initial audit records if needed
    audit.record(
        event_type="INCIDENT_DETECTED",
        actor="Sentinel",
        details={
            "action": "Correlated SQLi payload & 1,240-row read anomaly",
            "target": "shoplite-api (/products)",
            "incident_id": "inc_s6_sqli_breach",
        },
    )
    audit.record(
        event_type="TIER0_ACTION_EXECUTED",
        actor="Sentinel",
        details={
            "action": "block_ip(198.51.100.42, duration=3600s)",
            "target": "caddy-proxy",
            "incident_id": "inc_s6_sqli_breach",
        },
    )


def reset_demo_environment() -> Dict[str, Any]:
    """Reset environment state, blocklists, and resume autonomy."""
    executor = get_executor()
    if executor.is_autonomy_paused():
        executor.resume_autonomy(resumed_by="system:reset", step_up_method="system_reset")

    # Clear blocklist
    with executor._get_connection() as conn:
        conn.execute("DELETE FROM ip_blocklist")
        conn.commit()

    return {"status": "success", "message": "Demo environment reset. Autonomy active, IP blocklist cleared."}
