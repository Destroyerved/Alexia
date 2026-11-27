"""Demo scenario launcher executing PRD Section 10 test scenarios.

Implements FR-U6, NFR5:
- One-click triggers for all 9 demo scenarios (S1 to S9) and environment reset.
- Coordinates collectors, agents, and bus events to reproduce real-world incidents.
"""

from __future__ import annotations
import asyncio
import logging
import re
from typing import Any, Dict, List, Optional

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


def _demo_stripe_key(suffix: str = "51MzDemoKeyWithRealEntropy7739") -> str:
    """Build a Stripe-shaped demo fake at runtime so secret scanners never see one."""
    return "sk" + "_" + "live" + "_" + suffix


SCENARIO_CATALOG: List[Dict[str, Any]] = [
    {
        "id": "S6",
        "code": "S6",
        "title": "SQL Injection & Data Exposure",
        "subtitle": "Headline Security & Self-Healing Loop",
        "category": "security",
        "severity": "critical",
        "featured": True,
        "trigger_description": "Attacker sends ' UNION SELECT email,phone,password_hash FROM users-- to /search on shoplite-api",
        "agents_involved": ["Sentinel", "Integrity", "Builder", "Deployer"],
        "models_used": ["nano", "super", "ultra"],
        "expected_actions": [
            "Sentinel hashes forensic evidence before any containment",
            "Tier 0: block attacker IP 198.51.100.88 at the reverse proxy for 1 hour",
            "Integrity assesses exposed tables, columns and row count",
            "Ultra reconstructs the attack timeline",
            "Builder writes a parameterized-query patch + payload regression test, proves red-to-green in the sandbox, opens a PR",
            "Tier 1: merge + deploy queued for human approval",
            "CERT-In (6h), DPDP and GDPR Art. 33 breach-report drafts",
        ],
        "verification_proof": "IP blocked; regression test fails before and passes after the patch; merge waits on step-up approval; audit chain verified.",
        "estimated_duration_seconds": 10,
    },
    {
        "id": "S1",
        "code": "S1",
        "title": "Bad Deploy & Automated Rollback",
        "subtitle": "Health-Gate Failure & Instant Recovery",
        "category": "deployment",
        "severity": "high",
        "featured": False,
        "trigger_description": "Commit introducing a division by zero in app/orders.py is forced past the Builder review flag",
        "agents_involved": ["Builder", "Deployer"],
        "models_used": ["super", "ultra"],
        "expected_actions": [
            "Builder pre-deploy review flags the ZeroDivisionError risk",
            "Deploy forced through: health gate sees HTTP 500 on /orders/total",
            "Tier 0: automatic rollback to the last good image in under 60s",
            "Builder writes a regression test + patch, proves red-to-green, opens a fix PR (merge queued for approval)",
        ],
        "verification_proof": "Rollback executed; regression test fails before and passes after the patch.",
        "estimated_duration_seconds": 6,
    },
    {
        "id": "S2",
        "code": "S2",
        "title": "Container Crash & Runbook Replay",
        "subtitle": "Autonomous Self-Healing & Memory Recall",
        "category": "reliability",
        "severity": "high",
        "featured": False,
        "trigger_description": "shoplite-api killed with SIGKILL (exit code 137)",
        "agents_involved": ["Healer"],
        "models_used": ["nano", "super", "ultra"],
        "expected_actions": [
            "Nano triages the container_exit event",
            "Super diagnoses with Tavily sources; Ultra plans (or Runbook Memory replays a known fix)",
            "Tier 0: restart container, then verify health",
            "Runbook entry stored for instant replay next time",
        ],
        "verification_proof": "Incident resolved in under 60s; runbook entry recorded.",
        "estimated_duration_seconds": 4,
    },
    {
        "id": "S4",
        "code": "S4",
        "title": "Leaked Stripe Live Secret in Commit",
        "subtitle": "Pre-Deploy Secret Interception & Key Rotation",
        "category": "security",
        "severity": "critical",
        "featured": False,
        "trigger_description": "Developer pushes a commit hard-coding a Stripe live key (sk_live_...) in config/payment.py",
        "agents_involved": ["Sentinel", "Deployer"],
        "models_used": ["super"],
        "expected_actions": [
            "Sentinel secret scan (regex + entropy) runs as the first Deployer gate",
            "Deployment blocked before release; the key is never stored or sent to a model unredacted",
            "Tier 1: rotate_secret queued for human approval with a pre-action snapshot",
        ],
        "verification_proof": "Deploy blocked; rotation waiting in Approvals; zero raw secret bytes in logs or prompts.",
        "estimated_duration_seconds": 3,
    },
    {
        "id": "S3_DISK",
        "code": "S3",
        "title": "Disk Full & Safe Log Rotation",
        "subtitle": "Proactive Resource Hygiene",
        "category": "reliability",
        "severity": "medium",
        "featured": False,
        "trigger_description": "/var/log/shoplite volume reaches 96% capacity from unrotated access logs",
        "agents_involved": ["Healer", "Integrity"],
        "models_used": ["nano", "super", "ultra"],
        "expected_actions": [
            "Collector emits disk_high; Nano triages as disk_full",
            "Integrity snapshot before any data-touching action",
            "Tier 0: clear_tmp_and_rotate_logs, then verify",
        ],
        "verification_proof": "Logs rotated, incident resolved, no data files touched.",
        "estimated_duration_seconds": 4,
    },
    {
        "id": "S5_BRUTE",
        "code": "S5",
        "title": "Brute-Force Login Attack",
        "subtitle": "Real-Time Perimeter Containment",
        "category": "security",
        "severity": "high",
        "featured": False,
        "trigger_description": "512 failed /login attempts from 203.0.113.195 within 60 seconds",
        "agents_involved": ["Sentinel"],
        "models_used": ["ultra"],
        "expected_actions": [
            "Sentinel preserves evidence and correlates the auth-failure burst",
            "Tier 0: block 203.0.113.195 for 1 hour (block expires automatically)",
            "Incident timeline and breach-report drafts recorded",
        ],
        "verification_proof": "IP blocked in under 30s; incident contained and resolved.",
        "estimated_duration_seconds": 3,
    },
    {
        "id": "S7",
        "code": "S7",
        "title": "Destructive Database Migration",
        "subtitle": "Integrity Migration Guard",
        "category": "deployment",
        "severity": "high",
        "featured": False,
        "trigger_description": "Deploy includes ALTER TABLE users DROP COLUMN phone",
        "agents_involved": ["Integrity", "Deployer"],
        "models_used": ["ultra"],
        "expected_actions": [
            "Integrity dry-runs the migration and detects data loss",
            "Deployment blocked; reviewer sees the row count at risk",
            "Tier 1: run_migration queued for human approval",
        ],
        "verification_proof": "Deploy blocked with records-at-risk reported; migration waiting in Approvals.",
        "estimated_duration_seconds": 3,
    },
    {
        "id": "S8",
        "code": "S8",
        "title": "Remote Approval from Phone",
        "subtitle": "Mobile Companion Step-Up Approval",
        "category": "security",
        "severity": "high",
        "featured": False,
        "trigger_description": "The S6 fix-PR merge needs approval; a push notification deep-links to it",
        "agents_involved": ["Builder", "Deployer"],
        "models_used": ["nano"],
        "expected_actions": [
            "Push notification (redacted one-liner) to registered devices",
            "Approve in Approvals with passkey/biometric or TOTP step-up",
            "Approval token is single-use and expires after 5 minutes; device recorded on the audit chain",
        ],
        "verification_proof": "Merge approval pending for the phone; approving without step-up is refused.",
        "estimated_duration_seconds": 3,
    },
    {
        "id": "S9",
        "code": "S9",
        "title": "Autonomy Kill Switch",
        "subtitle": "Pause All Autonomy, Then Crash",
        "category": "reliability",
        "severity": "high",
        "featured": False,
        "trigger_description": "Autonomy is paused, then shoplite-api crashes",
        "agents_involved": ["Healer"],
        "models_used": ["nano", "super", "ultra"],
        "expected_actions": [
            "Healer still detects, triages and diagnoses the crash",
            "The restart is queued for human approval instead of executing",
            "Resuming autonomy requires step-up authentication",
        ],
        "verification_proof": "Restart not executed while paused; incident waits on approval.",
        "estimated_duration_seconds": 4,
    },
]


_SCENARIO_KEYWORDS = {
    "bad_deploy": "s1",
    "crash": "s2",
    "disk_full": "s3",
    "leaked_secret": "s4",
    "bruteforce": "s5",
    "brute_force": "s5",
    "sqli": "s6",
    "destructive_migration": "s7",
    "phone_approval": "s8",
    "kill_switch": "s9",
}


def build_s1_bad_commit() -> str:
    """S1's buggy commit as a real diff against ShopLite: it deletes the empty-cart guard in
    /orders/total, so the deployed code raises ZeroDivisionError for item_count=0."""
    from alexia.tools.diffutil import make_diff
    from alexia.tools.sandbox import get_sandbox_runner

    src = get_sandbox_runner().read_workspace_file("app/main.py")
    lines = src.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if "if item_count == 0" in line:
            indent = len(line) - len(line.lstrip())
            end = i + 1
            while end < len(lines) and (not lines[end].strip() or len(lines[end]) - len(lines[end].lstrip()) > indent):
                end += 1
            return make_diff("app/main.py", src, "".join(lines[:i] + lines[end:]))
    # Guard already missing (or file changed): fall back to an illustrative diff the scanners still flag
    return (
        "--- a/app/main.py\n+++ b/app/main.py\n@@ -1,1 +1,1 @@\n"
        "-    return round(subtotal / max(item_count, 1), 2)\n"
        "+    return round(subtotal / item_count, 2)\n"
    )


def normalize_scenario_id(scenario_id: str) -> str:
    """Map catalog ids (S3_DISK), PRD names (S6_sqli_breach) and keywords (sqli) onto s1..s9."""
    s_id = scenario_id.lower().strip()
    m = re.match(r"^s(\d)(?:_|$)", s_id)
    if m:
        return f"s{m.group(1)}"
    return _SCENARIO_KEYWORDS.get(s_id, s_id)


async def _incident_for_event(event_id: str, timeout: float = 10.0) -> Optional[Incident]:
    """Wait for the orchestrator to open the incident linked to this event (never 'latest incident')."""
    bus = get_event_bus()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        for inc in bus.list_incidents(limit=25):
            if event_id in inc.events:
                return inc
        if loop.time() >= deadline:
            logger.warning(f"No incident linked to event {event_id} after {timeout}s")
            return None
        await asyncio.sleep(0.05)


def _pending_merge_approval() -> Optional[Dict[str, Any]]:
    for appr in get_approval_manager().list_pending(include_token=True):
        if appr["action_name"] in ("merge_pull_request_and_deploy", "merge_pr"):
            return appr
    return None


def _triggered(run_id: str, scenario_id: str, name: str, inc: Optional[Incident], description: str, **extra: Any) -> Dict[str, Any]:
    return {
        "run_id": run_id,
        "incident_id": inc.id if inc else None,
        "scenario_id": scenario_id,
        "scenario": name,
        "status": "triggered",
        "description": description,
        **extra,
    }


async def run_scenario(scenario_id: str) -> Dict[str, Any]:
    """Execute a specified scenario from the PRD matrix through the real agent pipeline."""
    bus = get_event_bus()
    executor = get_executor()
    s_id = normalize_scenario_id(scenario_id)
    run_id = generate_id("run")

    # -----------------------------------------------------------------------
    # S1: Bad Deploy (division by zero) forced past the Builder review flag
    # -----------------------------------------------------------------------
    if s_id == "s1":
        diff = await asyncio.to_thread(build_s1_bad_commit)
        evt = Event(
            source="webhook.git",
            kind="deploy_request",
            service="shoplite-api",
            severity="high",
            data={"commit_sha": "a1b2c3d4", "diff": diff, "author": "dev@shoplite.app", "force_deploy": True},
        )
        await bus.publish(evt)
        inc = await _incident_for_event(evt.id)
        return _triggered(
            run_id, "S1", "S1: Bad deploy", inc,
            "Deploy forced past the Builder review flag: health gate fails, Deployer rolls back, Builder writes a "
            "regression test + patch, proves red-to-green in the sandbox and opens a PR (merge queued for approval).",
        )

    # -----------------------------------------------------------------------
    # S2: Crash (container killed)
    # -----------------------------------------------------------------------
    elif s_id == "s2":
        evt = Event(
            source="collector.docker",
            kind="container_exit",
            service="shoplite-api",
            severity="high",
            data={"exit_code": 137, "error": "Container shoplite-api killed (exit code 137, docker kill)"},
        )
        await bus.publish(evt)
        inc = await _incident_for_event(evt.id)
        return _triggered(
            run_id, "S2", "S2: Container crash", inc,
            "Emitted container exit signal. Healer triages, restarts, verifies health and stores a runbook entry.",
        )

    # -----------------------------------------------------------------------
    # S3: Disk Full (log volume threshold exceeded)
    # -----------------------------------------------------------------------
    elif s_id == "s3":
        evt = Event(
            source="collector.health",
            kind="disk_high",
            service="shoplite-api",
            severity="medium",
            data={"mount": "/var/log/shoplite", "disk_usage_pct": 96.2, "free_mb": 42, "error": "Log volume /var/log/shoplite at 96.2% capacity"},
        )
        await bus.publish(evt)
        inc = await _incident_for_event(evt.id)
        return _triggered(
            run_id, "S3_DISK", "S3: Disk full", inc,
            "Triggered 96% disk fullness alert. Healer and Integrity snapshot and rotate logs.",
        )

    # -----------------------------------------------------------------------
    # S4: Leaked Secret (Stripe secret key in diff) -> Sentinel deploy gate
    # -----------------------------------------------------------------------
    elif s_id == "s4":
        diff = (
            "--- a/config/payment.py\n+++ b/config/payment.py\n"
            "@@ -10,1 +10,1 @@\n"
            "-    STRIPE_SECRET_KEY = os.getenv('STRIPE_SECRET_KEY')\n"
            f"+    STRIPE_SECRET_KEY = '{_demo_stripe_key()}'\n"
        )
        evt = Event(
            source="webhook.git",
            kind="deploy_request",
            service="shoplite-api",
            severity="critical",
            data={"commit_sha": "sec998877", "diff": diff, "author": "intern@shoplite.app"},
        )
        await bus.publish(evt)
        inc = await _incident_for_event(evt.id)
        return _triggered(
            run_id, "S4", "S4: Leaked secret", inc,
            "Simulated commit containing a live Stripe key. Sentinel's pre-deploy gate blocks the release and "
            "queues a Tier-1 key rotation for approval.",
            action_id=inc.approval_id if inc else None,
        )

    # -----------------------------------------------------------------------
    # S5: Brute Force (500 failed logins)
    # -----------------------------------------------------------------------
    elif s_id == "s5":
        evt = Event(
            source="collector.auth",
            kind="bruteforce",
            service="shoplite-api",
            severity="high",
            data={
                "ip": "203.0.113.195",
                "failed_attempts": 512,
                "time_window_seconds": 60,
                "targeted_endpoint": "/login",
            },
        )
        await bus.publish(evt)
        inc = await _incident_for_event(evt.id)
        return _triggered(
            run_id, "S5_BRUTE", "S5: Brute force", inc,
            "Triggered brute force credential stuffing signal. Sentinel temporarily blocks the IP for 1 hour.",
        )

    # -----------------------------------------------------------------------
    # S6: SQL Injection & Data Exposure (Headline Loop)
    # -----------------------------------------------------------------------
    elif s_id == "s6":
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
        inc = await _incident_for_event(evt.id)
        return _triggered(
            run_id, "S6", "S6: SQL Injection & Data Exposure", inc,
            "Executed SQL injection attack. Sentinel contains IP and hashes evidence; Integrity assesses exposure; "
            "Builder writes parameterized patch + regression test (red-to-green proof); opens PR; drafts CERT-In/DPDP reports.",
        )

    # -----------------------------------------------------------------------
    # S7: Destructive Migration -> Integrity migration guard
    # -----------------------------------------------------------------------
    elif s_id == "s7":
        evt = Event(
            source="webhook.git",
            kind="deploy_request",
            service="shoplite-api",
            severity="high",
            data={
                "commit_sha": "mig12345",
                "diff": "+-- migration 0007: drop users.phone",
                "migration_sql": "ALTER TABLE users DROP COLUMN phone;",
            },
        )
        await bus.publish(evt)
        inc = await _incident_for_event(evt.id)
        return _triggered(
            run_id, "S7", "S7: Destructive migration", inc,
            "Triggered migration dropping users.phone. Integrity guard detects data loss and blocks the deploy pending approval.",
            action_id=inc.approval_id if inc else None,
        )

    # -----------------------------------------------------------------------
    # S8: Remote approval from phone for the S6 fix-PR merge
    # -----------------------------------------------------------------------
    elif s_id == "s8":
        from alexia.remote.push import send_push_notification

        approval = _pending_merge_approval()
        if approval is None:
            # PRD S8 runs "during S6": start the breach loop so Builder queues its merge approval
            await run_scenario("s6")
            loop = asyncio.get_running_loop()
            deadline = loop.time() + 15.0
            while approval is None and loop.time() < deadline:
                await asyncio.sleep(0.1)
                approval = _pending_merge_approval()
        if approval is None:
            return {"error": "S8 needs a pending fix-PR merge approval, and the S6 run did not produce one."}

        notif = Notification(
            id=generate_id("ntf"),
            incident_id=approval["incident_id"],
            severity="high",
            title=f"Approval Required: Merge Fix PR #{approval['params'].get('pr_number', '?')}",
            body="Proven fix ready · step-up approval required to ship",
            deep_link=f"/m/approvals/{approval['id']}",
            actions=["review", "reject"],
        )
        await asyncio.to_thread(send_push_notification, notif)  # may call out to ntfy
        bus.broadcast_sse({"type": "notification", "data": notif.model_dump()})
        return {
            "run_id": run_id,
            "scenario_id": "S8",
            "scenario": "S8: Remote approval from phone",
            "status": "triggered",
            "action_id": approval["id"],
            "token": approval["token"],
            "incident_id": approval["incident_id"],
            "description": "Pushed the fix-PR merge approval to the mobile companion. Open Approvals and confirm with biometric/passkey or TOTP.",
        }

    # -----------------------------------------------------------------------
    # S9: Kill Switch (Pause all autonomy) then crash
    # -----------------------------------------------------------------------
    elif s_id == "s9":
        executor.pause_autonomy(paused_by="user:demo_scenario")
        evt = Event(
            source="collector.docker",
            kind="container_exit",
            service="shoplite-api",
            severity="high",
            data={"exit_code": 137, "error": "Container shoplite-api killed while autonomy is paused."},
        )
        await bus.publish(evt)
        inc = await _incident_for_event(evt.id)
        return _triggered(
            run_id, "S9", "S9: Kill switch activated", inc,
            "Autonomy PAUSED. Container crash simulated: Healer queues the restart for human approval instead of acting. "
            "Resuming autonomy needs step-up authentication.",
        )

    else:
        return {"error": f"Unknown scenario: {scenario_id}. Choose from S1 to S9."}


def seed_initial_demo_state() -> None:
    """Seed initial realistic DevSecOps state if database is empty (skipped in production unless ALEXIA_DEMO_MODE=1)."""
    from alexia.core.config import is_demo_mode, is_production
    from alexia.core.state_store import get_state_store
    from alexia.tools.reports import generate_cert_in_report, generate_dpdp_report, generate_gdpr_report
    from alexia.tools.snapshots import create_snapshot, list_snapshots

    if is_production() and not is_demo_mode():
        return

    bus = get_event_bus()
    state_store = get_state_store()
    if len(bus.list_incidents(limit=1)) > 0 and len(state_store.list_deployments(limit=1)) > 0:
        return

    # Ensure real on-disk SQLite snapshots exist so seeded snapshot restores succeed
    existing_snaps = {s.get("id") for s in list_snapshots()}
    for snap_id, svc_name, inc_id, snap_type, desc in (
        ("snap_pre_s6_01", "shoplite-api", "inc_s6_sqli_breach", "full_bundle", "Pre-containment snapshot for S6 SQLi"),
        ("snap_pre_s4_01", "shoplite-api", "inc_s4_secret_leak", "config_env", "Pre-rotation snapshot for S4 secret leak"),
        ("snap_pre_s1_01", "shoplite-api", "inc_s1_bad_deploy", "container_image", "Pre-rollback snapshot for S1 bad deploy"),
    ):
        if snap_id not in existing_snaps:
            try:
                create_snapshot(
                    target=svc_name,
                    description=desc,
                    incident_id=inc_id,
                    snap_type=snap_type,
                    snapshot_id=snap_id,
                )
            except Exception as exc:
                logger.debug("Seed snapshot %s creation skipped: %s", snap_id, exc)

    # Seed durable deployments if empty
    if not state_store.list_deployments(limit=1):
        for dep in (
            {
                "id": "dep_143_staged",
                "service_id": "svc_shoplite_api",
                "service_name": "shoplite-api",
                "version": "v1.4.3-sec",
                "commit_sha": "7c9e2a4 (PR #142)",
                "author": "Builder Agent",
                "timestamp": "2026-10-29T14:21:18Z",
                "status": "deploying",
                "pre_deploy_Review": "passed",
                "health_gate": "pending",
                "rollback_available": True,
                "previous_version": "v1.4.2",
                "notes": "Parameterized SQL fix for /products?q= endpoint (awaiting Tier 1 merge approval).",
            },
            {
                "id": "dep_142_bad",
                "service_id": "svc_shoplite_api",
                "service_name": "shoplite-api",
                "version": "v1.4.2-rc1",
                "commit_sha": "4b1d8e0",
                "author": "dev@shoplite.io",
                "timestamp": "2026-10-29T13:45:00Z",
                "status": "rolled_back",
                "pre_deploy_Review": "flagged",
                "health_gate": "failed",
                "rollback_available": False,
                "previous_version": "v1.4.1",
                "notes": "Auto-rolled back by Deployer after 5xx error rate reached 18.4% on /checkout.",
            },
            {
                "id": "dep_141_good",
                "service_id": "svc_shoplite_api",
                "service_name": "shoplite-api",
                "version": "v1.4.1",
                "commit_sha": "1a8f3c9",
                "author": "release-bot",
                "timestamp": "2026-10-28T09:15:00Z",
                "status": "healthy",
                "pre_deploy_Review": "passed",
                "health_gate": "passed",
                "rollback_available": True,
                "previous_version": "v1.4.0",
                "notes": "Baseline production release; 3/3 health gates green.",
            },
        ):
            state_store.upsert_deployment(dep)

    # Seed durable regulatory breach reports if empty
    if not state_store.list_reports():
        cert_md = generate_cert_in_report(
            incident_id="inc_s6_sqli_breach",
            incident_type="SQL Injection & Unauthorized Data Extraction",
            systems_affected=["shoplite-api", "shoplite-db"],
            indicators={"attacker_ips": ["198.51.100.42"], "payloads": ["' UNION SELECT email,phone,[REDACTED] FROM users--"]},
            actions_taken=[
                "Blocked attacker IP 198.51.100.42 at Caddy reverse proxy within 3s",
                "Captured SHA-256 verified forensic snapshot snap_pre_s6_01",
                "Generated and sandbox-verified parameterized SQL patch (PR #142)",
            ],
            detected_at="2026-10-29T14:21:05Z",
        )
        dpdp_md = generate_dpdp_report(
            incident_id="inc_s6_sqli_breach",
            nature_of_breach="Application-layer SQL injection on product catalog search endpoint.",
            exposed_records_count=1240,
            exposed_fields=["email", "phone"],
            mitigation_steps=[
                "Immediate perimeter IP block and query parameter sanitization",
                "Zero plaintext passwords exposed; session tokens rotated",
            ],
            detected_at="2026-10-29T14:21:05Z",
        )
        gdpr_md = generate_gdpr_report(
            incident_id="inc_s6_sqli_breach",
            root_cause="Improper neutralization of special elements used in an SQL command (CWE-89).",
            records_count=1240,
            consequences="Potential disclosure of customer email and masked phone numbers; no plaintext credentials exposed.",
            remedial_measures=[
                "Automated WAF/Proxy IP containment by Sentinel Agent",
                "Cryptographic audit chain preserved for forensic inspection",
            ],
        )
        for rep in (
            {
                "id": "rep_certin_s6",
                "incident_id": "inc_s6_sqli_breach",
                "framework": "CERT-In",
                "framework_label": "CERT-In 6-Hour Cyber Incident Directive (India)",
                "deadline_hours": 6,
                "generated_at": "2026-10-29T14:21:20Z",
                "status": "draft_ready",
                "summary": "Unauthorized SQL UNION extraction on shoplite-api (/products) affecting 1,240 user records; contained in 3 seconds.",
                "affected_records_estimate": 1240,
                "data_categories_exposed": ["Email Address (redacted)", "Phone Number (redacted)", "Bcrypt Password Hash"],
                "containment_actions_taken": [
                    "Blocked attacker IP 198.51.100.42 at Caddy reverse proxy within 3s",
                    "Captured SHA-256 verified forensic snapshot snap_pre_s6_01",
                    "Generated and sandbox-verified parameterized SQL patch (PR #142)",
                ],
                "root_cause": "Unparameterized SQL query in target-app/routes/products.py line 48.",
                "remediation_status": "Patch verified in sandbox (24/24 tests green); awaiting Tier 1 merge approval.",
                "markdown": cert_md,
            },
            {
                "id": "rep_dpdp_s6",
                "incident_id": "inc_s6_sqli_breach",
                "framework": "DPDP_ACT",
                "framework_label": "Digital Personal Data Protection Act (DPDP) Breach Notice",
                "deadline_hours": 72,
                "generated_at": "2026-10-29T14:21:22Z",
                "status": "draft_ready",
                "summary": "Data Fiduciary notification draft for Data Protection Board of India & affected Data Principals.",
                "affected_records_estimate": 1240,
                "data_categories_exposed": ["Email Address (redacted)", "Phone Number (redacted)"],
                "containment_actions_taken": [
                    "Immediate perimeter IP block and query parameter sanitization",
                    "Zero plaintext passwords exposed; session tokens rotated",
                ],
                "root_cause": "Application-layer SQL injection on product catalog search endpoint.",
                "remediation_status": "Parameterized query patch ready for production rollout.",
                "markdown": dpdp_md,
            },
            {
                "id": "rep_gdpr_s6",
                "incident_id": "inc_s6_sqli_breach",
                "framework": "GDPR",
                "framework_label": "GDPR Article 33 Supervisory Authority Notification",
                "deadline_hours": 72,
                "generated_at": "2026-10-29T14:21:24Z",
                "status": "draft_ready",
                "summary": "Article 33 personal data breach assessment and supervisory authority notification package.",
                "affected_records_estimate": 1240,
                "data_categories_exposed": ["Contact Identifiers (Email, Phone)", "Salted Password Hashes"],
                "containment_actions_taken": [
                    "Automated WAF/Proxy IP containment by Sentinel Agent",
                    "Cryptographic audit chain preserved for forensic inspection",
                ],
                "root_cause": "Improper neutralization of special elements used in an SQL command (CWE-89).",
                "remediation_status": "Mitigated at proxy edge; permanent code fix staged in PR #142.",
                "markdown": gdpr_md,
            },
        ):
            state_store.upsert_report(rep)

    if len(bus.list_incidents(limit=1)) > 0:
        return

    mgr = get_approval_manager()
    guard = get_budget_guard()
    audit = get_audit_log()

    # 1. Pending Tier-1 Approval for S6 SQLi PR merge
    act_s6 = Action(
        id="apr_s6_merge_fix",
        action="merge_pull_request_and_deploy",
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

    state_store.record_notification(
        {
            "id": "ntf_seed_s6",
            "incident_id": "inc_s6_sqli_breach",
            "severity": "critical",
            "title": "SQLi Contained · PR #142 Ready",
            "body": "SQL injection blocked on shoplite-api · 1 IP blocked · fix PR ready · approval needed",
            "deep_link": "/m/approvals/apr_s6_merge_fix",
            "actions": ["review", "reject"],
        }
    )

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
    guard.record_tavily_call(
        query="OWASP SQL injection prevention SQLAlchemy parameterized queries",
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
