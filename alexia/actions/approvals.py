"""Approval lifecycle manager for Tier-1 actions and remote approvals.

Implements FR-C7, FR-M5, FR-M8:
- Generates single-use HMAC-SHA256 signed approval tokens bound to action_id, integer timestamp, and device_id.
- Enforces 5-minute expiration window and constant-time HMAC comparison.
- Manages approval states in SQLite without leaking raw secret tokens in unauthenticated listing calls.
- Integrates with AuditLog to preserve cryptographic proof of approvals.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import sqlite3
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from alexia.core.audit import get_audit_log
from alexia.core.config import secret_key
from alexia.core.paths import resolve_db_path
from alexia.core.schemas import Action
from alexia.core.sqlite import connect as sqlite_connect, resolve_openable_path

logger = logging.getLogger("alexia.approvals")


class ApprovalManager:
    """Manages pending Tier-1 actions and cryptographic single-use approval tokens."""

    def __init__(self, db_path: str = "data/alexia.db"):
        self.source_db_path = resolve_db_path(db_path)
        self.db_path = resolve_openable_path(self.source_db_path)
        self.token_ttl_seconds = 300  # 5 minutes
        self.audit = get_audit_log(db_path)
        self._lock = threading.Lock()
        self._init_db()

    @property
    def secret_key(self) -> bytes:
        return secret_key().encode("utf-8")

    def _get_connection(self) -> sqlite3.Connection:
        return sqlite_connect(self.db_path)

    def _init_db(self) -> None:
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS pending_approvals (
                    action_id TEXT PRIMARY KEY,
                    incident_id TEXT,
                    action_name TEXT NOT NULL,
                    target TEXT NOT NULL,
                    params_json TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    expected_outcome TEXT,
                    rollback TEXT,
                    requested_by TEXT NOT NULL,
                    snapshot_id TEXT,
                    device_id TEXT NOT NULL DEFAULT 'web_dashboard',
                    token TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    status TEXT NOT NULL,
                    decided_by TEXT,
                    decided_at REAL,
                    step_up_method TEXT
                )
                """
            )
            cols = {row[1] for row in conn.execute("PRAGMA table_info(pending_approvals)").fetchall()}
            if "device_id" not in cols:
                conn.execute("ALTER TABLE pending_approvals ADD COLUMN device_id TEXT NOT NULL DEFAULT 'web_dashboard'")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_approvals_status ON pending_approvals (status)"
            )
            conn.commit()

    def generate_token(self, action_id: str, device_id: str = "web_dashboard", issued_at: Optional[int] = None) -> str:
        """Create verifiable HMAC-SHA256 single-use token bound to action_id, integer timestamp, and device_id."""
        ts = int(issued_at if issued_at is not None else time.time())
        payload = f"{action_id}:{device_id}:{ts}".encode("utf-8")
        signature = hmac.new(self.secret_key, payload, hashlib.sha256).hexdigest()
        return f"{action_id}.{ts}.{signature}"

    def verify_action_token(self, action_id: str, token: str, device_id: str = "web_dashboard") -> bool:
        """Recompute and constant-time verify an approval token."""
        if not token:
            return False
        parts = token.split(".")
        if len(parts) != 3:
            return False
        tok_action_id, ts_str, sig = parts
        if tok_action_id != action_id or not ts_str.isdigit():
            return False
        expected = self.generate_token(action_id, device_id=device_id, issued_at=int(ts_str))
        return hmac.compare_digest(token, expected)

    def create_pending_approval(
        self,
        action: Action,
        incident_id: Optional[str] = None,
        snapshot_id: Optional[str] = None,
        device_id: str = "web_dashboard",
    ) -> str:
        """Queue a Tier-1 action for human approval and return token."""
        now = time.time()
        expires_at = now + self.token_ttl_seconds
        token = self.generate_token(action.id, device_id=device_id, issued_at=int(now))

        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO pending_approvals (
                    action_id, incident_id, action_name, target, params_json,
                    reason, expected_outcome, rollback, requested_by,
                    snapshot_id, device_id, token, created_at, expires_at, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                """,
                (
                    action.id,
                    incident_id,
                    action.action,
                    action.target,
                    json.dumps(action.params),
                    action.reason,
                    action.expected_outcome,
                    action.rollback,
                    action.requested_by,
                    snapshot_id,
                    device_id,
                    token,
                    now,
                    expires_at,
                ),
            )
            conn.commit()

        self.audit.record(
            event_type="approval_requested",
            actor=action.requested_by,
            details={
                "action_id": action.id,
                "action": action.action,
                "target": action.target,
                "reason": action.reason,
                "snapshot_id": snapshot_id,
                "expires_at": datetime.fromtimestamp(expires_at, tz=timezone.utc).isoformat(),
            },
        )
        return token

    def decide(
        self,
        action_id: str,
        decision: str,  # "approved" or "rejected"
        decided_by: str = "human:operator",
        step_up_method: Optional[str] = None,
        provided_token: Optional[str] = None,
    ) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        """Approve or reject a pending Tier-1 action."""
        now = time.time()
        decision_lower = decision.lower().strip()
        if decision_lower not in ("approved", "rejected"):
            return False, "Decision must be 'approved' or 'rejected'", None

        with self._lock, self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT * FROM pending_approvals WHERE action_id = ?", (action_id,))
            row = cur.fetchone()

            if not row:
                return False, f"Approval request {action_id} not found.", None

            if row["status"] != "pending":
                return False, f"Action {action_id} was already {row['status']}.", None

            if now > row["expires_at"]:
                cur.execute(
                    "UPDATE pending_approvals SET status = 'expired' WHERE action_id = ?",
                    (action_id,),
                )
                conn.commit()
                return False, "Approval token has expired (5-minute TTL exceeded).", None

            if provided_token is not None and provided_token != "":
                stored_token = str(row["token"] or "")
                if not hmac.compare_digest(provided_token, stored_token):
                    return False, "Invalid approval token signature.", None

            cur.execute(
                """
                UPDATE pending_approvals
                SET status = ?, decided_by = ?, decided_at = ?, step_up_method = ?
                WHERE action_id = ?
                """,
                (decision_lower, decided_by, now, step_up_method, action_id),
            )
            conn.commit()

            action_data = {
                "action_id": row["action_id"],
                "incident_id": row["incident_id"],
                "action": row["action_name"],
                "target": row["target"],
                "params": json.loads(row["params_json"]),
                "reason": row["reason"],
                "snapshot_id": row["snapshot_id"],
                "status": decision_lower,
                "decided_by": decided_by,
                "step_up_method": step_up_method,
            }

        self.audit.record(
            event_type=f"action_{decision_lower}",
            actor=decided_by,
            details=action_data,
        )

        return True, f"Action {action_id} successfully {decision_lower}.", action_data

    @staticmethod
    def _format_approval_row(r: sqlite3.Row, now: float, include_token: bool = False) -> Dict[str, Any]:
        action_name = r["action_name"]
        tier = r["tier"] if "tier" in r.keys() else 1
        tier_label = "Tier 1 — Requires Human Approval" if tier == 1 else (
            "Tier 0 — Safe Auto" if tier == 0 else "Tier 2 — Forbidden"
        )
        req_by = r["requested_by"] or "Sentinel"
        agent_label = req_by.replace("agent:", "").title() if req_by.startswith("agent:") else req_by
        decided_at_iso = (
            datetime.fromtimestamp(r["decided_at"], tz=timezone.utc).isoformat()
            if r["decided_at"]
            else None
        )
        payload: Dict[str, Any] = {
            "id": r["action_id"],
            "action_id": r["action_id"],
            "incident_id": r["incident_id"] or "inc_s6_sqli_breach",
            "action_name": action_name,
            "action_tier": f"tier_{tier}",
            "action_tier_label": tier_label,
            "affected_service": r["target"] or "shoplite-api",
            "risk_level": "high" if action_name in ("rotate_secret", "restore_snapshot", "restore_db_snapshot", "isolate_container_network", "quarantine_container") else "medium",
            "reason": r["reason"] or f"Execute {action_name} on {r['target']}",
            "expected_outcome": r["expected_outcome"] or f"Safely execute {action_name} with pre-action snapshot protection",
            "rollback_plan": r["rollback"] or f"Restore pre-action snapshot {r['snapshot_id'] or 'snap_latest'}",
            "requesting_agent": agent_label,
            "status": "expired" if r["status"] == "pending" and r["expires_at"] <= now else r["status"],
            "created_at": datetime.fromtimestamp(r["created_at"], tz=timezone.utc).isoformat(),
            "expires_at": datetime.fromtimestamp(r["expires_at"], tz=timezone.utc).isoformat(),
            "decided_by": r["decided_by"],
            "decided_at": decided_at_iso,
            "action": action_name,
            "target": r["target"],
            "params": json.loads(r["params_json"]),
            "rollback": r["rollback"],
            "requested_by": r["requested_by"],
            "snapshot_id": r["snapshot_id"],
            "seconds_remaining": max(0, int(r["expires_at"] - now)),
        }
        if include_token:
            payload["token"] = r["token"]
        return payload

    def list_pending(self, include_token: bool = False) -> List[Dict[str, Any]]:
        """Return all currently active pending approval requests."""
        now = time.time()
        with self._lock, self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT * FROM pending_approvals
                WHERE status = 'pending' AND expires_at > ?
                ORDER BY created_at DESC
                """,
                (now,),
            )
            rows = cur.fetchall()
            return [self._format_approval_row(r, now, include_token=include_token) for r in rows]

    def list_all(self, limit: int = 50, include_token: bool = False) -> List[Dict[str, Any]]:
        """Return all approval requests (pending, approved, rejected, expired)."""
        now = time.time()
        with self._lock, self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT * FROM pending_approvals
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            )
            rows = cur.fetchall()
            return [self._format_approval_row(r, now, include_token=include_token) for r in rows]


_global_approval_mgr: Optional[ApprovalManager] = None


def get_approval_manager(db_path: str = "data/alexia.db") -> ApprovalManager:
    """Retrieve or initialize global ApprovalManager."""
    from alexia.core.sqlite import has_table

    global _global_approval_mgr
    if (
        _global_approval_mgr is None
        or _global_approval_mgr.source_db_path != resolve_db_path(db_path)
        or not has_table(_global_approval_mgr.db_path, "pending_approvals")
    ):
        _global_approval_mgr = ApprovalManager(db_path=db_path)
    return _global_approval_mgr
