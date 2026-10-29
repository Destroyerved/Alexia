"""Runbook memory for instant resolution of repeated incidents.

Implements FR-C9:
- On resolution, stores (incident signature -> working fix actions).
- When a new incident occurs, checks if a similar signature exists.
- If matched, allows Nano to confirm and instantly replays the fix without expensive Ultra re-planning.
"""

from __future__ import annotations
import hashlib
import json
import logging
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from alexia.core.schemas import Action
from alexia.core.paths import resolve_db_path

logger = logging.getLogger("alexia.memory")


class RunbookMemory:
    """Manages persistent incident-to-fix runbooks in SQLite."""

    def __init__(self, db_path: str = "data/alexia.db"):
        # source_db_path is what singletons compare against; db_path may fall back to *.sqlite
        self.db_path = self.source_db_path = resolve_db_path(db_path)
        os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        self._lock = threading.Lock()
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        try:
            conn = sqlite3.connect(self.db_path, timeout=10)
        except sqlite3.OperationalError:
            self.db_path = f"{self.db_path}.sqlite"
            conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS runbooks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    signature TEXT UNIQUE NOT NULL,
                    category TEXT NOT NULL,
                    service TEXT NOT NULL,
                    root_cause TEXT NOT NULL,
                    actions_json TEXT NOT NULL,
                    success_count INTEGER NOT NULL DEFAULT 1,
                    last_applied_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_runbooks_sig ON runbooks (signature)")
            conn.commit()

    @staticmethod
    def generate_signature(category: str, service: str, error_indicator: str) -> str:
        """Create a normalized signature from incident category, service, and error pattern."""
        normalized = f"{category.strip().lower()}|{service.strip().lower()}|{error_indicator.strip().lower()}"
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]

    def record_runbook(
        self,
        category: str,
        service: str,
        error_indicator: str,
        root_cause: str,
        actions: List[Action],
    ) -> None:
        """Store or update a runbook entry for a successfully resolved incident."""
        sig = self.generate_signature(category, service, error_indicator)
        now = datetime.now(timezone.utc).isoformat()
        actions_json = json.dumps([a.model_dump() for a in actions])

        with self._lock, self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT id, success_count FROM runbooks WHERE signature = ?", (sig,))
            row = cur.fetchone()

            if row:
                cur.execute(
                    """
                    UPDATE runbooks
                    SET success_count = success_count + 1,
                        actions_json = ?,
                        root_cause = ?,
                        last_applied_at = ?
                    WHERE id = ?
                    """,
                    (actions_json, root_cause, now, row["id"]),
                )
            else:
                cur.execute(
                    """
                    INSERT INTO runbooks (
                        signature, category, service, root_cause, actions_json,
                        success_count, last_applied_at, created_at
                    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                    """,
                    (sig, category, service, root_cause, actions_json, now, now),
                )
            conn.commit()
        logger.info(f"Saved runbook for signature: {sig} ({category}/{service})")

    def find_matching_runbook(
        self,
        category: str,
        service: str,
        error_indicator: str,
    ) -> Optional[Dict[str, Any]]:
        """Look up if a known fix exists for the incident signature."""
        sig = self.generate_signature(category, service, error_indicator)
        with self._lock, self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT id, signature, category, service, root_cause, actions_json, success_count, last_applied_at
                FROM runbooks
                WHERE signature = ?
                """,
                (sig,),
            )
            row = cur.fetchone()
            if not row:
                return None

            actions_data = json.loads(row["actions_json"])
            actions = [Action(**a) for a in actions_data]

            return {
                "id": row["id"],
                "signature": row["signature"],
                "category": row["category"],
                "service": row["service"],
                "root_cause": row["root_cause"],
                "actions": actions,
                "success_count": row["success_count"],
                "last_applied_at": row["last_applied_at"],
            }

    def record_solution(self, incident: Any) -> Optional[Any]:
        """Record a successful solution from an Incident model."""
        if not hasattr(incident, "plan") or not incident.plan:
            return None
        service = incident.metadata.get("service", "shoplite-api") if hasattr(incident, "metadata") and incident.metadata else "shoplite-api"
        cause = incident.diagnosis.root_cause if hasattr(incident, "diagnosis") and incident.diagnosis and incident.diagnosis.root_cause else incident.title
        self.record_runbook(
            category=incident.category,
            service=service,
            error_indicator=cause,
            root_cause=cause,
            actions=incident.plan,
        )
        match = self.find_matching_runbook(
            category=incident.category,
            service=service,
            error_indicator=cause,
        )
        if not match:
            return None
        class MatchResult:
            def __init__(self, d):
                self.__dict__.update(d)
                self.actions = d.get("actions", [])
        return MatchResult(match)


    def find_match(self, service: str, category: str, error_text: str) -> Optional[Any]:
        """Convenience method matching find_matching_runbook returning an object with actions attribute."""
        match = self.find_matching_runbook(category=category, service=service, error_indicator=error_text)
        if not match:
            return None
        class MatchResult:
            def __init__(self, d):
                self.__dict__.update(d)
                self.actions = d.get("actions", [])
        return MatchResult(match)

    def list_runbooks(self) -> List[Dict[str, Any]]:

        """List all stored runbooks."""
        with self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT id, signature, category, service, root_cause, success_count, last_applied_at FROM runbooks ORDER BY success_count DESC"
            )
            rows = cur.fetchall()
            return [dict(r) for r in rows]


_global_memory: Optional[RunbookMemory] = None


def get_runbook_memory(db_path: str = "data/alexia.db") -> RunbookMemory:
    """Retrieve or initialize global RunbookMemory."""
    global _global_memory
    if _global_memory is None or _global_memory.source_db_path != resolve_db_path(db_path):
        _global_memory = RunbookMemory(db_path=db_path)
    return _global_memory
