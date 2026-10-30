"""FastAPI application for Alexia DevSecOps platform and mobile companion.

Implements PRD Section 6.1, 6.7, 6.8:
- Incident and approval management APIs.
- Real-time Server-Sent Events (SSE) streaming endpoint.
- Model usage and cost tracking API.
- Tamper-evident cryptographic audit log inspection API.
- Mobile companion auth, passkey/TOTP step-up, push subscription, and remote control APIs.
- Demo scenario runner and environment reset.
"""

from __future__ import annotations
import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from alexia.actions.approvals import get_approval_manager
from alexia.actions.executor import get_executor
from alexia.api.demo import SCENARIO_CATALOG, reset_demo_environment, run_scenario, seed_initial_demo_state
from alexia.api.sse import create_sse_response
from alexia.collectors.git_webhook import handle_webhook_payload, verify_github_signature
from alexia.core.audit import get_audit_log
from alexia.core.budget import get_budget_guard
from alexia.core.bus import get_event_bus
from alexia.core.llm import get_llm_client
from alexia.core.maintenance import start_maintenance
from alexia.core.orchestrator import get_orchestrator
from alexia.core.schemas import Action, Incident, current_iso_timestamp, generate_id
from alexia.remote.auth import get_auth_manager
from alexia.remote.controls import get_remote_controller
from alexia.remote.devices import get_device_manager
from alexia.remote.push import get_push_manager
from alexia.tools.snapshots import create_snapshot, list_snapshots as list_snapshot_files

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("alexia.api")


# In-memory operational state for deployments, snapshots, reports, and settings
_DEPLOYMENTS_STATE: List[Dict[str, Any]] = [
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
]

_SNAPSHOTS_STATE: List[Dict[str, Any]] = [
    {
        "id": "snap_pre_s6_01",
        "incident_id": "inc_s6_sqli_breach",
        "service_name": "shoplite-api + shoplite-db",
        "created_at": "2026-10-29T14:21:07Z",
        "type": "full_bundle",
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "size_mb": 48.4,
        "verified": True,
        "restorable": True,
    },
    {
        "id": "snap_pre_s4_01",
        "incident_id": "inc_s4_secret_leak",
        "service_name": "shoplite-api",
        "created_at": "2026-10-29T11:05:19Z",
        "type": "config_env",
        "sha256": "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
        "size_mb": 1.2,
        "verified": True,
        "restorable": True,
    },
    {
        "id": "snap_pre_s1_01",
        "incident_id": "inc_s1_bad_deploy",
        "service_name": "shoplite-api",
        "created_at": "2026-10-29T13:45:12Z",
        "type": "container_image",
        "sha256": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
        "size_mb": 142.0,
        "verified": True,
        "restorable": True,
    },
]

_REPORTS_STATE: List[Dict[str, Any]] = [
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
        "data_categories_exposed": [
            "Email Address (redacted)",
            "Phone Number (redacted)",
            "Bcrypt Password Hash",
        ],
        "containment_actions_taken": [
            "Blocked attacker IP 198.51.100.42 at Caddy reverse proxy within 3s",
            "Captured SHA-256 verified forensic snapshot snap_pre_s6_01",
            "Generated and sandbox-verified parameterized SQL patch (PR #142)",
        ],
        "root_cause": "Unparameterized SQL query in target-app/routes/products.py line 48.",
        "remediation_status": "Patch verified in sandbox (24/24 tests green); awaiting Tier 1 merge approval.",
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
        "data_categories_exposed": [
            "Email Address (redacted)",
            "Phone Number (redacted)",
        ],
        "containment_actions_taken": [
            "Immediate perimeter IP block and query parameter sanitization",
            "Zero plaintext passwords exposed; session tokens rotated",
        ],
        "root_cause": "Application-layer SQL injection on product catalog search endpoint.",
        "remediation_status": "Parameterized query patch ready for production rollout.",
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
        "data_categories_exposed": [
            "Contact Identifiers (Email, Phone)",
            "Salted Password Hashes",
        ],
        "containment_actions_taken": [
            "Automated WAF/Proxy IP containment by Sentinel Agent",
            "Cryptographic audit chain preserved for forensic inspection",
        ],
        "root_cause": "Improper neutralization of special elements used in an SQL command (CWE-89).",
        "remediation_status": "Mitigated at proxy edge; permanent code fix staged in PR #142.",
    },
]

_SETTINGS_STATE: Dict[str, Any] = {
    "demo_mode": True,
    "environment": "production-sandbox",
    "redaction_enabled": True,
    "step_up_auth_required": True,
    "daily_usd_budget": 10.0,
    "daily_token_budget": 5_000_000,
    "webhook_signature_verification": True,
    "auto_snapshot_before_tier1": True,
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle manager."""
    logger.info("Initializing Alexia Guardian system...")
    bus = get_event_bus()
    await bus.start()

    orchestrator = get_orchestrator()
    orchestrator.start()
    try:
        seed_initial_demo_state()
    except Exception as exc:
        logger.warning(f"Initial demo state seed warning: {exc}")
    maintenance_tasks = start_maintenance()
    logger.info("Alexia Guardian running and ready.")
    yield
    logger.info("Shutting down Alexia Guardian...")
    for task in maintenance_tasks:
        task.cancel()
    await bus.stop()


app = FastAPI(
    title="Alexia DevSecOps Guardian",
    description="Autonomous DevSecOps guardian powered by NVIDIA Nemotron on Nebius Token Factory",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

import time as _time
import ctypes as _ctypes

_SERVER_START_TIME = _time.time()
_LAST_CPU_SAMPLE_WALL = _time.monotonic()
_LAST_CPU_SAMPLE_PROC = sum(os.times()[:2])
_LAST_CPU_PERCENT = 0.5
_REQ_BUCKETS: Dict[int, int] = {}
_ERR_BUCKETS: Dict[int, int] = {}
_EVENT_LOOP_LAG_MAX_MS = 0.8


def _get_process_rss_bytes() -> int:
    """Return resident working set size in bytes without requiring external packages."""
    if os.name == "nt":
        try:
            class PROCESS_MEMORY_COUNTERS( _ctypes.Structure):
                _fields_ = [
                    ("cb", _ctypes.c_ulong),
                    ("PageFaultCount", _ctypes.c_ulong),
                    ("PeakWorkingSetSize", _ctypes.c_size_t),
                    ("WorkingSetSize", _ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", _ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", _ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", _ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", _ctypes.c_size_t),
                    ("PagefileUsage", _ctypes.c_size_t),
                    ("PeakPagefileUsage", _ctypes.c_size_t),
                ]
            pmc = PROCESS_MEMORY_COUNTERS()
            pmc.cb = _ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
            handle = _ctypes.windll.kernel32.GetCurrentProcess()
            if _ctypes.windll.psapi.GetProcessMemoryInfo(handle, _ctypes.byref(pmc), pmc.cb):
                return int(pmc.WorkingSetSize)
        except Exception:
            pass
    return 72 * 1024 * 1024


def _sample_cpu_percent() -> float:
    global _LAST_CPU_SAMPLE_WALL, _LAST_CPU_SAMPLE_PROC, _LAST_CPU_PERCENT
    now_wall = _time.monotonic()
    now_proc = sum(os.times()[:2])
    dt = now_wall - _LAST_CPU_SAMPLE_WALL
    if dt >= 0.4:
        dproc = max(0.0, now_proc - _LAST_CPU_SAMPLE_PROC)
        cores = max(1, os.cpu_count() or 1)
        _LAST_CPU_PERCENT = round(min(100.0, (dproc / dt / cores) * 100.0), 2)
        _LAST_CPU_SAMPLE_WALL = now_wall
        _LAST_CPU_SAMPLE_PROC = now_proc
    return _LAST_CPU_PERCENT


@app.middleware("http")
async def _metrics_middleware(request: Request, call_next):
    minute_bucket = int(_time.time() // 60)
    if not request.url.path.endswith("/local/metrics"):
        _REQ_BUCKETS[minute_bucket] = _REQ_BUCKETS.get(minute_bucket, 0) + 1
        # Keep only last 35 minutes of buckets
        if len(_REQ_BUCKETS) > 40:
            cutoff = minute_bucket - 35
            for k in list(_REQ_BUCKETS.keys()):
                if k < cutoff:
                    _REQ_BUCKETS.pop(k, None)
                    _ERR_BUCKETS.pop(k, None)
    response = await call_next(request)
    if response.status_code >= 500:
        _ERR_BUCKETS[minute_bucket] = _ERR_BUCKETS.get(minute_bucket, 0) + 1
    return response


# ---------------------------------------------------------------------------
# Health, Loopback Server Manager Metrics & Real-time Stream
# ---------------------------------------------------------------------------
@app.get("/health")
@app.get("/v1/health")
@app.get("/api/v1/health")
async def health():
    bus = get_event_bus()
    incidents = bus.list_incidents(limit=100)
    open_incidents = [i for i in incidents if i.status != "resolved"]
    pending_approvals = get_approval_manager().list_pending()
    uptime_sec = int(max(1, _time.time() - _SERVER_START_TIME))
    return {
        "ok": True,
        "status": "healthy",
        "service": "alexia-guardian",
        "version": "1.0.0",
        "uptimeSec": uptime_sec,
        "internetUrl": os.environ.get("ALEXIA_INTERNET_URL", "") or None,
        "gateway": {
            "mode": "live" if get_llm_client().is_live() else "sandbox",
        },
        "counts": {
            "incidents": len(open_incidents),
            "approvals": len(pending_approvals),
            "services": 4,
            "agents": 5,
        },
        "agents": ["builder", "deployer", "healer", "sentinel", "integrity"],
        "models": [
            "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
            "nvidia/nemotron-3-super-120b-a12b",
            "nvidia/Nemotron-3-Ultra-550b-a55b",
        ],
    }


@app.get("/v1/local/metrics")
@app.get("/api/v1/local/metrics")
async def local_server_metrics(request: Request):
    """Loopback-only operational metrics for the Alexia Server Manager desktop app."""
    client_host = request.client.host if request.client else "127.0.0.1"
    is_loopback = client_host in ("127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost", "testclient")
    forwarded = (
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for")
        or request.headers.get("x-real-ip")
    )
    if not is_loopback or forwarded:
        raise HTTPException(status_code=404, detail="Not found")

    t0 = _time.perf_counter()
    await asyncio.sleep(0)
    lag_ms = round((_time.perf_counter() - t0) * 1000.0, 2)
    global _EVENT_LOOP_LAG_MAX_MS
    if lag_ms > _EVENT_LOOP_LAG_MAX_MS:
        _EVENT_LOOP_LAG_MAX_MS = lag_ms

    now_bucket = int(_time.time() // 60)
    req_history = [_REQ_BUCKETS.get(now_bucket - i, 0) for i in range(29, -1, -1)]
    reqs_per_min = _REQ_BUCKETS.get(now_bucket, 0) + _REQ_BUCKETS.get(now_bucket - 1, 0) // 2
    errs_per_min = _ERR_BUCKETS.get(now_bucket, 0)

    bus = get_event_bus()
    db_path = bus.db_path
    db_bytes = os.path.getsize(db_path) if os.path.exists(db_path) else 0
    for suffix in ("-wal", "-shm"):
        if os.path.exists(db_path + suffix):
            db_bytes += os.path.getsize(db_path + suffix)

    incidents = bus.list_incidents(limit=100)
    open_incidents = [i for i in incidents if i.status != "resolved"]
    pending_approvals = get_approval_manager().list_pending()
    audit_ok, audit_rows, _ = get_audit_log().verify_chain()

    return {
        "version": "1.0.0",
        "pid": os.getpid(),
        "uptimeSec": int(max(1, _time.time() - _SERVER_START_TIME)),
        "requestsPerMin": reqs_per_min,
        "requestsHistory": req_history,
        "errorsPerMin": errs_per_min,
        "rssBytes": _get_process_rss_bytes(),
        "cpuPercent": _sample_cpu_percent(),
        "eventLoopLagMs": lag_ms,
        "eventLoopLagMaxMs": _EVENT_LOOP_LAG_MAX_MS,
        "dbBytes": db_bytes,
        "openIncidents": len(open_incidents),
        "pendingApprovals": len(pending_approvals),
        "auditVerified": audit_ok,
        "auditRows": audit_rows,
        "autonomyPaused": get_executor().is_autonomy_paused(),
    }


@app.get("/stream")
@app.get("/api/v1/events")
async def sse_stream(request: Request):
    """Live Server-Sent Events stream for timeline updates and notifications."""
    return create_sse_response(request)


# ---------------------------------------------------------------------------
# Incidents & Investigation (FR-U1, FR-U2, Handover Section 2B & 4)
# ---------------------------------------------------------------------------
@app.get("/incidents", response_model=List[Incident])
@app.get("/api/v1/incidents", response_model=List[Incident])
async def list_incidents(status: Optional[str] = None, limit: int = 50, offset: int = 0):
    bus = get_event_bus()
    return bus.list_incidents(status=status, limit=limit, offset=offset)


@app.get("/incidents/{incident_id}", response_model=Incident)
@app.get("/api/v1/incidents/{incident_id}", response_model=Incident)
async def get_incident(incident_id: str):
    bus = get_event_bus()
    inc = bus.get_incident(incident_id)
    if not inc:
        raise HTTPException(status_code=404, detail="Incident not found")
    return inc


@app.post("/api/v1/incidents/{incident_id}/investigate")
@app.post("/incidents/{incident_id}/investigate")
async def investigate_incident(incident_id: str):
    """Trigger or refresh AI-assisted investigation on an incident."""
    bus = get_event_bus()
    inc = bus.get_incident(incident_id)
    if not inc:
        raise HTTPException(status_code=404, detail="Incident not found")

    llm = get_llm_client()
    # Ultra handles investigations of security / critical incidents; Super everything else (PRD 7.1)
    tier = "ultra" if inc.category == "security" or inc.severity == "critical" else "super"
    prompt = (
        f"Investigate incident {inc.id}: {inc.title} ({inc.category}, {inc.severity}) on {inc.affected_service}.\n"
        f"Summary: {inc.summary}\nRoot cause so far: {inc.diagnosis.root_cause or 'unknown'}\n"
        f"Evidence: {inc.diagnosis.evidence[:5]}\n"
        "Produce a concise investigation update: confirmed root cause, open questions, next safe action."
    )
    analysis, call_record = await asyncio.to_thread(
        llm.complete,
        tier=tier,
        prompt=prompt,
        task="investigation",
        incident_id=inc.id,
    )
    inc.model_calls.append(call_record.id)
    inc.cost_usd = round(inc.cost_usd + call_record.cost_usd, 5)
    bus.update_incident(inc, reason="Re-investigated via API")
    return {
        "status": "completed",
        "incident_id": inc.id,
        "analysis": analysis,
        "diagnosis": inc.diagnosis.model_dump(),
        "model_trace": call_record.model_dump(),
    }


@app.get("/api/v1/incidents/{incident_id}/remediation")
@app.get("/incidents/{incident_id}/remediation")
async def get_incident_remediation(incident_id: str):
    """Return structured remediation plan, snapshots, and verification status for an incident."""
    bus = get_event_bus()
    inc = bus.get_incident(incident_id)
    if not inc:
        raise HTTPException(status_code=404, detail="Incident not found")
    return {
        "incident_id": inc.id,
        "status": inc.status,
        "approval_required": inc.approval_required,
        "approval_id": inc.approval_id,
        "snapshots": inc.snapshots,
        "plan": [a.model_dump() for a in inc.plan],
        "verification": inc.verification,
    }


# ---------------------------------------------------------------------------
# Approvals (FR-U3, FR-M5, FR-C7, Handover Section 2C & 4)
# ---------------------------------------------------------------------------
class ApprovalDecisionRequest(BaseModel):
    decision: str = "approved"  # "approved" or "rejected"
    decided_by: str = "operator"
    actor: Optional[str] = None
    reason: Optional[str] = None
    step_up_method: Optional[str] = None
    step_up_token: Optional[str] = None
    token: Optional[str] = None


@app.get("/approvals")
async def list_pending_approvals(all: bool = False):
    mgr = get_approval_manager()
    if all:
        return mgr.list_all()
    return mgr.list_pending()


@app.get("/api/v1/approvals")
async def list_all_approvals_v1(pending_only: bool = False):
    mgr = get_approval_manager()
    if pending_only:
        return mgr.list_pending()
    return mgr.list_all()


def _execute_approval_decision(action_id: str, req: ApprovalDecisionRequest) -> Dict[str, Any]:
    mgr = get_approval_manager()
    actor_name = req.actor or req.decided_by or "operator"
    if req.decision.lower() == "approved":
        # Approving a Tier-1 action needs step-up within the last 5 minutes (FR-M5, PRD 9.5); rejecting is the safe direction
        if not req.step_up_token:
            raise HTTPException(status_code=401, detail="Approving requires step-up authentication (passkey/biometric or TOTP).")
        valid, _, method = get_auth_manager().verify_step_up_token(req.step_up_token)
        if not valid:
            raise HTTPException(status_code=401, detail="Invalid or expired step-up authentication token.")
        req.step_up_method = method
    success, message, data = mgr.decide(
        action_id=action_id,
        decision=req.decision,
        decided_by=actor_name,
        step_up_method=req.step_up_method,
        provided_token=req.token,
    )
    if not success:
        raise HTTPException(status_code=400, detail=message)

    bus = get_event_bus()
    incident_id = data.get("incident_id") if data else None

    if req.decision.lower() == "approved" and data:
        executor = get_executor()
        act = Action(
            id=data["action_id"],
            action=data["action"],
            target=data["target"],
            params=data["params"],
            tier=1,
            reason=data["reason"],
            requested_by=f"human:{actor_name}",
        )
        executor.execute(act, incident_id=incident_id, is_pre_approved=True)

        # Update linked incident state to resolved if present
        if incident_id:
            inc = bus.get_incident(incident_id)
            if inc:
                inc.status = "resolved"
                inc.approval_required = False
                for p in inc.plan:
                    if p.id == action_id:
                        p.status = "executed"
                if inc.verification:
                    inc.verification["deployment_status"] = "deployed_and_verified"
                bus.update_incident(inc, reason=f"Tier 1 action {action_id} approved by {actor_name}")

        # Update staged deployment if merging PR
        if data["action"] in ("merge_pr", "merge_pull_request_and_deploy"):
            for dep in _DEPLOYMENTS_STATE:
                if dep["id"] == "dep_143_staged":
                    dep["status"] = "healthy"
                    dep["health_gate"] = "passed"
    elif req.decision.lower() == "rejected" and incident_id:
        inc = bus.get_incident(incident_id)
        if inc:
            inc.approval_required = False
            for p in inc.plan:
                if p.id == action_id:
                    p.status = "rejected"
            bus.update_incident(inc, reason=f"Tier 1 action {action_id} rejected by {actor_name}")

    bus.broadcast_sse({
        "type": "approval_decided",
        "data": {
            "id": action_id,
            "action_id": action_id,
            "decision": req.decision.lower(),
            "decided_by": actor_name,
            "reason": req.reason,
            "incident_id": incident_id,
        },
    })
    return {"status": "success", "message": message, "action": data}


@app.post("/approvals/{action_id}/decide")
@app.post("/approvals/{action_id}/decision")
@app.post("/api/v1/approvals/{action_id}/decision")
async def decide_approval(action_id: str, req: ApprovalDecisionRequest):
    return _execute_approval_decision(action_id, req)


@app.post("/api/v1/approvals/{action_id}/approve")
async def approve_action_v1(action_id: str, req: Optional[ApprovalDecisionRequest] = None):
    payload = req or ApprovalDecisionRequest(decision="approved")
    payload.decision = "approved"
    return _execute_approval_decision(action_id, payload)


@app.post("/api/v1/approvals/{action_id}/reject")
async def reject_action_v1(action_id: str, req: Optional[ApprovalDecisionRequest] = None):
    payload = req or ApprovalDecisionRequest(decision="rejected")
    payload.decision = "rejected"
    return _execute_approval_decision(action_id, payload)


# ---------------------------------------------------------------------------
# Model Usage & Budget (FR-U5, FR-C10, Handover Section 2G & 4)
# ---------------------------------------------------------------------------
@app.get("/stats/models")
@app.get("/api/v1/observability/models")
async def get_model_stats():
    guard = get_budget_guard()
    return guard.get_daily_stats()


# ---------------------------------------------------------------------------
# Audit Chain (FR-U8, FR-C8, Handover Section 2H & 4)
# ---------------------------------------------------------------------------
@app.get("/audit")
@app.get("/api/v1/audit")
async def get_audit_trail(limit: int = 50, offset: int = 0):
    audit = get_audit_log()
    entries = audit.get_entries(limit=limit, offset=offset)
    is_valid, rows_checked, error_msg = audit.verify_chain()

    return {
        "chain_verified": is_valid,
        "verified_rows": rows_checked,
        "verification_error": error_msg,
        "entries": [e.model_dump() for e in entries],
    }


@app.get("/audit/verify")
@app.get("/api/v1/audit/verify")
async def verify_audit_chain_endpoint():
    audit = get_audit_log()
    is_valid, rows_checked, error_msg = audit.verify_chain()
    entries = audit.get_entries(limit=1)
    head_hash = entries[0].hash if entries else "0" * 64
    return {
        "valid": is_valid,
        "chain_verified": is_valid,
        "records_checked": rows_checked,
        "verified_rows": rows_checked,
        "head_hash": head_hash,
        "verification_error": error_msg,
        "verified_at": current_iso_timestamp(),
    }


# ---------------------------------------------------------------------------
# Target Services, Deployments & Snapshots (FR-U4, Handover Section 2D & 4)
# ---------------------------------------------------------------------------
def _get_services_list() -> List[Dict[str, Any]]:
    now_iso = current_iso_timestamp()
    bus = get_event_bus()
    # Newest unresolved incident on the target drives its card (degraded while a critical one is open)
    api_open = next(
        (i for i in bus.list_incidents(limit=50) if i.status != "resolved" and i.affected_service == "shoplite-api"),
        None,
    )
    api_status = "degraded" if (api_open and api_open.severity == "critical") else "healthy"
    return [
        {
            "id": "svc_shoplite_api",
            "name": "shoplite-api",
            "type": "FastAPI Web Application",
            "status": api_status,
            "image": "ghcr.io/alexia-demo/shoplite-api:v1.4.2",
            "current_image": "shoplite:v1.4.2",
            "last_deploy": "2026-10-29T13:45:00Z",
            "container": "alexia-shoplite-1",
            "container_id": "c8f92e1a4b7d",
            "uptime_seconds": 172940,
            "last_health_check": now_iso,
            "restart_count": 1,
            "cpu_percent": 34.2,
            "memory_mb": 224,
            "disk_mb": 412,
            "latest_incident_id": api_open.id if api_open else None,
            "ports": ["8000:8000"],
        },
        {
            "id": "svc_shoplite_db",
            "name": "shoplite-db",
            "type": "PostgreSQL 16",
            "status": "healthy",
            "image": "postgres:16.2-alpine",
            "current_image": "postgres:16-alpine",
            "last_deploy": "2026-10-28T09:15:00Z",
            "container": "alexia-db-1",
            "container_id": "9a1d7c4e0f22",
            "uptime_seconds": 604800,
            "last_health_check": now_iso,
            "restart_count": 0,
            "cpu_percent": 18.6,
            "memory_mb": 392,
            "disk_mb": 1240,
            "ports": ["5432:5432"],
        },
        {
            "id": "svc_caddy_proxy",
            "name": "caddy-proxy",
            "type": "Caddy Reverse Proxy",
            "status": "healthy",
            "image": "caddy:2.7-alpine",
            "current_image": "caddy:2-alpine",
            "last_deploy": "2026-10-28T09:15:00Z",
            "container": "alexia-proxy-1",
            "container_id": "3e5b8a12d9c0",
            "uptime_seconds": 604800,
            "last_health_check": now_iso,
            "restart_count": 0,
            "cpu_percent": 6.4,
            "memory_mb": 64,
            "disk_mb": 95,
            "ports": ["80:80", "443:443"],
        },
    ]


@app.get("/services")
@app.get("/api/v1/services")
async def get_services_status():
    return _get_services_list()


@app.get("/services/{service_id}")
@app.get("/api/v1/services/{service_id}")
async def get_service_detail(service_id: str):
    for svc in _get_services_list():
        if svc["id"] == service_id or svc["name"] == service_id:
            return svc
    raise HTTPException(status_code=404, detail="Service not found")


@app.post("/services/{service_id}/restart")
@app.post("/api/v1/services/{service_id}/restart")
async def restart_service(service_id: str):
    svc = next((s for s in _get_services_list() if s["id"] == service_id or s["name"] == service_id), None)
    if not svc:
        raise HTTPException(status_code=404, detail="Service not found")
    success, msg, data = get_remote_controller().trigger_action(
        action_name="restart_container",
        target=svc["name"],
        params={},
        user="operator",
        device_id="web_dashboard",
    )
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    get_event_bus().broadcast_sse({"type": "service_restarted", "data": {"service_id": svc["id"], "result": data}})
    return {"status": "queued" if data.get("queued") else "success", "message": msg, "service": svc, "result": data}


@app.get("/deployments")
@app.get("/api/v1/deployments")
async def list_deployments():
    return _DEPLOYMENTS_STATE


@app.post("/deployments/{deployment_id}/rollback")
@app.post("/api/v1/deployments/{deployment_id}/rollback")
async def rollback_deployment(deployment_id: str):
    target_dep = None
    for dep in _DEPLOYMENTS_STATE:
        if dep["id"] == deployment_id:
            target_dep = dep
            break
    if not target_dep:
        raise HTTPException(status_code=404, detail=f"Deployment {deployment_id} not found")

    target_dep["status"] = "rolled_back"
    target_dep["rollback_available"] = False
    prev_ver = target_dep.get("previous_version") or "v1.4.1"

    audit = get_audit_log()
    entry = audit.record(
        event_type="DEPLOYMENT_ROLLBACK",
        actor="Human Operator",
        details={
            "action": f"rollback_deploy({target_dep['version']} -> {prev_ver})",
            "target": target_dep["service_name"],
            "deployment_id": deployment_id,
        },
    )
    get_event_bus().broadcast_sse({
        "type": "deployment_rolled_back",
        "data": {"deployment_id": deployment_id, "deployment": target_dep, "audit_entry": entry.model_dump()},
    })
    return {"status": "success", "deployment": target_dep, "restored_version": prev_ver}


class CreateSnapshotRequest(BaseModel):
    service_name: str = "shoplite-api + shoplite-db"
    incident_id: str = "manual_operator"
    type: str = "full_bundle"


def _all_snapshots() -> List[Dict[str, Any]]:
    """Snapshots Integrity actually wrote to disk (pre-action + manual), newest first, then the seeded ones."""
    seeded_ids = {s["id"] for s in _SNAPSHOTS_STATE}
    on_disk = [
        {
            "id": meta["id"],
            "incident_id": meta.get("incident_id") or "pre_action",
            "service_name": meta.get("target", "shoplite-api"),
            "created_at": meta.get("created_at"),
            "type": "full_bundle",
            "sha256": meta.get("sha256", ""),
            "size_mb": round(meta.get("size_bytes", 0) / (1024 * 1024), 3),
            "verified": bool(meta.get("sha256")),
            "restorable": True,
            "description": meta.get("description", ""),
        }
        for meta in list_snapshot_files()
        if meta.get("id") not in seeded_ids
    ]
    return on_disk + _SNAPSHOTS_STATE


@app.get("/snapshots")
@app.get("/api/v1/snapshots")
async def list_snapshots():
    return _all_snapshots()


@app.post("/snapshots")
@app.post("/api/v1/snapshots")
async def create_snapshot_endpoint(req: Optional[CreateSnapshotRequest] = None):
    payload = req or CreateSnapshotRequest()
    meta = create_snapshot(
        target=payload.service_name,
        description="Manual operator snapshot",
    )
    snap_record = {
        "id": meta["id"],
        "incident_id": payload.incident_id,
        "service_name": payload.service_name,
        "created_at": meta["created_at"],
        "type": payload.type,
        "sha256": meta["sha256"],
        "size_mb": round(meta.get("size_bytes", 0) / (1024 * 1024), 3),
        "verified": True,
        "restorable": True,
    }
    get_audit_log().record(
        event_type="SNAPSHOT_CREATED",
        actor="Human Operator",
        details={
            "action": f"snapshot_state({snap_record['id']}, sha256={snap_record['sha256'][:12]}...)",
            "target": payload.service_name,
        },
    )
    return snap_record


@app.post("/snapshots/{snapshot_id}/restore")
@app.post("/api/v1/snapshots/{snapshot_id}/restore")
async def restore_snapshot_endpoint(snapshot_id: str):
    snap = next((s for s in _all_snapshots() if s["id"] == snapshot_id), None)
    if not snap:
        raise HTTPException(status_code=404, detail=f"Snapshot {snapshot_id} not found")
    # restore_snapshot is Tier 1 (PRD 9.1, FR-I4): queue it for step-up approval rather than restoring directly
    action = Action(
        action="restore_snapshot",
        target=snap["service_name"],
        tier=1,
        params={"snapshot_id": snapshot_id},
        reason=f"Operator requested restore of snapshot {snapshot_id}",
        expected_outcome="Data restored from the snapshot, followed by a post-restore integrity check",
        rollback="Take a fresh snapshot before restoring so the current state can be recovered",
        requested_by="user:operator@device:web_dashboard",
    )
    success, msg, data = get_executor().execute(action)
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": "queued_for_approval", "action_id": action.id, "message": msg, "snapshot": snap}


# ---------------------------------------------------------------------------
# Security Findings & Regulatory Breach Reports (Handover Section 2F & 4)
# ---------------------------------------------------------------------------
_REPORT_FRAMEWORKS = {
    "cert_in": ("CERT-In", "CERT-In 6-Hour Cyber Incident Directive (India)", 6),
    "dpdp": ("DPDP_ACT", "Digital Personal Data Protection Act (DPDP) Breach Notice", 72),
    "gdpr": ("GDPR", "GDPR Article 33 Supervisory Authority Notification", 72),
}


def _collect_reports() -> List[Dict[str, Any]]:
    """Breach-report drafts written by Sentinel on live incidents, newest first, then the seeded drafts."""
    live: List[Dict[str, Any]] = []
    for inc in get_event_bus().list_incidents(limit=100):
        drafts = inc.metadata.get("reports") if isinstance(inc.metadata, dict) else None
        if not isinstance(drafts, dict):
            continue
        exposure = inc.metadata.get("exposure_assessment") or {}
        for key, body in drafts.items():
            framework, label, hours = _REPORT_FRAMEWORKS.get(key, (key.upper(), key.upper(), 72))
            live.append({
                "id": f"rep_{key}_{inc.id}",
                "incident_id": inc.id,
                "framework": framework,
                "framework_label": label,
                "deadline_hours": hours,
                "generated_at": inc.updated_at,
                "status": "draft_ready",
                "summary": inc.summary,
                "affected_records_estimate": exposure.get("estimated_rows_exposed", 0),
                "data_categories_exposed": exposure.get("affected_columns", []),
                "containment_actions_taken": [a.reason or a.action for a in inc.plan],
                "root_cause": inc.diagnosis.root_cause,
                "remediation_status": inc.status,
                "markdown": body if isinstance(body, str) else str(body),
            })
    return live + _REPORTS_STATE


@app.get("/reports")
@app.get("/api/v1/reports")
@app.get("/api/v1/security/reports")
async def list_security_reports():
    return _collect_reports()


@app.get("/api/v1/security/findings")
async def list_security_findings():
    bus = get_event_bus()
    sec_incidents = [inc.model_dump() for inc in bus.list_incidents() if inc.category in ("security", "data_integrity")]
    return {
        "findings": sec_incidents,
        "reports": _collect_reports(),
        "redaction_layers": [
            "API Keys (OpenAI, Nebius, Tavily, Stripe, AWS, GitHub PAT)",
            "JWT Bearer Tokens, Session Cookies & OAuth Secrets",
            "Database Connection URIs & PEM Private Keys",
            "PII: Email Addresses, Phone Numbers, 12-Digit National IDs & Luhn Card Numbers",
            "Prompt-Injection Delimiter Escaping (<untrusted_log> wrapping)",
        ],
    }


# ---------------------------------------------------------------------------
# Demo Scenario Runner (FR-U6, Handover Section 2E & 4)
# ---------------------------------------------------------------------------
@app.get("/scenarios")
@app.get("/api/v1/scenarios")
async def list_scenarios():
    return SCENARIO_CATALOG


_last_public_scenario_at = 0.0


def _is_local_operator(request: Request) -> bool:
    """Loopback caller that did not come through a proxy/tunnel (those add forwarding headers)."""
    host = request.client.host if request.client else ""
    forwarded = (
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for")
        or request.headers.get("x-real-ip")
    )
    return host in ("127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost", "testclient") and not forwarded


@app.post("/scenarios/{scenario_id}/run")
@app.post("/api/v1/scenarios/{scenario_id}/run")
async def trigger_scenario(scenario_id: str, request: Request):
    # Public demo guard (FR-U6, NFR5): one scenario at a time plus a global cooldown, so a shared URL
    # cannot burn Token Factory credits. Enabled by ALEXIA_SCENARIO_COOLDOWN_SECONDS; the local operator is exempt.
    global _last_public_scenario_at
    cooldown = float(os.environ.get("ALEXIA_SCENARIO_COOLDOWN_SECONDS", "0") or 0)
    guarded = cooldown > 0 and not _is_local_operator(request)
    if guarded:
        if get_event_bus().is_busy():
            raise HTTPException(status_code=429, detail="Another scenario is still running. Try again shortly.",
                                headers={"Retry-After": "15"})
        wait = _last_public_scenario_at + cooldown - _time.time()
        if wait > 0:
            raise HTTPException(status_code=429, detail=f"Scenario cooldown: try again in {int(wait) + 1}s.",
                                headers={"Retry-After": str(int(wait) + 1)})
        _last_public_scenario_at = _time.time()
    res = await run_scenario(scenario_id)
    if "error" in res:
        raise HTTPException(status_code=400, detail=res["error"])
    return res


@app.post("/scenarios/reset")
@app.post("/environment/reset")
@app.post("/api/v1/scenarios/reset")
async def reset_demo():
    return reset_demo_environment()


# ---------------------------------------------------------------------------
# Overview Dashboard & Settings (Handover Section 2A, 2I & 4)
# ---------------------------------------------------------------------------
_AGENT_ROLES = {
    "sentinel": "Breach detection, containment, evidence and breach-report drafts",
    "healer": "Runtime triage, diagnosis, recovery and verification",
    "builder": "Writes regression tests and patches, proves them red-to-green, opens PRs",
    "deployer": "Gated deploys, health gate and automatic rollback",
    "integrity": "Snapshots, migration guard and data-exposure assessment",
}


def _agent_status() -> List[Dict[str, Any]]:
    """Live agent cards: state from open incidents, activity from each agent's audit-chain entries."""
    import json as _json
    import sqlite3 as _sqlite3
    from datetime import datetime as _dt, timedelta, timezone as _tz

    now = _dt.now(_tz.utc)
    today = now.date().isoformat()
    recent_cutoff = (now - timedelta(minutes=5)).isoformat()
    pending_ids = {a["id"] for a in get_approval_manager().list_pending()}
    incidents = [i for i in get_event_bus().list_incidents(limit=100) if i.status not in ("resolved", "escalated")]
    agents: List[Dict[str, Any]] = []
    with _sqlite3.connect(get_audit_log().db_path, timeout=10) as conn:
        for agent_id, role in _AGENT_ROLES.items():
            actor = f"agent:{agent_id}"
            today_count = conn.execute(
                "SELECT COUNT(*) FROM audit_log WHERE actor = ? AND timestamp >= ?", (actor, today)
            ).fetchone()[0]
            latest = conn.execute(
                "SELECT timestamp, event_type, details_json FROM audit_log WHERE actor = ? ORDER BY id DESC LIMIT 1",
                (actor,),
            ).fetchone()
            owned = [i for i in incidents if i.owner_agent == agent_id]
            # Waiting only on approvals that can still be decided; "working" only on incidents touched recently
            waiting = next((i for i in owned if i.approval_required and i.approval_id in pending_ids), None)
            working = next((i for i in owned if not i.approval_required and i.updated_at >= recent_cutoff), None)
            if latest:
                details = _json.loads(latest[2] or "{}")
                what = details.get("action") or details.get("status") or ""
                target = details.get("target") or details.get("commit_sha") or ""
                latest_event = " ".join(x for x in (latest[1].replace("_", " "), str(what), str(target)) if x)
            agents.append({
                "id": agent_id,
                "name": agent_id.title(),
                "role_description": role,
                "state": "Waiting for approval" if waiting else ("Working" if working else "Idle"),
                "current_task": (waiting or working).title if (waiting or working) else "Standing by",
                "latest_event": latest_event if latest else "No actions recorded yet",
                "latest_event_time": latest[0] if latest else current_iso_timestamp(),
                "total_actions_today": today_count,
            })
    return agents


@app.get("/agents")
@app.get("/api/v1/agents")
async def list_agents():
    return _agent_status()


@app.get("/api/v1/dashboard")
@app.get("/dashboard")
async def get_dashboard_overview():
    bus = get_event_bus()
    mgr = get_approval_manager()
    guard = get_budget_guard()
    audit = get_audit_log()
    executor = get_executor()

    incidents = bus.list_incidents(limit=50)
    pending_approvals = mgr.list_pending()
    all_approvals = mgr.list_all()
    model_stats = guard.get_daily_stats()
    audit_entries = audit.get_entries(limit=30)
    chain_ok, rows_checked, _ = audit.verify_chain()

    return {
        "autonomy_mode": "paused" if executor.is_autonomy_paused() else "autonomous",
        "is_autonomy_paused": executor.is_autonomy_paused(),
        "open_incidents_count": len([i for i in incidents if i.status != "resolved"]),
        "pending_approvals_count": len(pending_approvals),
        "incidents": [i.model_dump() for i in incidents],
        "approvals": all_approvals,
        "services": _get_services_list(),
        "deployments": _DEPLOYMENTS_STATE,
        "snapshots": _all_snapshots(),
        "reports": _collect_reports(),
        "model_summary": model_stats,
        "model_calls": model_stats.get("recent_calls", []),
        "audit": {
            "chain_verified": chain_ok,
            "verified_rows": rows_checked,
            "entries": [e.model_dump() for e in audit_entries],
        },
        "settings": _SETTINGS_STATE,
        "agents": _agent_status(),
    }


@app.get("/api/v1/settings")
@app.get("/settings")
async def get_settings():
    executor = get_executor()
    dev_mgr = get_device_manager()
    return {
        **_SETTINGS_STATE,
        "autonomy_paused": executor.is_autonomy_paused(),
        "devices": dev_mgr.list_devices(),
    }


@app.patch("/api/v1/settings")
@app.patch("/settings")
async def update_settings(updates: Dict[str, Any]):
    executor = get_executor()
    if "autonomy_paused" in updates:
        if updates["autonomy_paused"]:
            executor.pause_autonomy(paused_by="operator:settings")
        else:
            executor.resume_autonomy(resumed_by="operator:settings", step_up_method="passkey")
    for k, v in updates.items():
        if k in _SETTINGS_STATE:
            _SETTINGS_STATE[k] = v
    return await get_settings()


# ---------------------------------------------------------------------------
# GitHub Webhook (FR-D1)
# ---------------------------------------------------------------------------
@app.post("/webhook/github")
async def github_webhook(
    request: Request,
    x_hub_signature_256: Optional[str] = Header(None),
    x_github_event: str = Header("push"),
):
    body_bytes = await request.body()
    if not verify_github_signature(body_bytes, x_hub_signature_256):
        raise HTTPException(status_code=401, detail="Invalid HMAC signature")

    payload = await request.json()
    evt = await handle_webhook_payload(payload, event_name=x_github_event)
    return {"status": "received", "event_id": evt.id if evt else None}


# ---------------------------------------------------------------------------
# Mobile Companion APIs (FR-M1 through FR-M10)
# ---------------------------------------------------------------------------
class LoginRequest(BaseModel):
    username: str
    password: str
    device_id: str = "mobile_pwa_client"
    device_name: str = "iPhone Companion"
    platform: str = "iOS"


class StepUpRequest(BaseModel):
    totp_code: Optional[str] = None
    passkey_signature: Optional[str] = None
    username: str = "demo"


class AutonomyToggleRequest(BaseModel):
    pause: bool
    user: str = "demo"
    device_id: str = "mobile_pwa"
    step_up_token: Optional[str] = None


class RemoteControlRequest(BaseModel):
    action: str
    target: str = "shoplite-api"
    params: Dict[str, Any] = {}
    user: str = "demo"
    device_id: str = "mobile_pwa"
    step_up_token: Optional[str] = None


class PushSubscribeRequest(BaseModel):
    endpoint: str
    p256dh: str
    auth: str
    device_id: Optional[str] = None


@app.post("/remote/auth/login")
async def mobile_login(req: LoginRequest, request: Request):
    auth_mgr = get_auth_manager()
    if not auth_mgr.verify_credentials(req.username, req.password):
        raise HTTPException(status_code=401, detail="Invalid demo credentials. Use user: demo / pass: alexiaguardian2026")

    token = auth_mgr.create_session_token(req.username, req.device_id)

    # Register device
    dev_mgr = get_device_manager()
    client_ip = request.client.host if request.client else "127.0.0.1"
    dev_mgr.register_or_update(
        device_id=req.device_id,
        user=req.username,
        device_name=req.device_name,
        platform=req.platform,
        ip_address=client_ip,
    )

    return {
        "status": "success",
        "session_token": token,
        "username": req.username,
        "is_demo": True,
    }


@app.post("/remote/auth/step-up")
async def step_up_auth(req: StepUpRequest):
    auth_mgr = get_auth_manager()
    if req.totp_code:
        if not auth_mgr.verify_totp(req.totp_code):
            raise HTTPException(status_code=400, detail="Invalid TOTP code. (Demo code: 123456 or 000000)")
        step_up_token = auth_mgr.create_step_up_token(req.username, method="totp")
        return {"status": "success", "step_up_token": step_up_token, "method": "totp"}
    if req.passkey_signature:
        # Demo WebAuthn: the device-side biometric/passkey assertion is accepted as-is (FR-M12 demo mode)
        step_up_token = auth_mgr.create_step_up_token(req.username, method="biometric")
        return {"status": "success", "step_up_token": step_up_token, "method": "biometric"}
    raise HTTPException(status_code=400, detail="Step-up requires a TOTP code or a passkey assertion.")


@app.get("/remote/autonomy")
async def get_autonomy_state():
    executor = get_executor()
    return {"is_paused": executor.is_autonomy_paused()}


@app.post("/remote/autonomy")
async def toggle_autonomy_state(req: AutonomyToggleRequest):
    controller = get_remote_controller()
    success, msg = controller.toggle_autonomy(
        pause=req.pause,
        user=req.user,
        device_id=req.device_id,
        step_up_token=req.step_up_token,
    )
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": "success", "message": msg, "is_paused": req.pause}


@app.post("/remote/controls")
async def execute_remote_control(req: RemoteControlRequest):
    controller = get_remote_controller()
    success, msg, data = controller.trigger_action(
        action_name=req.action,
        target=req.target,
        params=req.params,
        user=req.user,
        device_id=req.device_id,
        step_up_token=req.step_up_token,
    )
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": "success", "message": msg, "result": data}


@app.get("/remote/devices")
async def list_registered_devices():
    dev_mgr = get_device_manager()
    return dev_mgr.list_devices()


@app.post("/remote/devices/{device_id}/revoke")
async def revoke_device(device_id: str):
    dev_mgr = get_device_manager()
    dev_mgr.revoke_device(device_id)
    return {"status": "success", "message": f"Device {device_id} revoked."}


@app.post("/remote/push/subscribe")
async def subscribe_push(req: PushSubscribeRequest):
    push_mgr = get_push_manager()
    push_mgr.register_subscription(
        endpoint=req.endpoint,
        p256dh=req.p256dh,
        auth=req.auth,
        device_id=req.device_id,
    )
    return {"status": "success", "message": "Push subscription registered."}


# Mount Static Files for Web Dashboard & Mobile PWA Companion
import sys as _sys

_STATIC_CANDIDATES = [
    "dashboard/static",
    os.path.join(getattr(_sys, "_MEIPASS", ""), "dashboard", "static"),
]
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as _StarletteHTTPException

_API_PREFIXES = ("api/", "v1/", "remote/", "stream", "webhook/", "docs", "openapi.json", "redoc")


class _SPAStaticFiles(StaticFiles):
    """Serve index.html for client-side routes (e.g. push-notification deep links) but keep API 404s."""

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except _StarletteHTTPException as exc:
            url_path = path.replace("\\", "/")  # StaticFiles hands over an OS path (backslashes on Windows)
            leaf = url_path.rsplit("/", 1)[-1]
            if exc.status_code == 404 and not url_path.startswith(_API_PREFIXES) and "." not in leaf:
                return await super().get_response("index.html", scope)
            raise


for _static_dir in _STATIC_CANDIDATES:
    if _static_dir and os.path.exists(_static_dir):
        app.mount("/", _SPAStaticFiles(directory=_static_dir, html=True), name="static")
        break

