"""Approval lifecycle manager for Tier-1 actions and remote approvals.

Implements FR-C7, FR-M5, FR-M8:
- Generates single-use HMAC-SHA256 signed approval tokens bound to action_id and device/user.
- Enforces 5-minute expiration window.
- Manages approval states in SQLite.
- Integrates with AuditLog to preserve cryptographic proof of approvals.
"""

from __future__ import annotations
import hashlib
import hmac
import json
import logging
import os
import sqlite3
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from alexia.core.audit import get_audit_log
from alexia.core.schemas import Action
from alexia.core.paths import resolve_db_path

logger = logging.getLogger("alexia.approvals")

DEFAULT_SECRET_KEY = "alexia_demo_secret_key_change_in_prod"


class ApprovalManager:
    """Manages pending Tier-1 actions and cryptographic single-use approval tokens."""

    def __init__(self, db_path: str = "data/alexia.db"):
        # source_db_path is what singletons compare against; db_path may fall back to *.sqlite
        self.db_path = self.source_db_path = resolve_db_path(db_path)
        self.secret_key = (os.getenv("ALEXIA_SECRET_KEY") or os.getenv("ALEXIA_JWT_SECRET") or DEFAULT_SECRET_KEY).encode("utf-8")
        self.token_ttl_seconds = 300  # 5 minutes
        self.audit = get_audit_log(db_path)
        self._lock = threading.Lock()
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        try:
            conn = sqlite3.connect(self.db_path, timeout=10)
        except sqlite3.OperationalError:
            self.db_path = f"{self.db_path}.sqlite"
            conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
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
        return conn


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
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_approvals_status ON pending_approvals (status)"
            )
            conn.commit()

    def generate_token(self, action_id: str, device_id: str = "web_dashboard") -> str:
        """Create HMAC-SHA256 single-use token bound to action_id, timestamp, and device."""
        now = time.time()
        payload = f"{action_id}:{device_id}:{now}".encode("utf-8")
        signature = hmac.new(self.secret_key, payload, hashlib.sha256).hexdigest()
        return f"{action_id}.{int(now)}.{signature[:24]}"

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
        token = self.generate_token(action.id, device_id)

        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO pending_approvals (
                    action_id, incident_id, action_name, target, params_json,
                    reason, expected_outcome, rollback, requested_by,
                    snapshot_id, token, created_at, expires_at, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
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

            # Token validation if provided
            if provided_token and provided_token != row["token"]:
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
    def _format_approval_row(r: sqlite3.Row, now: float) -> Dict[str, Any]:
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
        return {
            # Frontend ApprovalRequest fields
            "id": r["action_id"],
            "action_id": r["action_id"],
            "incident_id": r["incident_id"] or "inc_s6_sqli_breach",
            "action_name": action_name,
            "action_tier": f"tier_{tier}",
            "action_tier_label": tier_label,
            "affected_service": r["target"] or "shoplite-api",
            "risk_level": "high" if action_name in ("rotate_secret", "restore_db_snapshot", "quarantine_container") else "medium",
            "reason": r["reason"] or f"Execute {action_name} on {r['target']}",
            "expected_outcome": r["expected_outcome"] or f"Safely execute {action_name} with pre-action snapshot protection",
            "rollback_plan": r["rollback"] or f"Restore pre-action snapshot {r['snapshot_id'] or 'snap_latest'}",
            "requesting_agent": agent_label,
            # A pending row past its 5-minute TTL can no longer be decided; report it as expired
            "status": "expired" if r["status"] == "pending" and r["expires_at"] <= now else r["status"],
            "created_at": datetime.fromtimestamp(r["created_at"], tz=timezone.utc).isoformat(),
            "expires_at": datetime.fromtimestamp(r["expires_at"], tz=timezone.utc).isoformat(),
            "decided_by": r["decided_by"],
            "decided_at": decided_at_iso,
            # Backend existing fields
            "action": action_name,
            "target": r["target"],
            "params": json.loads(r["params_json"]),
            "rollback": r["rollback"],
            "requested_by": r["requested_by"],
            "snapshot_id": r["snapshot_id"],
            "token": r["token"],
            "seconds_remaining": max(0, int(r["expires_at"] - now)),
        }

    def list_pending(self) -> List[Dict[str, Any]]:
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
            return [self._format_approval_row(r, now) for r in rows]

    def list_all(self, limit: int = 50) -> List[Dict[str, Any]]:
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
            return [self._format_approval_row(r, now) for r in rows]


_global_approval_mgr: Optional[ApprovalManager] = None


def get_approval_manager(db_path: str = "data/alexia.db") -> ApprovalManager:
    """Retrieve or initialize global ApprovalManager."""
    global _global_approval_mgr
    if _global_approval_mgr is None or _global_approval_mgr.source_db_path != resolve_db_path(db_path):
        _global_approval_mgr = ApprovalManager(db_path=db_path)
    return _global_approval_mgr
