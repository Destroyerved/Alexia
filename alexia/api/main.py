"""FastAPI application for Alexia DevSecOps platform and mobile companion.

Implements PRD Section 6.1, 6.7, 6.8, and Section 9 security controls:
- Incident, remediation, and rate-limited AI investigation APIs.
- Tier-1 approval management with step-up verification and single-use tokens.
- Real-time Server-Sent Events (SSE) streaming with Last-Event-ID replay.
- Model usage, per-tier breakdown, and daily budget accounting API.
- Tamper-evident cryptographic SHA-256 + HMAC-SHA256 audit ledger inspection API.
- Operator session auth, RBAC, TOTP, WebAuthn passkeys, VAPID Web Push, and remote controls.
- Durable SQLite state for deployments, snapshots, regulatory reports, notifications, and settings.
- Security headers, CORS origin policy, request body size cap, and proxy-aware loopback checks.
"""

from __future__ import annotations

import asyncio
import ctypes as _ctypes
import json as _json
import logging
import os
import sqlite3 as _sqlite3
import sys as _sys
import time as _time
from contextlib import asynccontextmanager
from datetime import datetime as _dt, timedelta, timezone as _tz
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as _StarletteHTTPException

from alexia.actions.approvals import get_approval_manager
from alexia.actions.executor import get_executor
from alexia.agents.contracts import validate_agent_contracts
from alexia.agents.deployer import get_deployer_agent
from alexia.agents.integrity import get_integrity_agent
from alexia.api.demo import (
    SCENARIO_CATALOG,
    reset_demo_environment,
    run_scenario,
    seed_initial_demo_state,
)
from alexia.api.sse import create_sse_response
from alexia.collectors.git_webhook import handle_webhook_payload, verify_github_signature
from alexia.collectors.supervisor import get_collector_supervisor
from alexia.core.audit import get_audit_log
from alexia.core.budget import get_budget_guard
from alexia.core.bus import get_event_bus
from alexia.core.config import (
    cors_origins,
    enable_api_docs,
    env_name,
    is_demo_mode,
    is_production,
    public_readonly,
    require_api_auth,
    scenario_cooldown_seconds,
    validate_production_config,
)
from alexia.core.llm import get_llm_client
from alexia.core.maintenance import start_maintenance
from alexia.core.orchestrator import get_orchestrator
from alexia.core.schemas import Action, Incident, current_iso_timestamp
from alexia.core.state_store import get_state_store
from alexia.remote.auth import get_auth_manager
from alexia.remote.controls import get_remote_controller
from alexia.remote.devices import get_device_manager
from alexia.remote.push import get_push_manager
from alexia.tools.reports import render_report_html
from alexia.tools.snapshots import (
    create_snapshot,
    list_snapshots as list_snapshot_files,
    verify_snapshot,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("alexia.api")

MAX_REQUEST_BODY_BYTES = int(os.environ.get("ALEXIA_MAX_BODY_BYTES", str(2 * 1024 * 1024)))
_INVESTIGATE_LAST_AT: Dict[str, float] = {}
_last_public_scenario_at: float = 0.0


def _ensure_seeded_state() -> None:
    """Ensure demo deployments/reports/snapshots are populated in dev/demo mode even when TestClient skips lifespan."""
    if is_production() and not is_demo_mode():
        return
    store = get_state_store()
    if not store.list_deployments(limit=1):
        try:
            seed_initial_demo_state()
        except Exception as exc:
            logger.debug("Lazy demo state seed skipped: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle manager."""
    logger.info("Initializing Alexia Guardian system (env=%s)...", env_name())
    cfg_ok, cfg_warnings = validate_production_config()
    for warning in cfg_warnings:
        logger.warning("Production config check: %s", warning)
    if not cfg_ok:
        raise RuntimeError("Strict startup aborted due to insecure production secrets: " + "; ".join(cfg_warnings))

    bus = get_event_bus()
    await bus.start()

    orchestrator = get_orchestrator()
    contract_errors = validate_agent_contracts()
    if contract_errors:
        raise RuntimeError("Agent contract validation failed: " + "; ".join(contract_errors))
    orchestrator.start()
    try:
        seed_initial_demo_state()
    except Exception as exc:
        logger.warning(f"Initial demo state seed warning: {exc}")
    try:
        recovered = await orchestrator.recover_unprocessed_events()
        if recovered:
            logger.info("Recovered %d in-flight telemetry event(s) on startup.", recovered)
    except Exception as exc:
        logger.warning("In-flight event recovery warning: %s", exc)

    maintenance_tasks = start_maintenance()
    collectors = get_collector_supervisor()
    collectors.start()
    logger.info("Alexia Guardian running and ready.")
    yield
    logger.info("Shutting down Alexia Guardian...")
    await collectors.stop()
    for task in maintenance_tasks:
        task.cancel()
    await bus.stop()


_docs_enabled = enable_api_docs()
app = FastAPI(
    title="Alexia DevSecOps Guardian",
    description="Autonomous DevSecOps guardian powered by NVIDIA Nemotron on Nebius Token Factory",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs" if _docs_enabled else None,
    redoc_url="/redoc" if _docs_enabled else None,
    openapi_url="/openapi.json" if _docs_enabled else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

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
            class PROCESS_MEMORY_COUNTERS(_ctypes.Structure):
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
    elif os.path.exists("/proc/self/statm"):
        try:
            with open("/proc/self/statm", "r", encoding="utf-8") as f:
                rss_pages = int(f.read().split()[1])
                return rss_pages * os.sysconf("SC_PAGE_SIZE")
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
async def _security_and_metrics_middleware(request: Request, call_next):
    # 1. Enforce request body size limit (2 MiB default)
    content_len = request.headers.get("content-length")
    if content_len and content_len.isdigit() and int(content_len) > MAX_REQUEST_BODY_BYTES:
        return JSONResponse(status_code=413, content={"detail": "Request payload too large."})

    # 2. Reject explicitly revoked X-Device-ID headers immediately
    explicit_dev = (request.headers.get("x-device-id") or "").strip()
    if explicit_dev and get_device_manager().is_device_revoked(explicit_dev):
        return JSONResponse(status_code=403, content={"detail": f"Device '{explicit_dev}' has been revoked."})

    # 3. Record operational request/error rate buckets
    minute_bucket = int(_time.time() // 60)
    if not request.url.path.endswith("/local/metrics"):
        _REQ_BUCKETS[minute_bucket] = _REQ_BUCKETS.get(minute_bucket, 0) + 1
        if len(_REQ_BUCKETS) > 40:
            cutoff = minute_bucket - 35
            for k in list(_REQ_BUCKETS.keys()):
                if k < cutoff:
                    _REQ_BUCKETS.pop(k, None)
                    _ERR_BUCKETS.pop(k, None)

    response = await call_next(request)
    if response.status_code >= 500:
        _ERR_BUCKETS[minute_bucket] = _ERR_BUCKETS.get(minute_bucket, 0) + 1

    # 4. Attach baseline security headers
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; "
        "img-src 'self' data: blob:; "
        "connect-src 'self' ws: wss: http: https:; "
        "frame-ancestors 'self'",
    )
    is_https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    if is_production() or is_https:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

    return response


# ---------------------------------------------------------------------------
# Proxy-aware Loopback & Operator Authentication / RBAC Helpers
# ---------------------------------------------------------------------------
def _has_forwarding_headers(request: Request) -> bool:
    return bool(
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for")
        or request.headers.get("x-real-ip")
        or request.headers.get("forwarded")
    )


def _caller_ip(request: Request) -> str:
    xff = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if xff:
        return xff
    cf = (request.headers.get("cf-connecting-ip") or "").strip()
    if cf:
        return cf
    return request.client.host if request.client else "127.0.0.1"


def _is_local_operator(request: Request) -> bool:
    """Loopback caller that did not come through a proxy/tunnel (those add forwarding headers)."""
    host = request.client.host if request.client else ""
    return host in ("127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost", "testclient") and not _has_forwarding_headers(request)


def _extract_session_token(request: Request) -> Optional[str]:
    auth_header = (request.headers.get("authorization") or "").strip()
    if auth_header.lower().startswith("bearer "):
        tok = auth_header[7:].strip()
        if tok:
            return tok
    cookie_tok = (request.cookies.get("alexia_session") or "").strip()
    if cookie_tok:
        return cookie_tok
    query_tok = (request.query_params.get("session_token") or "").strip()
    if query_tok:
        return query_tok
    return None


def _resolve_operator(request: Request, require_mutation_role: bool = False) -> Tuple[str, str, str]:
    """Authenticate operator session and enforce RBAC (`viewer`, `approver`, `admin`)."""
    token = _extract_session_token(request)
    auth_mgr = get_auth_manager()

    if token:
        valid, username, device_id = auth_mgr.verify_session_token(token)
        if not valid or not username or not device_id:
            raise HTTPException(status_code=401, detail="Invalid, expired, or revoked operator session.")
        role = auth_mgr.get_user_role(username)
        if require_mutation_role and role == "viewer":
            raise HTTPException(status_code=403, detail="Viewer role cannot execute state-modifying operations.")
        return username, device_id, role

    if require_api_auth():
        if not require_mutation_role and public_readonly():
            return "public_viewer", "readonly", "viewer"
        raise HTTPException(status_code=401, detail="Operator authentication required.")

    return "operator", (request.headers.get("x-device-id") or "web_dashboard"), "admin"


def _require_viewer(request: Request) -> Tuple[str, str, str]:
    return _resolve_operator(request, require_mutation_role=False)


def _require_operator(request: Request) -> Tuple[str, str, str]:
    return _resolve_operator(request, require_mutation_role=True)


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
    settings = get_state_store().get_settings()
    return {
        "ok": True,
        "status": "healthy",
        "service": "alexia-guardian",
        "version": "1.0.0",
        "environment": env_name(),
        "demo_mode": is_demo_mode(settings.get("demo_mode")),
        "require_auth": require_api_auth(),
        "uptimeSec": uptime_sec,
        "internetUrl": os.environ.get("ALEXIA_INTERNET_URL", "") or None,
        "gateway": {
            "mode": "live" if get_llm_client().is_live() else "sandbox",
        },
        "collectors": get_collector_supervisor().status(),
        "counts": {
            "incidents": len(open_incidents),
            "approvals": len(pending_approvals),
            "services": 3,
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
    if not _is_local_operator(request):
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
    _require_viewer(request)
    return create_sse_response(request)


# ---------------------------------------------------------------------------
# Incidents & Investigation (FR-U1, FR-U2)
# ---------------------------------------------------------------------------
@app.get("/incidents", response_model=List[Incident])
@app.get("/api/v1/incidents", response_model=List[Incident])
async def list_incidents(request: Request, status: Optional[str] = None, limit: int = 50, offset: int = 0):
    _require_viewer(request)
    bus = get_event_bus()
    return bus.list_incidents(status=status, limit=max(1, min(limit, 200)), offset=max(0, offset))


@app.get("/incidents/{incident_id}", response_model=Incident)
@app.get("/api/v1/incidents/{incident_id}", response_model=Incident)
async def get_incident(incident_id: str, request: Request):
    _require_viewer(request)
    bus = get_event_bus()
    inc = bus.get_incident(incident_id)
    if not inc:
        raise HTTPException(status_code=404, detail="Incident not found")
    return inc


@app.post("/api/v1/incidents/{incident_id}/investigate")
@app.post("/incidents/{incident_id}/investigate")
async def investigate_incident(incident_id: str, request: Request):
    """Trigger or refresh AI-assisted investigation on an incident."""
    _require_operator(request)
    caller = _caller_ip(request)
    now = _time.time()
    min_gap = 5.0 if not _is_local_operator(request) else 0.0
    if min_gap > 0 and (now - _INVESTIGATE_LAST_AT.get(caller, 0.0)) < min_gap:
        raise HTTPException(status_code=429, detail="Investigation rate limit exceeded. Wait a few seconds.")
    _INVESTIGATE_LAST_AT[caller] = now

    bus = get_event_bus()
    inc = bus.get_incident(incident_id)
    if not inc:
        raise HTTPException(status_code=404, detail="Incident not found")

    llm = get_llm_client()
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
    inc.metadata["latest_investigation"] = analysis
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
async def get_incident_remediation(incident_id: str, request: Request):
    """Return structured remediation plan, snapshots, and verification status for an incident."""
    _require_viewer(request)
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
# Approvals (FR-U3, FR-M5, FR-C7)
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
async def list_pending_approvals(request: Request, all: bool = False):
    _require_viewer(request)
    mgr = get_approval_manager()
    if all:
        return mgr.list_all(include_token=False)
    return mgr.list_pending(include_token=False)


@app.get("/api/v1/approvals")
async def list_all_approvals_v1(request: Request, pending_only: bool = False):
    _require_viewer(request)
    mgr = get_approval_manager()
    if pending_only:
        return mgr.list_pending(include_token=False)
    return mgr.list_all(include_token=False)


def _execute_approval_decision(action_id: str, req: ApprovalDecisionRequest, request: Request) -> Dict[str, Any]:
    op_user, op_dev, _ = _require_operator(request)
    mgr = get_approval_manager()
    actor_name = req.actor or req.decided_by or op_user or "operator"
    step_up_required = bool(get_state_store().get_setting("step_up_auth_required", True)) or is_production()

    if req.decision.lower() == "approved" and step_up_required:
        if not req.step_up_token:
            raise HTTPException(
                status_code=401,
                detail="Approving requires step-up authentication (passkey/biometric or TOTP).",
            )
        valid, elevated_user, method = get_auth_manager().verify_step_up_token(
            req.step_up_token,
            expected_action_id=action_id,
        )
        if not valid:
            raise HTTPException(status_code=401, detail="Invalid, expired, or already-used step-up authentication token.")
        req.step_up_method = method
        if actor_name == "operator" and elevated_user:
            actor_name = f"{elevated_user}@{op_dev}"

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
    state_store = get_state_store()
    incident_id = data.get("incident_id") if data else None

    if req.decision.lower() == "approved" and data:
        executor = get_executor()
        act_name = data["action"]
        if act_name == "merge_pr":
            act_name = "merge_pull_request_and_deploy"
        act = Action(
            id=data["action_id"],
            action=act_name,
            target=data["target"],
            params=data["params"],
            tier=1,
            reason=data["reason"],
            requested_by=f"human:{actor_name}",
        )
        exec_ok, exec_msg, exec_res = executor.execute(act, incident_id=incident_id, is_pre_approved=True)
        if not exec_ok:
            raise HTTPException(status_code=400, detail=exec_msg)

        if incident_id:
            inc = bus.get_incident(incident_id)
            if inc:
                inc.status = "resolved"
                inc.approval_required = False
                for p in inc.plan:
                    if p.id == action_id:
                        p.status = "executed"
                if inc.verification and isinstance(inc.verification, dict):
                    inc.verification["deployment_status"] = "deployed_and_verified"
                bus.update_incident(inc, reason=f"Tier 1 action {action_id} approved by {actor_name}")

        if act_name == "merge_pull_request_and_deploy":
            staged = state_store.get_deployment("dep_143_staged")
            if staged:
                staged["status"] = "healthy"
                staged["health_gate"] = "passed"
                state_store.upsert_deployment(staged)
            data["execution"] = exec_res
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
async def decide_approval(action_id: str, req: ApprovalDecisionRequest, request: Request):
    return _execute_approval_decision(action_id, req, request)


@app.post("/api/v1/approvals/{action_id}/approve")
async def approve_action_v1(action_id: str, request: Request, req: Optional[ApprovalDecisionRequest] = None):
    payload = req or ApprovalDecisionRequest(decision="approved")
    payload.decision = "approved"
    return _execute_approval_decision(action_id, payload, request)


@app.post("/api/v1/approvals/{action_id}/reject")
async def reject_action_v1(action_id: str, request: Request, req: Optional[ApprovalDecisionRequest] = None):
    payload = req or ApprovalDecisionRequest(decision="rejected")
    payload.decision = "rejected"
    return _execute_approval_decision(action_id, payload, request)


# ---------------------------------------------------------------------------
# Model Usage & Budget (FR-U5, FR-C10)
# ---------------------------------------------------------------------------
@app.get("/stats/models")
@app.get("/api/v1/observability/models")
async def get_model_stats(request: Request):
    _require_viewer(request)
    guard = get_budget_guard()
    return guard.get_daily_stats()


# ---------------------------------------------------------------------------
# Audit Chain (FR-U8, FR-C8)
# ---------------------------------------------------------------------------
@app.get("/audit")
@app.get("/api/v1/audit")
async def get_audit_trail(
    request: Request,
    limit: int = 50,
    offset: int = 0,
    actor: Optional[str] = None,
    event_type: Optional[str] = None,
):
    _require_viewer(request)
    audit = get_audit_log()
    entries = audit.get_entries(limit=max(1, min(limit, 500)), offset=max(0, offset))
    if actor:
        entries = [e for e in entries if actor.lower() in e.actor.lower()]
    if event_type:
        entries = [e for e in entries if event_type.lower() in e.event_type.lower()]
    is_valid, rows_checked, error_msg = audit.verify_chain()

    return {
        "chain_verified": is_valid,
        "verified_rows": rows_checked,
        "verification_error": error_msg,
        "entries": [e.model_dump() for e in entries],
    }


@app.get("/audit/verify")
@app.get("/api/v1/audit/verify")
async def verify_audit_chain_endpoint(request: Request):
    _require_viewer(request)
    audit = get_audit_log()
    is_valid, rows_checked, error_msg = audit.verify_chain()
    entries = audit.get_entries(limit=1)
    head_hash = entries[0].hash if entries else "0" * 64
    head_sig = entries[0].signature if entries else ""
    return {
        "valid": is_valid,
        "chain_verified": is_valid,
        "records_checked": rows_checked,
        "verified_rows": rows_checked,
        "head_hash": head_hash,
        "head_signature": head_sig,
        "verification_error": error_msg,
        "verified_at": current_iso_timestamp(),
    }


# ---------------------------------------------------------------------------
# Target Services, Deployments & Snapshots (FR-U4)
# ---------------------------------------------------------------------------
def _get_services_list() -> List[Dict[str, Any]]:
    now_iso = current_iso_timestamp()
    bus = get_event_bus()
    open_incs = [i for i in bus.list_incidents(limit=50) if i.status != "resolved" and i.affected_service == "shoplite-api"]
    api_open = open_incs[0] if open_incs else None

    hc = get_collector_supervisor().get_health_collector()
    probe_code = (hc.last_probe or {}).get("status_code") if hc else None
    if probe_code and probe_code >= 500:
        api_status = "unhealthy"
    elif api_open and api_open.severity == "critical":
        api_status = "degraded"
    elif api_open and api_open.category in ("crash", "oom"):
        api_status = "unhealthy"
    elif api_open:
        api_status = "degraded"
    else:
        api_status = "healthy"

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
            "uptime_seconds": int(max(60, _time.time() - _SERVER_START_TIME)),
            "last_health_check": now_iso,
            "restart_count": 1,
            "cpu_percent": _sample_cpu_percent(),
            "memory_mb": round(_get_process_rss_bytes() / (1024 * 1024), 1),
            "disk_mb": 412,
            "latest_incident_id": api_open.id if api_open else None,
            "ports": ["8000:8000"],
        },
        {
            "id": "svc_shoplite_db",
            "name": "shoplite-db",
            "type": "SQLite / PostgreSQL Engine",
            "status": "healthy",
            "image": "postgres:16.2-alpine",
            "current_image": "postgres:16-alpine",
            "last_deploy": "2026-10-28T09:15:00Z",
            "container": "alexia-db-1",
            "container_id": "9a1d7c4e0f22",
            "uptime_seconds": 604800,
            "last_health_check": now_iso,
            "restart_count": 0,
            "cpu_percent": 12.4,
            "memory_mb": 256,
            "disk_mb": 512,
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
            "cpu_percent": 4.2,
            "memory_mb": 64,
            "disk_mb": 95,
            "ports": ["80:80", "443:443"],
        },
    ]


@app.get("/services")
@app.get("/api/v1/services")
async def get_services_status(request: Request):
    _require_viewer(request)
    return _get_services_list()


@app.get("/services/{service_id}")
@app.get("/api/v1/services/{service_id}")
async def get_service_detail(service_id: str, request: Request):
    _require_viewer(request)
    for svc in _get_services_list():
        if svc["id"] == service_id or svc["name"] == service_id:
            return svc
    raise HTTPException(status_code=404, detail="Service not found")


@app.post("/services/{service_id}/restart")
@app.post("/api/v1/services/{service_id}/restart")
async def restart_service(service_id: str, request: Request):
    op_user, op_dev, _ = _require_operator(request)
    svc = next((s for s in _get_services_list() if s["id"] == service_id or s["name"] == service_id), None)
    if not svc:
        raise HTTPException(status_code=404, detail="Service not found")
    success, msg, data = get_remote_controller().trigger_action(
        action_name="restart_container",
        target=svc["name"],
        params={},
        user=op_user,
        device_id=op_dev,
    )
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    get_event_bus().broadcast_sse({"type": "service_restarted", "data": {"service_id": svc["id"], "result": data}})
    return {"status": "queued" if data.get("queued") else "success", "message": msg, "service": svc, "result": data}


@app.get("/deployments")
@app.get("/api/v1/deployments")
async def list_deployments(request: Request):
    _require_viewer(request)
    _ensure_seeded_state()
    return get_state_store().list_deployments()


@app.post("/deployments/{deployment_id}/rollback")
@app.post("/api/v1/deployments/{deployment_id}/rollback")
async def rollback_deployment(deployment_id: str, request: Request):
    op_user, _, _ = _require_operator(request)
    _ensure_seeded_state()
    store = get_state_store()
    target_dep = store.get_deployment(deployment_id)
    if not target_dep:
        raise HTTPException(status_code=404, detail=f"Deployment {deployment_id} not found")

    prev_ver = target_dep.get("previous_version") or "v1.4.1"
    rb_res = get_deployer_agent().rollback(
        service=target_dep["service_name"],
        deployment_id=deployment_id,
        reason=f"Manual rollback requested by {op_user} ({target_dep['version']} -> {prev_ver})",
    )
    if not rb_res.get("success"):
        raise HTTPException(status_code=400, detail=rb_res.get("message", "Rollback failed"))

    if rb_res.get("data", {}).get("queued"):
        return {
            "status": "queued_for_approval",
            "deployment": target_dep,
            "message": rb_res.get("message"),
        }

    target_dep["status"] = "rolled_back"
    target_dep["rollback_available"] = False
    store.upsert_deployment(target_dep)

    entry = get_audit_log().record(
        event_type="DEPLOYMENT_ROLLBACK",
        actor=f"operator:{op_user}",
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
    service_name: str = "shoplite-api"
    incident_id: str = "manual_operator"
    type: str = "full_bundle"


def _all_snapshots() -> List[Dict[str, Any]]:
    """Return all snapshots stored on disk, newest first."""
    _ensure_seeded_state()
    out: List[Dict[str, Any]] = []
    for meta in list_snapshot_files():
        out.append(
            {
                "id": meta["id"],
                "incident_id": meta.get("incident_id") or "pre_action",
                "service_name": meta.get("service_name") or meta.get("target", "shoplite-api"),
                "created_at": meta.get("created_at"),
                "type": meta.get("type") or "full_bundle",
                "sha256": meta.get("sha256", ""),
                "size_mb": meta.get("size_mb") or round(max(meta.get("size_bytes", 0) / (1024 * 1024), 0.01), 2),
                "verified": bool(meta.get("sha256")),
                "restorable": bool(meta.get("restorable", True)),
                "description": meta.get("description", ""),
            }
        )
    return out


@app.get("/snapshots")
@app.get("/api/v1/snapshots")
async def list_snapshots(request: Request):
    _require_viewer(request)
    return _all_snapshots()


@app.post("/snapshots")
@app.post("/api/v1/snapshots")
async def create_snapshot_endpoint(request: Request, req: Optional[CreateSnapshotRequest] = None):
    op_user, _, _ = _require_operator(request)
    payload = req or CreateSnapshotRequest()
    meta = create_snapshot(
        target=payload.service_name,
        description=f"Manual snapshot by {op_user}",
        incident_id=payload.incident_id,
        snap_type=payload.type,
    )
    snap_record = {
        "id": meta["id"],
        "incident_id": payload.incident_id,
        "service_name": payload.service_name,
        "created_at": meta["created_at"],
        "type": payload.type,
        "sha256": meta["sha256"],
        "size_mb": meta.get("size_mb", 0.01),
        "verified": True,
        "restorable": True,
    }
    get_event_bus().broadcast_sse({"type": "snapshot_created", "data": snap_record})
    return snap_record


@app.post("/snapshots/{snapshot_id}/verify")
@app.post("/api/v1/snapshots/{snapshot_id}/verify")
async def verify_snapshot_endpoint(snapshot_id: str, request: Request):
    _require_viewer(request)
    res = verify_snapshot(snapshot_id)
    if res.get("error") == "metadata not found":
        raise HTTPException(status_code=404, detail=f"Snapshot {snapshot_id} not found")
    return res


@app.post("/snapshots/{snapshot_id}/restore")
@app.post("/api/v1/snapshots/{snapshot_id}/restore")
async def restore_snapshot_endpoint(snapshot_id: str, request: Request):
    op_user, op_dev, _ = _require_operator(request)
    snap = next((s for s in _all_snapshots() if s["id"] == snapshot_id), None)
    if not snap:
        raise HTTPException(status_code=404, detail=f"Snapshot {snapshot_id} not found")
    action = Action(
        action="restore_snapshot",
        target=snap["service_name"],
        tier=1,
        params={"snapshot_id": snapshot_id},
        reason=f"Operator {op_user} requested restore of snapshot {snapshot_id}",
        expected_outcome="Data restored from the snapshot, followed by a post-restore integrity check",
        rollback="Take a fresh snapshot before restoring so the current state can be recovered",
        requested_by=f"user:{op_user}@device:{op_dev}",
    )
    success, msg, data = get_executor().execute(action)
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    get_event_bus().broadcast_sse({"type": "approval_requested", "data": {"action_id": action.id, "snapshot_id": snapshot_id}})
    return {"status": "queued_for_approval", "action_id": action.id, "message": msg, "snapshot": snap}


# ---------------------------------------------------------------------------
# Integrity, Migration Guard & Perimeter IP Blocklist APIs
# ---------------------------------------------------------------------------
class MigrationGuardRequest(BaseModel):
    migration_sql: str


class BlockIpRequest(BaseModel):
    ip: str
    duration_minutes: int = Field(default=60, ge=1, le=60)
    reason: str = "Manual operator containment"


@app.post("/api/v1/integrity/check")
async def run_integrity_check_endpoint(request: Request):
    _require_operator(request)
    return await asyncio.to_thread(get_integrity_agent().verify_integrity, "shoplite-api")


@app.post("/api/v1/integrity/migration-guard")
async def run_migration_guard_endpoint(req: MigrationGuardRequest, request: Request):
    _require_operator(request)
    res = await asyncio.to_thread(get_integrity_agent().guard_migration, req.migration_sql)
    return res.model_dump()


@app.get("/api/v1/security/blocked-ips")
async def list_blocked_ips_endpoint(request: Request):
    _require_viewer(request)
    return get_executor().list_blocked_ips()


@app.post("/api/v1/security/blocked-ips")
async def block_ip_endpoint(req: BlockIpRequest, request: Request):
    op_user, op_dev, _ = _require_operator(request)
    act = Action(
        action="block_ip_temporarily",
        target="caddy-proxy",
        tier=0,
        params={"ip": req.ip, "duration_minutes": req.duration_minutes},
        reason=req.reason,
        requested_by=f"user:{op_user}@device:{op_dev}",
    )
    ok, msg, data = get_executor().execute(act)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": "queued" if data.get("queued") else "success", "message": msg, "result": data}


@app.delete("/api/v1/security/blocked-ips/{ip}")
async def unblock_ip_endpoint(ip: str, request: Request):
    op_user, op_dev, _ = _require_operator(request)
    act = Action(
        action="unblock_ip",
        target="caddy-proxy",
        tier=0,
        params={"ip": ip},
        reason=f"Unblocked by {op_user}",
        requested_by=f"user:{op_user}@device:{op_dev}",
    )
    ok, msg, data = get_executor().execute(act)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": "queued" if data.get("queued") else "success", "message": msg, "result": data}


# ---------------------------------------------------------------------------
# Security Findings & Regulatory Breach Reports (FR-S8, FR-U7)
# ---------------------------------------------------------------------------
_REPORT_FRAMEWORKS = {
    "cert_in": ("CERT-In", "CERT-In 6-Hour Cyber Incident Directive (India)", 6),
    "dpdp": ("DPDP_ACT", "Digital Personal Data Protection Act (DPDP) Breach Notice", 72),
    "gdpr": ("GDPR", "GDPR Article 33 Supervisory Authority Notification", 72),
}


def _collect_reports() -> List[Dict[str, Any]]:
    """Combine live incident reports and durable StateStore breach reports without duplicates."""
    _ensure_seeded_state()
    by_id: Dict[str, Dict[str, Any]] = {}
    for stored in get_state_store().list_reports():
        by_id[stored["id"]] = stored

    for inc in get_event_bus().list_incidents(limit=100):
        drafts = inc.metadata.get("reports") if isinstance(inc.metadata, dict) else None
        if not isinstance(drafts, dict):
            continue
        exposure = inc.metadata.get("exposure_assessment") or {}
        for key, body in drafts.items():
            rep_id = f"rep_{key}_{inc.id}"
            if rep_id in by_id:
                continue
            framework, label, hours = _REPORT_FRAMEWORKS.get(key, (key.upper(), key.upper(), 72))
            by_id[rep_id] = {
                "id": rep_id,
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
            }
    return sorted(by_id.values(), key=lambda r: r.get("generated_at", ""), reverse=True)


@app.get("/reports")
@app.get("/api/v1/reports")
@app.get("/api/v1/security/reports")
async def list_security_reports(request: Request):
    _require_viewer(request)
    return _collect_reports()


@app.get("/reports/{report_id}/export")
@app.get("/api/v1/reports/{report_id}/export")
async def export_security_report(report_id: str, request: Request, format: str = Query("html")):
    """Export a regulatory breach report as printable HTML/PDF or Markdown (FR-U7)."""
    _require_viewer(request)
    rep = next((r for r in _collect_reports() if r["id"] == report_id), None)
    if not rep:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")
    md = rep.get("markdown") or f"# {rep['framework_label']}\n\n{rep['summary']}"
    if format.lower() in ("md", "markdown"):
        return PlainTextResponse(
            content=md,
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{report_id}.md"'},
        )
    html_doc = render_report_html(title=f"{rep['framework_label']} — {rep['incident_id']}", markdown_text=md)
    return HTMLResponse(content=html_doc)


@app.get("/api/v1/security/findings")
async def list_security_findings(request: Request):
    _require_viewer(request)
    bus = get_event_bus()
    sec_incidents = [inc.model_dump() for inc in bus.list_incidents() if inc.category in ("security", "data_integrity")]
    return {
        "findings": sec_incidents,
        "reports": _collect_reports(),
        "blocked_ips": get_executor().list_blocked_ips(),
        "redaction_layers": [
            "API Keys (OpenAI, Nebius, Tavily, Stripe, AWS, GitHub PAT, Slack, Google)",
            "JWT Bearer Tokens, Basic Auth, URL Query Tokens & Key-Suffix Secrets",
            "Database Connection URIs & PEM Private Keys",
            "PII: Email Addresses, International Phone Numbers, 12-Digit National IDs & Luhn Card Numbers",
            "Prompt-Injection Delimiter Escaping (<untrusted_log> wrapping)",
        ],
    }


# ---------------------------------------------------------------------------
# Notifications Feed
# ---------------------------------------------------------------------------
class MarkNotificationsReadRequest(BaseModel):
    notification_id: Optional[str] = None


@app.get("/api/v1/notifications")
async def list_notifications_endpoint(request: Request, limit: int = 50):
    _require_viewer(request)
    _ensure_seeded_state()
    return get_state_store().list_notifications(limit=max(1, min(limit, 100)))


@app.post("/api/v1/notifications/read")
async def mark_notifications_read_endpoint(request: Request, req: Optional[MarkNotificationsReadRequest] = None):
    _require_operator(request)
    nid = req.notification_id if req else None
    updated = get_state_store().mark_notifications_read(nid)
    return {"status": "success", "updated": updated}


# ---------------------------------------------------------------------------
# Demo Scenario Runner (FR-U6, NFR5)
# ---------------------------------------------------------------------------
@app.get("/scenarios")
@app.get("/api/v1/scenarios")
async def list_scenarios(request: Request):
    _require_viewer(request)
    return SCENARIO_CATALOG


@app.post("/scenarios/{scenario_id}/run")
@app.post("/api/v1/scenarios/{scenario_id}/run")
async def trigger_scenario(scenario_id: str, request: Request):
    if is_production() and not is_demo_mode():
        _require_operator(request)
    global _last_public_scenario_at
    cooldown = float(scenario_cooldown_seconds())
    guarded = cooldown > 0 and not _is_local_operator(request)
    if guarded:
        if get_event_bus().is_busy():
            raise HTTPException(
                status_code=429,
                detail="Another scenario is still running. Try again shortly.",
                headers={"Retry-After": "15"},
            )
        wait = _last_public_scenario_at + cooldown - _time.time()
        if wait > 0:
            raise HTTPException(
                status_code=429,
                detail=f"Scenario cooldown: try again in {int(wait) + 1}s.",
                headers={"Retry-After": str(int(wait) + 1)},
            )
        _last_public_scenario_at = _time.time()
    res = await run_scenario(scenario_id)
    if "error" in res:
        raise HTTPException(status_code=400, detail=res["error"])
    return res


class ScenarioResetRequest(BaseModel):
    step_up_token: Optional[str] = None


@app.post("/scenarios/reset")
@app.post("/environment/reset")
@app.post("/api/v1/scenarios/reset")
async def reset_demo(request: Request, req: Optional[ScenarioResetRequest] = None):
    _require_operator(request)
    executor = get_executor()
    # Never allow unauthenticated/unverified kill-switch or IP blocklist reset in production
    if require_api_auth() and (executor.is_autonomy_paused() or not is_demo_mode()):
        step_tok = (req.step_up_token if req else None) or request.headers.get("x-step-up-token")
        if not step_tok:
            raise HTTPException(
                status_code=401,
                detail="Environment reset requires step-up authentication in production.",
            )
        valid, _, _ = get_auth_manager().verify_step_up_token(step_tok)
        if not valid:
            raise HTTPException(status_code=401, detail="Invalid or expired step-up authentication token.")
    res = reset_demo_environment()
    get_event_bus().broadcast_sse({"type": "environment_reset", "data": res})
    return res


# ---------------------------------------------------------------------------
# Overview Dashboard & Durable Settings
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
            waiting = next((i for i in owned if i.approval_required and i.approval_id in pending_ids), None)
            working = next((i for i in owned if not i.approval_required and i.updated_at >= recent_cutoff), None)
            latest_event = "No actions recorded yet"
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
                "latest_event": latest_event,
                "latest_event_time": latest[0] if latest else current_iso_timestamp(),
                "total_actions_today": today_count,
            })
    return agents


@app.get("/agents")
@app.get("/api/v1/agents")
async def list_agents(request: Request):
    _require_viewer(request)
    return _agent_status()


@app.get("/api/v1/dashboard")
@app.get("/dashboard")
async def get_dashboard_overview(request: Request):
    _require_viewer(request)
    _ensure_seeded_state()
    bus = get_event_bus()
    mgr = get_approval_manager()
    guard = get_budget_guard()
    audit = get_audit_log()
    executor = get_executor()
    store = get_state_store()

    incidents = bus.list_incidents(limit=50)
    pending_approvals = mgr.list_pending(include_token=False)
    all_approvals = mgr.list_all(include_token=False)
    model_stats = guard.get_daily_stats()
    audit_entries = audit.get_entries(limit=30)
    chain_ok, rows_checked, _ = audit.verify_chain()
    settings = store.get_settings()

    return {
        "autonomy_mode": "paused" if executor.is_autonomy_paused() else "autonomous",
        "is_autonomy_paused": executor.is_autonomy_paused(),
        "open_incidents_count": len([i for i in incidents if i.status != "resolved"]),
        "pending_approvals_count": len(pending_approvals),
        "incidents": [i.model_dump() for i in incidents],
        "approvals": all_approvals,
        "services": _get_services_list(),
        "deployments": store.list_deployments(),
        "snapshots": _all_snapshots(),
        "reports": _collect_reports(),
        "notifications": store.list_notifications(limit=30),
        "blocked_ips": executor.list_blocked_ips(),
        "collectors": get_collector_supervisor().status(),
        "model_summary": model_stats,
        "model_calls": model_stats.get("recent_calls", []),
        "audit": {
            "chain_verified": chain_ok,
            "verified_rows": rows_checked,
            "entries": [e.model_dump() for e in audit_entries],
        },
        "settings": settings,
        "agents": _agent_status(),
    }


@app.get("/api/v1/settings")
@app.get("/settings")
async def get_settings(request: Request):
    _require_viewer(request)
    executor = get_executor()
    dev_mgr = get_device_manager()
    settings = get_state_store().get_settings()
    return {
        **settings,
        "autonomy_paused": executor.is_autonomy_paused(),
        "collectors": get_collector_supervisor().status(),
        "vapid": get_push_manager().get_public_key_info(),
        "devices": dev_mgr.list_devices(),
    }


_SENSITIVE_FALSE_TOGGLES = ("step_up_auth_required", "redaction_enabled", "webhook_signature_verification")


@app.patch("/api/v1/settings")
@app.patch("/settings")
async def update_settings(updates: Dict[str, Any], request: Request):
    op_user, op_dev, _ = _require_operator(request)
    executor = get_executor()
    store = get_state_store()
    current = store.get_settings()

    resuming_autonomy = ("autonomy_paused" in updates and updates["autonomy_paused"] is False and executor.is_autonomy_paused())
    weakening_security = any(
        k in updates and updates[k] is False and current.get(k, True) is True
        for k in _SENSITIVE_FALSE_TOGGLES
    )

    step_up_method = "totp"
    if resuming_autonomy or weakening_security:
        step_tok = str(updates.get("step_up_token") or request.headers.get("x-step-up-token") or "").strip()
        if not step_tok:
            raise HTTPException(
                status_code=401,
                detail="Resuming autonomy or lowering security controls requires step-up authentication.",
            )
        valid, elevated_user, method = get_auth_manager().verify_step_up_token(step_tok)
        if not valid:
            raise HTTPException(status_code=401, detail="Invalid, expired, or already-used step-up authentication token.")
        step_up_method = method or "passkey"
        if elevated_user:
            op_user = elevated_user

    if "autonomy_paused" in updates:
        if updates["autonomy_paused"]:
            executor.pause_autonomy(paused_by=f"user:{op_user}@device:{op_dev}")
        elif executor.is_autonomy_paused():
            executor.resume_autonomy(resumed_by=f"user:{op_user}@device:{op_dev}", step_up_method=step_up_method)

    allowed_keys = set(current.keys())
    clean_updates = {k: v for k, v in updates.items() if k in allowed_keys}
    if clean_updates:
        store.update_settings(clean_updates, updated_by=op_user)
        get_audit_log().record(
            event_type="settings_updated",
            actor=f"user:{op_user}",
            details={"updated_keys": sorted(clean_updates.keys()), "device_id": op_dev},
        )

    res = await get_settings(request)
    get_event_bus().broadcast_sse({"type": "settings_updated", "data": res})
    return res


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
# Operator & Mobile Companion APIs (FR-M1 through FR-M12)
# ---------------------------------------------------------------------------
class LoginRequest(BaseModel):
    username: str
    password: str
    device_id: str = "mobile_pwa_client"
    device_name: str = "Operator Device"
    platform: str = "Web"


class StepUpRequest(BaseModel):
    totp_code: Optional[str] = None
    passkey_signature: Optional[str] = None
    username: str = "demo"
    device_id: Optional[str] = None
    action_id: Optional[str] = None
    single_use: bool = False


class WebAuthnChallengeRequest(BaseModel):
    username: str = "demo"
    purpose: str = "authenticate"  # "authenticate" or "register"


class WebAuthnRegisterRequest(BaseModel):
    username: str = "demo"
    credential_id: str
    client_data_json: str
    public_key: str = ""
    device_name: str = "Operator Passkey"


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


class RevokeDeviceRequest(BaseModel):
    step_up_token: Optional[str] = None


@app.post("/remote/auth/login")
async def mobile_login(req: LoginRequest, request: Request, response: Response):
    auth_mgr = get_auth_manager()
    client_ip = _caller_ip(request)
    rate_key = f"login:{client_ip}:{req.username}"
    allowed, retry_after = auth_mgr.check_rate_limit(rate_key)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed login attempts. Try again in {retry_after}s.",
            headers={"Retry-After": str(retry_after)},
        )

    dev_mgr = get_device_manager()
    if dev_mgr.is_device_revoked(req.device_id):
        raise HTTPException(status_code=403, detail=f"Device '{req.device_id}' has been revoked.")

    if not auth_mgr.verify_credentials(req.username, req.password):
        auth_mgr.record_auth_failure(rate_key)
        hint = " (Demo: demo / alexiaguardian2026)" if is_demo_mode() and not is_production() else ""
        raise HTTPException(status_code=401, detail=f"Invalid operator credentials.{hint}")

    auth_mgr.clear_auth_failures(rate_key)

    try:
        dev_mgr.register_or_update(
            device_id=req.device_id,
            user=req.username,
            device_name=req.device_name,
            platform=req.platform,
            ip_address=client_ip,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))

    role = auth_mgr.get_user_role(req.username)
    token = auth_mgr.create_session_token(req.username, req.device_id, role=role)
    is_https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(
        key="alexia_session",
        value=token,
        httponly=True,
        samesite="lax",
        secure=bool(is_production() and is_https),
        max_age=12 * 3600,
    )
    get_audit_log().record(
        event_type="operator_login",
        actor=f"user:{req.username}",
        details={"device_id": req.device_id, "platform": req.platform, "ip": client_ip},
    )
    return {
        "status": "success",
        "session_token": token,
        "username": req.username,
        "role": role,
        "device_id": req.device_id,
        "is_demo": is_demo_mode(),
    }


@app.post("/remote/auth/logout")
async def operator_logout(request: Request, response: Response):
    tok = _extract_session_token(request)
    if tok:
        get_auth_manager().revoke_session_token(tok)
    response.delete_cookie("alexia_session")
    return {"status": "success"}


@app.get("/remote/auth/me")
async def operator_session_info(request: Request):
    tok = _extract_session_token(request)
    auth_mgr = get_auth_manager()
    if tok:
        valid, user, dev = auth_mgr.verify_session_token(tok)
        if valid and user:
            return {
                "authenticated": True,
                "username": user,
                "device_id": dev,
                "role": auth_mgr.get_user_role(user),
                "require_auth": require_api_auth(),
                "demo_mode": is_demo_mode(),
            }
    return {
        "authenticated": not require_api_auth(),
        "username": "local_operator" if not require_api_auth() else None,
        "device_id": "web_dashboard" if not require_api_auth() else None,
        "role": "admin" if not require_api_auth() else None,
        "require_auth": require_api_auth(),
        "demo_mode": is_demo_mode(),
    }


@app.get("/remote/auth/totp-setup")
async def totp_provisioning_setup(request: Request, username: str = "operator"):
    op_user, _, _ = _require_operator(request)
    target_user = username if username != "operator" else op_user
    return get_auth_manager().get_totp_provisioning_info(target_user)


@app.post("/remote/auth/webauthn/challenge")
async def webauthn_challenge(req: WebAuthnChallengeRequest, request: Request):
    if req.purpose == "register":
        _require_operator(request)
    return get_auth_manager().create_webauthn_challenge(username=req.username, purpose=req.purpose)


@app.post("/remote/auth/webauthn/register")
async def webauthn_register(req: WebAuthnRegisterRequest, request: Request):
    _require_operator(request)
    ok, msg = get_auth_manager().register_passkey(
        username=req.username,
        credential_id=req.credential_id,
        client_data_b64=req.client_data_json,
        public_key=req.public_key,
        device_name=req.device_name,
    )
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    get_audit_log().record(
        event_type="passkey_registered",
        actor=f"user:{req.username}",
        details={"device_name": req.device_name, "credential_id": req.credential_id[:24]},
    )
    return {"status": "success", "message": msg}


@app.get("/remote/auth/webauthn/passkeys")
async def webauthn_list_passkeys(request: Request, username: Optional[str] = None):
    _require_viewer(request)
    return get_auth_manager().list_passkeys(username=username)


@app.post("/remote/auth/step-up")
async def step_up_auth(req: StepUpRequest, request: Request):
    auth_mgr = get_auth_manager()
    client_ip = _caller_ip(request)
    rate_key = f"stepup:{client_ip}:{req.username}"
    allowed, retry_after = auth_mgr.check_rate_limit(rate_key)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed step-up attempts. Try again in {retry_after}s.",
            headers={"Retry-After": str(retry_after)},
        )

    tok = _extract_session_token(request)
    resolved_user = req.username
    resolved_dev = req.device_id
    if tok:
        valid_sess, sess_user, sess_dev = auth_mgr.verify_session_token(tok)
        if not valid_sess:
            raise HTTPException(status_code=401, detail="Session expired or revoked.")
        resolved_user = sess_user or resolved_user
        resolved_dev = resolved_dev or sess_dev

    if resolved_dev and get_device_manager().is_device_revoked(resolved_dev):
        raise HTTPException(status_code=403, detail=f"Device '{resolved_dev}' has been revoked.")

    if req.totp_code:
        if not auth_mgr.verify_totp(req.totp_code, username=resolved_user):
            auth_mgr.record_auth_failure(rate_key)
            hint = " (Demo code: 123456)" if is_demo_mode() and not is_production() else ""
            raise HTTPException(status_code=400, detail=f"Invalid or replayed TOTP code.{hint}")
        auth_mgr.clear_auth_failures(rate_key)
        step_up_token = auth_mgr.create_step_up_token(
            resolved_user,
            method="totp",
            device_id=resolved_dev,
            action_id=req.action_id,
            single_use=req.single_use,
        )
        return {"status": "success", "step_up_token": step_up_token, "method": "totp"}

    if req.passkey_signature:
        if not auth_mgr.verify_passkey_assertion(resolved_user, req.passkey_signature):
            auth_mgr.record_auth_failure(rate_key)
            raise HTTPException(status_code=400, detail="Invalid or expired WebAuthn passkey assertion.")
        auth_mgr.clear_auth_failures(rate_key)
        step_up_token = auth_mgr.create_step_up_token(
            resolved_user,
            method="biometric",
            device_id=resolved_dev,
            action_id=req.action_id,
            single_use=req.single_use,
        )
        return {"status": "success", "step_up_token": step_up_token, "method": "biometric"}

    raise HTTPException(status_code=400, detail="Step-up requires a TOTP code or a passkey assertion.")


@app.get("/remote/autonomy")
async def get_autonomy_state(request: Request):
    _require_viewer(request)
    executor = get_executor()
    return {"is_paused": executor.is_autonomy_paused()}


@app.post("/remote/autonomy")
async def toggle_autonomy_state(req: AutonomyToggleRequest, request: Request):
    op_user, op_dev, _ = _require_operator(request)
    controller = get_remote_controller()
    user = req.user if req.user != "demo" else op_user
    device_id = req.device_id or op_dev
    success, msg = controller.toggle_autonomy(
        pause=req.pause,
        user=user,
        device_id=device_id,
        step_up_token=req.step_up_token,
    )
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    get_event_bus().broadcast_sse({"type": "autonomy_changed", "data": {"is_paused": req.pause, "by": user}})
    return {"status": "success", "message": msg, "is_paused": req.pause}


@app.post("/remote/controls")
async def execute_remote_control(req: RemoteControlRequest, request: Request):
    op_user, op_dev, _ = _require_operator(request)
    controller = get_remote_controller()
    user = req.user if req.user != "demo" else op_user
    device_id = req.device_id or op_dev
    success, msg, data = controller.trigger_action(
        action_name=req.action,
        target=req.target,
        params=req.params,
        user=user,
        device_id=device_id,
        step_up_token=req.step_up_token,
    )
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": "success", "message": msg, "result": data}


@app.get("/remote/devices")
@app.get("/api/v1/devices")
async def list_registered_devices(request: Request):
    _require_viewer(request)
    dev_mgr = get_device_manager()
    return dev_mgr.list_devices()


@app.post("/remote/devices/{device_id}/revoke")
@app.post("/api/v1/devices/{device_id}/revoke")
async def revoke_device(device_id: str, request: Request, req: Optional[RevokeDeviceRequest] = None):
    op_user, _, _ = _require_operator(request)
    if require_api_auth():
        step_tok = (req.step_up_token if req else None) or request.headers.get("x-step-up-token")
        if not step_tok:
            raise HTTPException(status_code=401, detail="Revoking a device requires step-up authentication.")
        valid, _, _ = get_auth_manager().verify_step_up_token(step_tok)
        if not valid:
            raise HTTPException(status_code=401, detail="Invalid or expired step-up authentication token.")
    dev_mgr = get_device_manager()
    dev_mgr.revoke_device(device_id)
    revoked_sessions = get_auth_manager().revoke_device_sessions(device_id)
    get_audit_log().record(
        event_type="device_revoked",
        actor=f"user:{op_user}",
        details={"device_id": device_id, "revoked_sessions": revoked_sessions},
    )
    get_event_bus().broadcast_sse({"type": "device_revoked", "data": {"device_id": device_id}})
    return {"status": "success", "message": f"Device {device_id} revoked.", "revoked_sessions": revoked_sessions}


@app.get("/remote/push/vapid-public-key")
async def get_vapid_public_key():
    return get_push_manager().get_public_key_info()


@app.post("/remote/push/subscribe")
async def subscribe_push(req: PushSubscribeRequest, request: Request):
    _require_operator(request)
    push_mgr = get_push_manager()
    push_mgr.register_subscription(
        endpoint=req.endpoint,
        p256dh=req.p256dh,
        auth=req.auth,
        device_id=req.device_id,
        user_agent=request.headers.get("user-agent"),
    )
    return {"status": "success", "message": "Push subscription registered."}


# Mount Static Files for Web Dashboard & Mobile PWA Companion
_STATIC_CANDIDATES = [
    "dashboard/static",
    os.path.join(getattr(_sys, "_MEIPASS", ""), "dashboard", "static"),
]

_API_PREFIXES = ("api/", "v1/", "remote/", "stream", "webhook/", "docs", "openapi.json", "redoc")


class _SPAStaticFiles(StaticFiles):
    """Serve index.html for client-side routes (e.g. push-notification deep links) but keep API 404s."""

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except _StarletteHTTPException as exc:
            url_path = path.replace("\\", "/")
            leaf = url_path.rsplit("/", 1)[-1]
            if exc.status_code == 404 and not url_path.startswith(_API_PREFIXES) and "." not in leaf:
                return await super().get_response("index.html", scope)
            raise


for _static_dir in _STATIC_CANDIDATES:
    if _static_dir and os.path.exists(_static_dir):
        app.mount("/", _SPAStaticFiles(directory=_static_dir, html=True), name="static")
        break
