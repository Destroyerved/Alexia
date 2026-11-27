"""Durable SQLite persistence for deployments, breach reports, platform settings,
operator notifications, and action idempotency records (NFR3).

Replaces ephemeral in-memory globals in `alexia/api/main.py` so every deployment,
rollback, regulatory report, setting change, notification read-state, and executed
action survives server restarts and multi-process access.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from alexia.core.config import is_demo_mode, is_production
from alexia.core.paths import resolve_db_path
from alexia.core.sqlite import connect as sqlite_connect, quick_check_connection, resolve_openable_path


DEFAULT_SETTINGS: Dict[str, Any] = {
    "demo_mode": True,
    "environment": "production-sandbox",
    "redaction_enabled": True,
    "step_up_auth_required": True,
    "daily_usd_budget": 10.0,
    "daily_token_budget": 5_000_000,
    "webhook_signature_verification": True,
    "auto_snapshot_before_tier1": True,
    "notifications_muted": False,
    "quiet_hours_start": "",
    "quiet_hours_end": "",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class StateStore:
    """Durable SQLite store for platform operational state."""

    def __init__(self, db_path: str = "data/alexia.db"):
        self.source_db_path = resolve_db_path(db_path)
        self.db_path = resolve_openable_path(self.source_db_path)
        self._lock = threading.Lock()
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        return sqlite_connect(self.db_path)

    def _init_db(self) -> None:
        with self._lock, self._get_connection() as conn:
            ok, detail = quick_check_connection(conn)
            if not ok:
                raise sqlite3.DatabaseError(
                    f"State store {self.db_path} failed startup integrity check: {detail}"
                )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS deployments (
                    id TEXT PRIMARY KEY,
                    service_id TEXT NOT NULL,
                    service_name TEXT NOT NULL,
                    version TEXT NOT NULL,
                    commit_sha TEXT NOT NULL,
                    author TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    status TEXT NOT NULL,
                    pre_deploy_review TEXT NOT NULL,
                    health_gate TEXT NOT NULL,
                    rollback_available INTEGER NOT NULL DEFAULT 1,
                    previous_version TEXT NOT NULL DEFAULT '',
                    notes TEXT NOT NULL DEFAULT '',
                    metadata_json TEXT NOT NULL DEFAULT '{}'
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS breach_reports (
                    id TEXT PRIMARY KEY,
                    incident_id TEXT NOT NULL,
                    framework TEXT NOT NULL,
                    framework_label TEXT NOT NULL,
                    deadline_hours INTEGER NOT NULL,
                    generated_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    affected_records_estimate INTEGER NOT NULL DEFAULT 0,
                    data_categories_json TEXT NOT NULL DEFAULT '[]',
                    containment_actions_json TEXT NOT NULL DEFAULT '[]',
                    root_cause TEXT NOT NULL DEFAULT '',
                    remediation_status TEXT NOT NULL DEFAULT '',
                    markdown TEXT NOT NULL DEFAULT ''
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS platform_settings (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    updated_by TEXT NOT NULL DEFAULT 'system'
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS notifications (
                    id TEXT PRIMARY KEY,
                    incident_id TEXT NOT NULL DEFAULT '',
                    severity TEXT NOT NULL DEFAULT 'medium',
                    title TEXT NOT NULL,
                    body TEXT NOT NULL,
                    deep_link TEXT NOT NULL DEFAULT '/',
                    actions_json TEXT NOT NULL DEFAULT '[]',
                    is_read INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS action_idempotency (
                    action_id TEXT PRIMARY KEY,
                    action_name TEXT NOT NULL,
                    target TEXT NOT NULL,
                    success INTEGER NOT NULL,
                    message TEXT NOT NULL,
                    result_json TEXT NOT NULL DEFAULT '{}',
                    executed_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    # ------------------------------------------------------------------
    # Platform Settings
    # ------------------------------------------------------------------
    def get_settings(self) -> Dict[str, Any]:
        defaults = dict(DEFAULT_SETTINGS)
        if is_production():
            defaults["demo_mode"] = is_demo_mode()
            defaults["environment"] = os.environ.get("ALEXIA_ENV_LABEL", "production")
        if os.environ.get("DAILY_USD_BUDGET"):
            try:
                defaults["daily_usd_budget"] = float(os.environ["DAILY_USD_BUDGET"])
            except ValueError:
                pass
        if os.environ.get("DAILY_TOKEN_BUDGET"):
            try:
                defaults["daily_token_budget"] = int(os.environ["DAILY_TOKEN_BUDGET"])
            except ValueError:
                pass

        with self._get_connection() as conn:
            rows = conn.execute("SELECT key, value_json FROM platform_settings").fetchall()
            for row in rows:
                try:
                    defaults[row["key"]] = json.loads(row["value_json"])
                except Exception:
                    pass
        return defaults

    def get_setting(self, key: str, default: Any = None) -> Any:
        settings = self.get_settings()
        return settings.get(key, default)

    def update_settings(self, updates: Dict[str, Any], updated_by: str = "operator") -> Dict[str, Any]:
        now = _now_iso()
        with self._lock, self._get_connection() as conn:
            for key, val in updates.items():
                conn.execute(
                    """
                    INSERT INTO platform_settings (key, value_json, updated_at, updated_by)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value_json = excluded.value_json,
                        updated_at = excluded.updated_at,
                        updated_by = excluded.updated_by
                    """,
                    (key, json.dumps(val), now, updated_by),
                )
            conn.commit()
        return self.get_settings()

    # ------------------------------------------------------------------
    # Deployments
    # ------------------------------------------------------------------
    def upsert_deployment(self, dep: Dict[str, Any]) -> Dict[str, Any]:
        review_val = str(dep.get("pre_deploy_Review") or dep.get("pre_deploy_review") or "passed")
        record = {
            "id": str(dep["id"]),
            "service_id": str(dep.get("service_id") or f"svc_{str(dep.get('service_name', 'shoplite_api')).replace('-', '_')}"),
            "service_name": str(dep.get("service_name") or "shoplite-api"),
            "version": str(dep.get("version") or "v1.4.2"),
            "commit_sha": str(dep.get("commit_sha") or "HEAD"),
            "author": str(dep.get("author") or "Deployer Agent"),
            "timestamp": str(dep.get("timestamp") or _now_iso()),
            "status": str(dep.get("status") or "healthy"),
            "pre_deploy_Review": review_val,
            "health_gate": str(dep.get("health_gate") or "passed"),
            "rollback_available": bool(dep.get("rollback_available", True)),
            "previous_version": str(dep.get("previous_version") or "v1.4.1"),
            "notes": str(dep.get("notes") or ""),
            "metadata": dep.get("metadata") or {},
        }
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO deployments (
                    id, service_id, service_name, version, commit_sha, author, timestamp,
                    status, pre_deploy_review, health_gate, rollback_available, previous_version, notes, metadata_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    pre_deploy_review = excluded.pre_deploy_review,
                    health_gate = excluded.health_gate,
                    rollback_available = excluded.rollback_available,
                    previous_version = excluded.previous_version,
                    notes = excluded.notes,
                    timestamp = excluded.timestamp,
                    metadata_json = excluded.metadata_json
                """,
                (
                    record["id"],
                    record["service_id"],
                    record["service_name"],
                    record["version"],
                    record["commit_sha"],
                    record["author"],
                    record["timestamp"],
                    record["status"],
                    record["pre_deploy_Review"],
                    record["health_gate"],
                    1 if record["rollback_available"] else 0,
                    record["previous_version"],
                    record["notes"],
                    json.dumps(record["metadata"]),
                ),
            )
            conn.commit()
        return record

    def list_deployments(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM deployments ORDER BY timestamp DESC LIMIT ?",
                (limit,),
            ).fetchall()
            out: List[Dict[str, Any]] = []
            for r in rows:
                try:
                    meta = json.loads(r["metadata_json"] or "{}")
                except Exception:
                    meta = {}
                out.append(
                    {
                        "id": r["id"],
                        "service_id": r["service_id"],
                        "service_name": r["service_name"],
                        "version": r["version"],
                        "commit_sha": r["commit_sha"],
                        "author": r["author"],
                        "timestamp": r["timestamp"],
                        "status": r["status"],
                        "pre_deploy_Review": r["pre_deploy_review"],
                        "health_gate": r["health_gate"],
                        "rollback_available": bool(r["rollback_available"]),
                        "previous_version": r["previous_version"],
                        "notes": r["notes"],
                        "metadata": meta,
                    }
                )
            return out

    def get_deployment(self, deployment_id: str) -> Optional[Dict[str, Any]]:
        for dep in self.list_deployments(limit=200):
            if dep["id"] == deployment_id:
                return dep
        return None

    # ------------------------------------------------------------------
    # Regulatory Breach Reports
    # ------------------------------------------------------------------
    def upsert_report(self, rep: Dict[str, Any]) -> Dict[str, Any]:
        record = {
            "id": str(rep["id"]),
            "incident_id": str(rep.get("incident_id") or ""),
            "framework": str(rep.get("framework") or "CERT-In"),
            "framework_label": str(rep.get("framework_label") or rep.get("framework") or "Regulatory Breach Notice"),
            "deadline_hours": int(rep.get("deadline_hours") or 72),
            "generated_at": str(rep.get("generated_at") or _now_iso()),
            "status": str(rep.get("status") or "draft_ready"),
            "summary": str(rep.get("summary") or ""),
            "affected_records_estimate": int(rep.get("affected_records_estimate") or 0),
            "data_categories_exposed": list(rep.get("data_categories_exposed") or []),
            "containment_actions_taken": list(rep.get("containment_actions_taken") or []),
            "root_cause": str(rep.get("root_cause") or ""),
            "remediation_status": str(rep.get("remediation_status") or ""),
            "markdown": str(rep.get("markdown") or ""),
        }
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO breach_reports (
                    id, incident_id, framework, framework_label, deadline_hours, generated_at,
                    status, summary, affected_records_estimate, data_categories_json,
                    containment_actions_json, root_cause, remediation_status, markdown
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    generated_at = excluded.generated_at,
                    status = excluded.status,
                    summary = excluded.summary,
                    affected_records_estimate = excluded.affected_records_estimate,
                    data_categories_json = excluded.data_categories_json,
                    containment_actions_json = excluded.containment_actions_json,
                    root_cause = excluded.root_cause,
                    remediation_status = excluded.remediation_status,
                    markdown = excluded.markdown
                """,
                (
                    record["id"],
                    record["incident_id"],
                    record["framework"],
                    record["framework_label"],
                    record["deadline_hours"],
                    record["generated_at"],
                    record["status"],
                    record["summary"],
                    record["affected_records_estimate"],
                    json.dumps(record["data_categories_exposed"]),
                    json.dumps(record["containment_actions_taken"]),
                    record["root_cause"],
                    record["remediation_status"],
                    record["markdown"],
                ),
            )
            conn.commit()
        return record

    def list_reports(self, incident_id: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            if incident_id:
                rows = conn.execute(
                    "SELECT * FROM breach_reports WHERE incident_id = ? ORDER BY generated_at DESC",
                    (incident_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM breach_reports ORDER BY generated_at DESC"
                ).fetchall()
            out: List[Dict[str, Any]] = []
            for r in rows:
                out.append(
                    {
                        "id": r["id"],
                        "incident_id": r["incident_id"],
                        "framework": r["framework"],
                        "framework_label": r["framework_label"],
                        "deadline_hours": r["deadline_hours"],
                        "generated_at": r["generated_at"],
                        "status": r["status"],
                        "summary": r["summary"],
                        "affected_records_estimate": r["affected_records_estimate"],
                        "data_categories_exposed": json.loads(r["data_categories_json"] or "[]"),
                        "containment_actions_taken": json.loads(r["containment_actions_json"] or "[]"),
                        "root_cause": r["root_cause"],
                        "remediation_status": r["remediation_status"],
                        "markdown": r["markdown"] or "",
                    }
                )
            return out

    def get_report(self, report_id: str) -> Optional[Dict[str, Any]]:
        for rep in self.list_reports():
            if rep["id"] == report_id:
                return rep
        return None

    # ------------------------------------------------------------------
    # Notifications Feed
    # ------------------------------------------------------------------
    def record_notification(self, notif: Dict[str, Any]) -> Dict[str, Any]:
        nid = str(notif.get("id") or f"ntf_{int(datetime.now(timezone.utc).timestamp() * 1000)}")
        created_at = str(notif.get("created_at") or notif.get("timestamp") or _now_iso())
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO notifications (id, incident_id, severity, title, body, deep_link, actions_json, is_read, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING
                """,
                (
                    nid,
                    str(notif.get("incident_id") or ""),
                    str(notif.get("severity") or "medium"),
                    str(notif.get("title") or "Alexia Alert"),
                    str(notif.get("body") or notif.get("message") or ""),
                    str(notif.get("deep_link") or "/"),
                    json.dumps(notif.get("actions") or []),
                    1 if notif.get("read") else 0,
                    created_at,
                ),
            )
            conn.commit()
        return {
            "id": nid,
            "incident_id": str(notif.get("incident_id") or ""),
            "severity": str(notif.get("severity") or "medium"),
            "title": str(notif.get("title") or "Alexia Alert"),
            "body": str(notif.get("body") or notif.get("message") or ""),
            "deep_link": str(notif.get("deep_link") or "/"),
            "read": bool(notif.get("read", False)),
            "created_at": created_at,
        }

    def list_notifications(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [
                {
                    "id": r["id"],
                    "incident_id": r["incident_id"],
                    "severity": r["severity"],
                    "title": r["title"],
                    "message": r["body"],
                    "body": r["body"],
                    "deep_link": r["deep_link"],
                    "actions": json.loads(r["actions_json"] or "[]"),
                    "read": bool(r["is_read"]),
                    "timestamp": r["created_at"],
                    "created_at": r["created_at"],
                }
                for r in rows
            ]

    def mark_notifications_read(self, notification_id: Optional[str] = None) -> int:
        with self._lock, self._get_connection() as conn:
            if notification_id:
                cur = conn.execute("UPDATE notifications SET is_read = 1 WHERE id = ?", (notification_id,))
            else:
                cur = conn.execute("UPDATE notifications SET is_read = 1 WHERE is_read = 0")
            conn.commit()
            return cur.rowcount

    # ------------------------------------------------------------------
    # Action Idempotency
    # ------------------------------------------------------------------
    def get_idempotent_outcome(self, action_id: str) -> Optional[Dict[str, Any]]:
        if not action_id:
            return None
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM action_idempotency WHERE action_id = ?",
                (action_id,),
            ).fetchone()
            if not row:
                return None
            try:
                res = json.loads(row["result_json"] or "{}")
            except Exception:
                res = {}
            return {
                "success": bool(row["success"]),
                "message": row["message"],
                "result": res,
                "executed_at": row["executed_at"],
            }

    def record_idempotent_outcome(
        self,
        action_id: str,
        action_name: str,
        target: str,
        success: bool,
        message: str,
        result: Dict[str, Any],
    ) -> None:
        if not action_id:
            return
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO action_idempotency (action_id, action_name, target, success, message, result_json, executed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(action_id) DO UPDATE SET
                    success = excluded.success,
                    message = excluded.message,
                    result_json = excluded.result_json,
                    executed_at = excluded.executed_at
                """,
                (
                    action_id,
                    action_name,
                    target,
                    1 if success else 0,
                    message,
                    json.dumps(result, default=str),
                    _now_iso(),
                ),
            )
            conn.commit()


_global_state_store: Optional[StateStore] = None


def get_state_store(db_path: str = "data/alexia.db") -> StateStore:
    from alexia.core.sqlite import has_table

    global _global_state_store
    resolved = resolve_db_path(db_path)
    if (
        _global_state_store is None
        or _global_state_store.source_db_path != resolved
        or not has_table(_global_state_store.db_path, "action_idempotency")
    ):
        _global_state_store = StateStore(db_path=db_path)
    return _global_state_store
