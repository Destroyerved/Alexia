"""Live end-to-end verification against a running Alexia server (not TestClient).

Usage:
    python launcher.py --no-browser          # in another terminal
    python evals/live_e2e.py [--base http://127.0.0.1:8080] [--target http://127.0.0.1:8000]

Drives real HTTP + SSE traffic through every /api/v1 route the dashboard and
mobile companion use, runs the PRD scenarios while an SSE client is attached,
checks response shapes against the TypeScript contracts in src/types/*, then
exercises login -> step-up -> Tier-1 approval, the autonomy kill switch,
rollback/restart, the online SQLite backup, and audit-chain verification.
Exits non-zero if any check fails.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
from typing import Any, Callable, Dict, List, Optional

import httpx

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Required keys per frontend contract (src/types/*.ts) -------------------------
INCIDENT_KEYS = {
    "id", "title", "summary", "status", "severity", "category", "affected_service", "owner_agent",
    "events", "created_at", "updated_at", "approval_required", "stages", "snapshots", "cost_usd",
    "model_calls", "diagnosis",
}
APPROVAL_KEYS = {
    "id", "incident_id", "action_name", "action_tier", "action_tier_label", "affected_service", "reason",
    "risk_level", "expected_outcome", "rollback_plan", "requesting_agent", "status", "created_at",
}
SERVICE_KEYS = {
    "id", "name", "container_id", "image", "status", "uptime_seconds", "last_health_check",
    "restart_count", "cpu_percent", "memory_mb", "disk_mb", "ports",
}
MODEL_SUMMARY_KEYS = {
    "total_spend_usd", "daily_budget_usd", "remaining_budget_usd", "total_calls", "failed_calls",
    "total_input_tokens", "total_output_tokens", "avg_latency_ms", "total_tavily_calls", "tier_breakdown",
}
MODEL_CALL_KEYS = {
    "id", "model_name", "tier", "task", "input_tokens", "output_tokens", "latency_ms", "cost_usd",
    "status", "timestamp",
}
AUDIT_KEYS = {
    "id", "timestamp", "actor", "event", "action", "target", "outcome", "previous_hash", "current_hash",
    "verification_status",
}
METRICS_KEYS = {
    "version", "pid", "uptimeSec", "requestsPerMin", "requestsHistory", "errorsPerMin", "rssBytes",
    "cpuPercent", "eventLoopLagMs", "dbBytes", "openIncidents", "pendingApprovals", "auditVerified",
    "auditRows", "autonomyPaused",
}

SCENARIOS = ["S1", "S2", "S3_DISK", "S4", "S5_BRUTE", "S6", "S7", "S8"]


class Checker:
    def __init__(self) -> None:
        self.passed = 0
        self.failed: List[str] = []

    def check(self, name: str, cond: bool, detail: str = "") -> bool:
        if cond:
            self.passed += 1
            print(f"  ✓ {name}")
        else:
            self.failed.append(f"{name}: {detail}")
            print(f"  ✗ {name}  -- {detail}")
        return cond

    def keys(self, name: str, obj: Any, required: set) -> bool:
        if not isinstance(obj, dict):
            return self.check(name, False, f"expected object, got {type(obj).__name__}")
        missing = sorted(required - obj.keys())
        return self.check(name, not missing, f"missing keys {missing}")


class SSECollector(threading.Thread):
    """Background SSE client that records every data frame."""

    def __init__(self, url: str) -> None:
        super().__init__(daemon=True)
        self.url = url
        self.frames: List[Dict[str, Any]] = []
        self.connected = threading.Event()
        self._stop = threading.Event()
        self.error: Optional[str] = None

    def run(self) -> None:
        try:
            with httpx.Client(timeout=httpx.Timeout(5.0, read=None)) as client:
                with client.stream("GET", self.url, headers={"Accept": "text/event-stream"}) as resp:
                    if resp.status_code != 200:
                        self.error = f"HTTP {resp.status_code}"
                        self.connected.set()
                        return
                    for line in resp.iter_lines():
                        if self._stop.is_set():
                            break
                        if line.startswith("data:"):
                            try:
                                frame = json.loads(line[5:].strip())
                            except json.JSONDecodeError:
                                continue
                            frame["_recv"] = time.time()
                            self.frames.append(frame)
                            if frame.get("type") == "connected":
                                self.connected.set()
        except Exception as exc:  # pragma: no cover - surfaced in report
            self.error = str(exc)
            self.connected.set()

    def stop(self) -> None:
        self._stop.set()

    def types_since(self, t0: float) -> List[str]:
        return [f.get("type", "?") for f in self.frames if f["_recv"] >= t0]


def db_path() -> str:
    data_dir = os.environ.get("ALEXIA_DATA_DIR")
    if data_dir:
        return os.path.join(data_dir, "alexia.db")
    return os.path.join(REPO_ROOT, os.environ.get("ALEXIA_DB_PATH", "data/alexia.db"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--target", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    base = args.base.rstrip("/")
    c = Checker()
    http = httpx.Client(base_url=base, timeout=30.0)

    def get(path: str, **kw: Any) -> httpx.Response:
        return http.get(path, **kw)

    def post(path: str, body: Optional[Dict[str, Any]] = None, **kw: Any) -> httpx.Response:
        return http.post(path, json=body, **kw)

    # 1. Health & loopback metrics ------------------------------------------------
    print("\n[1] Health & loopback metrics")
    for path in ("/health", "/v1/health", "/api/v1/health"):
        r = get(path)
        c.check(f"GET {path} -> 200 healthy", r.status_code == 200 and r.json().get("status") == "healthy", r.text[:200])
    r = httpx.get(f"{args.target}/health", timeout=5)
    c.check("ShopLite target /health -> 200", r.status_code == 200, r.text[:200])
    r = get("/v1/local/metrics")
    if c.check("GET /v1/local/metrics -> 200", r.status_code == 200, r.text[:200]):
        m = r.json()
        c.keys("local metrics shape", m, METRICS_KEYS)
        c.check("metrics rssBytes is live (>1MB)", m.get("rssBytes", 0) > 1_000_000, str(m.get("rssBytes")))
        c.check("metrics dbBytes > 0", m.get("dbBytes", 0) > 0, str(m.get("dbBytes")))
    r = get("/v1/local/metrics", headers={"X-Forwarded-For": "203.0.113.9"})
    c.check("metrics rejects X-Forwarded-For with 404", r.status_code == 404, str(r.status_code))

    # 2. Read APIs vs frontend contracts --------------------------------------------
    print("\n[2] REST read APIs vs frontend contracts")
    r = get("/api/v1/dashboard")
    dash = r.json() if r.status_code == 200 else {}
    c.check("GET /api/v1/dashboard -> 200", r.status_code == 200, r.text[:200])
    c.keys("dashboard payload", dash, {
        "autonomy_mode", "is_autonomy_paused", "open_incidents_count", "pending_approvals_count", "incidents",
        "approvals", "services", "deployments", "snapshots", "reports", "model_summary", "model_calls", "audit",
    })
    if dash.get("incidents"):
        c.keys("dashboard.incidents[0] ~ Incident", dash["incidents"][0], INCIDENT_KEYS)
    if dash.get("model_summary"):
        c.keys("dashboard.model_summary ~ ModelUsageSummary", dash["model_summary"], MODEL_SUMMARY_KEYS)
    if dash.get("model_calls"):
        c.keys("dashboard.model_calls[0] ~ ModelCallRecord", dash["model_calls"][0], MODEL_CALL_KEYS)
    if dash.get("audit", {}).get("entries"):
        c.keys("dashboard.audit.entries[0] ~ AuditRecord", dash["audit"]["entries"][0], AUDIT_KEYS)

    r = get("/api/v1/incidents")
    c.check("GET /api/v1/incidents -> list", r.status_code == 200 and isinstance(r.json(), list), r.text[:200])
    r = get("/api/v1/approvals")
    approvals = r.json() if r.status_code == 200 else []
    c.check("GET /api/v1/approvals -> list", isinstance(approvals, list), r.text[:200])
    if approvals:
        c.keys("approvals[0] ~ ApprovalRequest", approvals[0], APPROVAL_KEYS)
    r = get("/api/v1/services")
    services = r.json() if r.status_code == 200 else []
    c.check("GET /api/v1/services -> non-empty list", isinstance(services, list) and len(services) > 0, r.text[:200])
    if services:
        c.keys("services[0] ~ ServiceItem", services[0], SERVICE_KEYS)
    for path in ("/api/v1/deployments", "/api/v1/snapshots", "/api/v1/reports", "/api/v1/security/reports"):
        r = get(path)
        c.check(f"GET {path} -> non-empty list", r.status_code == 200 and isinstance(r.json(), list) and len(r.json()) > 0, f"{r.status_code} {r.text[:120]}")
    r = get("/api/v1/scenarios")
    c.check("GET /api/v1/scenarios -> 6+ scenarios", r.status_code == 200 and len(r.json()) >= 6, r.text[:200])
    r = get("/api/v1/security/findings")
    c.check("GET /api/v1/security/findings -> findings+reports", r.status_code == 200 and {"findings", "reports"} <= r.json().keys(), r.text[:200])
    r = get("/api/v1/observability/models")
    if c.check("GET /api/v1/observability/models -> 200", r.status_code == 200, r.text[:200]):
        c.keys("model stats ~ ModelUsageSummary", r.json(), MODEL_SUMMARY_KEYS)
    r = get("/api/v1/audit")
    c.check("GET /api/v1/audit -> entries", r.status_code == 200 and "entries" in r.json(), r.text[:200])
    r = get("/api/v1/agents")
    c.check("GET /api/v1/agents -> 5 live agents", r.status_code == 200 and len(r.json()) == 5, r.text[:200])
    r = get("/api/v1/settings")
    c.check("GET /api/v1/settings -> 200", r.status_code == 200 and "autonomy_paused" in r.json(), r.text[:200])
    r = get("/api/v1/audit/verify")
    c.check("GET /api/v1/audit/verify -> valid", r.status_code == 200 and r.json().get("valid") is True, r.text[:300])

    # Static SPA + deep links (push notification targets)
    r = get("/")
    c.check("GET / serves React index.html", r.status_code == 200 and "<div id=\"root\"" in r.text, r.text[:120])
    r = get("/m/approvals/act_demo")
    c.check("GET /m/approvals/<id> deep link serves SPA", r.status_code == 200 and "<div id=\"root\"" in r.text, str(r.status_code))
    r = get("/api/v1/does-not-exist")
    c.check("unknown /api route stays 404 (not SPA)", r.status_code == 404, str(r.status_code))

    # 3. Scenarios with live SSE ------------------------------------------------------
    print("\n[3] Scenarios S1-S8 with a live SSE client attached")
    r = post("/api/v1/scenarios/reset")
    c.check("POST /api/v1/scenarios/reset -> 200", r.status_code == 200, r.text[:200])
    sse = SSECollector(f"{base}/api/v1/events")
    sse.start()
    c.check("SSE /api/v1/events connected", sse.connected.wait(10) and sse.error is None, str(sse.error))
    created: Dict[str, Optional[str]] = {}
    for sid in SCENARIOS:
        t0 = time.time()
        r = post(f"/api/v1/scenarios/{sid}/run")
        ok = c.check(f"POST /api/v1/scenarios/{sid}/run -> 200", r.status_code == 200, r.text[:200])
        res = r.json() if ok else {}
        created[sid] = res.get("incident_id")
        deadline = time.time() + 6
        while time.time() < deadline and not sse.types_since(t0):
            time.sleep(0.1)
        types = sse.types_since(t0)
        c.check(f"{sid}: SSE frames streamed ({', '.join(sorted(set(types)))[:80]})", len(types) > 0, "no SSE frames")
        if sid != "S8":
            c.check(f"{sid}: incident id returned", bool(created[sid]), json.dumps(res)[:200])
    long_id = post("/api/v1/scenarios/S6_sqli_breach/run")
    c.check("POST /api/v1/scenarios/S6_sqli_breach/run (descriptive alias) -> 200", long_id.status_code == 200, long_id.text[:200])
    bad = post("/api/v1/scenarios/S99_nope/run")
    c.check("unknown scenario -> 400", bad.status_code == 400, str(bad.status_code))

    def wait_incident(inc_id: str, done: Callable[[Dict[str, Any]], bool], timeout: float = 90.0) -> Dict[str, Any]:
        """Agent loops run concurrently in the background: poll until this incident reaches the expected state."""
        deadline = time.time() + timeout
        inc: Dict[str, Any] = {}
        while time.time() < deadline:
            inc = get(f"/api/v1/incidents/{inc_id}").json()
            if done(inc):
                break
            time.sleep(0.5)
        return inc

    # Persisted in SQLite?
    con = sqlite3.connect(db_path())
    for sid, inc_id in created.items():
        if not inc_id:
            continue
        row = con.execute("SELECT id FROM incidents WHERE id = ?", (inc_id,)).fetchone()
        c.check(f"{sid}: incident {inc_id} persisted in SQLite", row is not None, db_path())
    n_trans = con.execute("SELECT COUNT(*) FROM incident_transitions").fetchone()[0]
    c.check("incident transitions persisted", n_trans > 0, str(n_trans))
    con.close()

    # Incident detail, investigate, remediation
    print("\n[4] Incident detail, investigate, remediation")
    s6 = created.get("S6")
    if s6:
        inc = wait_incident(s6, lambda i: bool((i.get("metadata") or {}).get("code_fix")))
        c.keys("S6 incident detail ~ Incident", inc, INCIDENT_KEYS)
        diag = inc.get("diagnosis") or {}
        c.check("S6 diagnosis.root_cause populated", bool(diag.get("root_cause")), json.dumps(diag)[:200])
        c.check("S6 diagnosis.evidence populated", bool(diag.get("evidence")), json.dumps(diag)[:200])
        c.check("S6 plan populated", bool(inc.get("plan")), "empty plan")
        c.check("S6 model_calls populated", bool(inc.get("model_calls")), "no model calls")
        c.check("S6 timeline stages populated", len(inc.get("stages") or []) >= 5, str(len(inc.get("stages") or [])))
        fix = (inc.get("metadata") or {}).get("code_fix") or {}
        c.check("S6 Builder fix proven red->green in sandbox", fix.get("proven") is True, fix.get("summary", "no code_fix"))
        c.check("S6 patch parameterizes the query", "LIKE ?" in fix.get("patch", ""), fix.get("patch", "")[:200])
        blob = json.dumps(inc)
        c.check("S6 incident payload redacted (no raw emails / sk_live)", "@shoplite" not in blob and "sk_live_" not in blob, "unredacted data")
        r = post(f"/api/v1/incidents/{s6}/investigate")
        c.check("POST /api/v1/incidents/{id}/investigate -> 200", r.status_code == 200 and r.json().get("status") == "completed", f"{r.status_code} {r.text[:200]}")
        r = get(f"/api/v1/incidents/{s6}/remediation")
        c.check("GET /api/v1/incidents/{id}/remediation -> plan", r.status_code == 200 and "plan" in r.json(), r.text[:200])
    s1 = created.get("S1")
    if s1:
        inc = wait_incident(s1, lambda i: bool((i.get("metadata") or {}).get("proof_of_fix")))
        proof = (inc.get("metadata") or {}).get("proof_of_fix") or {}
        c.check("S1 builder red->green proof (failed_before & passed_after)", proof.get("failed_before") is True and proof.get("passed_after") is True, json.dumps(proof)[:200])
    s4 = created.get("S4")
    if s4:
        inc = get(f"/api/v1/incidents/{s4}").json()
        c.check("S4 secret never stored unredacted", "sk_live_51Mz" not in json.dumps(inc), "raw key in incident")
    r = get("/api/v1/incidents/inc_does_not_exist")
    c.check("GET unknown incident -> 404", r.status_code == 404, str(r.status_code))

    # 5. Mobile auth, step-up, approvals ---------------------------------------------
    print("\n[5] Mobile companion login, step-up, Tier-1 approvals")
    r = post("/remote/auth/login", {"username": "demo", "password": "wrong"})
    c.check("login with bad password -> 401", r.status_code == 401, str(r.status_code))
    r = post("/remote/auth/login", {"username": "demo", "password": "alexiaguardian2026", "device_id": "e2e_phone", "device_name": "E2E Pixel", "platform": "Android"})
    session = r.json().get("session_token") if r.status_code == 200 else None
    c.check("POST /remote/auth/login demo -> session token", bool(session), r.text[:200])
    r = post("/remote/auth/step-up", {"totp_code": "999999"})
    c.check("step-up with wrong TOTP -> 400", r.status_code == 400, str(r.status_code))
    r = post("/remote/auth/step-up", {"totp_code": "123456"})
    step_up = r.json().get("step_up_token") if r.status_code == 200 else None
    c.check("POST /remote/auth/step-up TOTP 123456 -> token", bool(step_up), r.text[:200])

    pending = get("/api/v1/approvals", params={"pending_only": "true"}).json()
    c.check("pending Tier-1 approvals exist after scenarios", len(pending) >= 2, str(len(pending)))
    if pending:
        target = pending[0]
        r = post(f"/api/v1/approvals/{target['id']}/approve", {"actor": "demo@e2e_phone"})
        c.check("approve WITHOUT step-up -> 401", r.status_code == 401, str(r.status_code))
        r = post(f"/api/v1/approvals/{target['id']}/approve", {"actor": "demo@e2e_phone", "step_up_method": "totp", "step_up_token": step_up})
        c.check(f"approve {target['action_name']} -> 200", r.status_code == 200, r.text[:200])
        r = post(f"/api/v1/approvals/{target['id']}/approve", {"actor": "demo@e2e_phone", "step_up_token": step_up})
        c.check("replayed approval rejected (single-use) -> 400", r.status_code == 400, str(r.status_code))
        if target.get("incident_id"):
            inc = get(f"/api/v1/incidents/{target['incident_id']}").json()
            c.check("approved incident advanced to resolved", inc.get("status") == "resolved", inc.get("status", "?"))
    if len(pending) > 1:
        r = post(f"/api/v1/approvals/{pending[1]['id']}/reject", {"actor": "demo@e2e_phone", "reason": "e2e reject"})
        c.check("reject second approval -> 200", r.status_code == 200, r.text[:200])
    all_appr = get("/api/v1/approvals").json()
    statuses = {a["id"]: a["status"] for a in all_appr}
    if pending:
        c.check("approval status persisted as approved", statuses.get(pending[0]["id"]) == "approved", str(statuses.get(pending[0]["id"])))
    if len(pending) > 1:
        c.check("approval status persisted as rejected", statuses.get(pending[1]["id"]) == "rejected", str(statuses.get(pending[1]["id"])))

    # 6. Kill switch ------------------------------------------------------------------
    print("\n[6] Autonomy kill switch (pause -> crash queued -> resume needs step-up)")
    r = post("/remote/autonomy", {"pause": True, "user": "demo", "device_id": "e2e_phone"})
    c.check("POST /remote/autonomy pause -> 200", r.status_code == 200 and r.json().get("is_paused") is True, r.text[:200])
    c.check("GET /remote/autonomy reports paused", get("/remote/autonomy").json().get("is_paused") is True, "")
    before = len(get("/api/v1/approvals", params={"pending_only": "true"}).json())
    r = post("/api/v1/scenarios/S2/run")
    paused_inc = r.json().get("incident_id") if r.status_code == 200 else None
    deadline = time.time() + 20  # Healer runs off the server loop, behind any events still queued
    after = get("/api/v1/approvals", params={"pending_only": "true"}).json()
    while len(after) <= before and time.time() < deadline:
        time.sleep(0.25)
        after = get("/api/v1/approvals", params={"pending_only": "true"}).json()
    c.check("crash while paused queues restart for approval", len(after) > before, f"{before} -> {len(after)}")
    if paused_inc:
        inc = get(f"/api/v1/incidents/{paused_inc}").json()
        c.check("crash incident while paused is not auto-resolved", inc.get("status") != "resolved", inc.get("status", "?"))
    r = post("/remote/autonomy", {"pause": False, "user": "demo", "device_id": "e2e_phone"})
    c.check("resume WITHOUT step-up -> 400", r.status_code == 400, str(r.status_code))
    r = post("/remote/autonomy", {"pause": False, "user": "demo", "device_id": "e2e_phone", "step_up_token": "demo.totp.1.forged"})
    c.check("resume with forged step-up -> 400", r.status_code == 400, str(r.status_code))
    r = post("/remote/autonomy", {"pause": False, "user": "demo", "device_id": "e2e_phone", "step_up_token": step_up})
    c.check("resume WITH step-up -> 200", r.status_code == 200 and r.json().get("is_paused") is False, r.text[:200])
    c.check("GET /remote/autonomy reports active", get("/remote/autonomy").json().get("is_paused") is False, "")

    # Remote controls (same catalog / tiers)
    r = post("/remote/controls", {"action": "restart_container", "target": "shoplite-api", "user": "demo", "device_id": "e2e_phone"})
    c.check("remote Tier-0 restart_container -> 200", r.status_code == 200, r.text[:200])
    r = post("/remote/controls", {"action": "rotate_secret", "target": "shoplite-api", "user": "demo", "device_id": "e2e_phone"})
    c.check("remote Tier-1 without step-up -> 400", r.status_code == 400, str(r.status_code))
    r = post("/remote/controls", {"action": "rotate_secret", "target": "shoplite-api", "user": "demo", "device_id": "e2e_phone", "step_up_token": step_up})
    c.check("remote Tier-1 with step-up -> 200", r.status_code == 200, r.text[:200])
    r = post("/remote/controls", {"action": "drop_database", "target": "shoplite-db", "user": "demo", "device_id": "e2e_phone", "step_up_token": step_up})
    c.check("remote Tier-2 drop_database forbidden -> 400", r.status_code == 400, str(r.status_code))
    devices = get("/remote/devices").json()
    c.check("e2e device registered", any(d.get("device_id") == "e2e_phone" for d in devices), json.dumps(devices)[:200])

    # 7. Rollback, restart, snapshots ------------------------------------------------
    print("\n[7] Deployment rollback, service restart, snapshots")
    r = post("/api/v1/deployments/dep_143_staged/rollback")
    c.check("POST /api/v1/deployments/dep_143_staged/rollback -> 200", r.status_code == 200 and r.json().get("status") == "success", r.text[:200])
    r = post("/api/v1/deployments/dep_missing/rollback")
    c.check("rollback unknown deployment -> 404", r.status_code == 404, str(r.status_code))
    r = post("/api/v1/services/svc_shoplite_api/restart")
    c.check("POST /api/v1/services/svc_shoplite_api/restart -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    r = post("/api/v1/services/svc_nope/restart")
    c.check("restart unknown service -> 404", r.status_code == 404, str(r.status_code))
    r = post("/api/v1/snapshots", {"service_name": "shoplite-api", "incident_id": "manual_operator"})
    snap = r.json() if r.status_code == 200 else {}
    c.check("POST /api/v1/snapshots -> sha256", len(snap.get("sha256", "")) == 64, r.text[:200])
    if snap.get("id"):
        listed = any(s.get("id") == snap["id"] for s in get("/api/v1/snapshots").json())
        c.check("new snapshot listed from disk", listed, snap["id"])
        r = post(f"/api/v1/snapshots/{snap['id']}/restore")
        queued = r.status_code == 200 and r.json().get("status") == "queued_for_approval"
        c.check("restore_snapshot is Tier 1: queued for approval", queued, r.text[:200])
        if queued:
            pend = get("/api/v1/approvals", params={"pending_only": "true"}).json()
            c.check("restore appears in pending approvals", any(a["id"] == r.json()["action_id"] for a in pend), "")

    # 8. Backup + audit chain ---------------------------------------------------------
    print("\n[8] Online SQLite backup & audit chain")
    proc = subprocess.run([sys.executable, "-m", "alexia.tools.backup"], cwd=REPO_ROOT, capture_output=True, text=True, timeout=120)
    c.check("python -m alexia.tools.backup exits 0", proc.returncode == 0, (proc.stdout + proc.stderr)[-300:])
    r = get("/api/v1/audit/verify")
    v = r.json()
    c.check(f"audit chain verified after run ({v.get('records_checked')} rows)", v.get("valid") is True and not v.get("verification_error"), json.dumps(v)[:300])

    sse.stop()
    total_frames = len(sse.frames)
    c.check(f"SSE delivered {total_frames} frames over the run", total_frames > len(SCENARIOS), str(total_frames))

    print("\n" + "=" * 70)
    print(f"LIVE E2E: {c.passed} passed, {len(c.failed)} failed")
    for f in c.failed:
        print(f"  FAIL {f}")
    return 0 if not c.failed else 1


if __name__ == "__main__":
    sys.exit(main())
