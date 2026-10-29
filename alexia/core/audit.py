"""Tamper-evident audit log backed by a cryptographic SHA-256 hash chain.

Implements FR-C8: Append-only ledger where every row stores:
    sha256(prev_hash + canonical_json(row))
Ensuring end-to-end auditability and tamper detection for all agent and user actions.
"""

from __future__ import annotations
import hashlib
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from alexia.core.schemas import AuditEntry

GENESIS_HASH = "0" * 64


class AuditLog:
    """Manages the append-only tamper-evident audit ledger in SQLite."""

    def __init__(self, db_path: str = "data/alexia.db"):
        if db_path == "data/alexia.db":
            if os.environ.get("ALEXIA_DB"):
                db_path = os.environ["ALEXIA_DB"]
            elif os.environ.get("ALEXIA_DATA_DIR"):
                db_path = os.path.join(os.environ["ALEXIA_DATA_DIR"], "alexia.db")
        self.db_path = db_path
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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                event_type TEXT NOT NULL,
                actor TEXT NOT NULL,
                details_json TEXT NOT NULL,
                prev_hash TEXT NOT NULL,
                hash TEXT NOT NULL
            )
            """
        )
        return conn


    def _init_db(self) -> None:
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    details_json TEXT NOT NULL,
                    prev_hash TEXT NOT NULL,
                    hash TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log (timestamp)"
            )
            conn.commit()

    @staticmethod
    def _compute_hash(prev_hash: str, timestamp: str, event_type: str, actor: str, details_json: str) -> str:
        """Deterministically calculate SHA-256 hash for row contents."""
        payload = f"{prev_hash}|{timestamp}|{event_type}|{actor}|{details_json}".encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def record(self, event_type: str, actor: str, details: Dict[str, Any]) -> AuditEntry:
        """Append a new event entry onto the cryptographic hash chain."""
        canonical_details = json.dumps(details, sort_keys=True, separators=(",", ":"))
        timestamp = datetime.now(timezone.utc).isoformat()

        with self._lock, self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1")
            last_row = cursor.fetchone()

            if last_row:
                prev_hash = last_row["hash"]
            else:
                prev_hash = GENESIS_HASH

            row_hash = self._compute_hash(
                prev_hash=prev_hash,
                timestamp=timestamp,
                event_type=event_type,
                actor=actor,
                details_json=canonical_details,
            )

            cursor.execute(
                """
                INSERT INTO audit_log (timestamp, event_type, actor, details_json, prev_hash, hash)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (timestamp, event_type, actor, canonical_details, prev_hash, row_hash),
            )
            row_id = cursor.lastrowid
            conn.commit()

            return AuditEntry(
                id=row_id,
                timestamp=timestamp,
                event_type=event_type,
                actor=actor,
                details=details,
                prev_hash=prev_hash,
                hash=row_hash,
            )

    def get_entries(self, limit: int = 100, offset: int = 0) -> List[AuditEntry]:
        """Fetch audit log entries in reverse chronological order."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, timestamp, event_type, actor, details_json, prev_hash, hash
                FROM audit_log
                ORDER BY id DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            )
            rows = cursor.fetchall()
            entries: List[AuditEntry] = []
            for row in rows:
                try:
                    details = json.loads(row["details_json"])
                except Exception:
                    details = {}
                entries.append(
                    AuditEntry(
                        id=row["id"],
                        timestamp=row["timestamp"],
                        event_type=row["event_type"],
                        actor=row["actor"],
                        details=details,
                        prev_hash=row["prev_hash"],
                        hash=row["hash"],
                    )
                )
            return entries

    def verify_chain(self) -> Tuple[bool, int, Optional[str]]:
        """Verify the cryptographic integrity of the entire audit chain.

        Returns:
            Tuple of (is_valid, verified_rows_count, error_message_if_any)
        """
        with self._lock, self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, timestamp, event_type, actor, details_json, prev_hash, hash
                FROM audit_log
                ORDER BY id ASC
                """
            )
            rows = cursor.fetchall()

            if not rows:
                return True, 0, None

            expected_prev_hash = GENESIS_HASH

            for index, row in enumerate(rows):
                # 1. Verify link to previous row
                if row["prev_hash"] != expected_prev_hash:
                    return (
                        False,
                        index,
                        f"Chain broken at row {row['id']}: expected prev_hash {expected_prev_hash}, got {row['prev_hash']}",
                    )

                # 2. Recompute row hash
                recomputed_hash = self._compute_hash(
                    prev_hash=row["prev_hash"],
                    timestamp=row["timestamp"],
                    event_type=row["event_type"],
                    actor=row["actor"],
                    details_json=row["details_json"],
                )

                if row["hash"] != recomputed_hash:
                    return (
                        False,
                        index,
                        f"Tampered row data at row {row['id']}: stored hash {row['hash']} does not match recomputed {recomputed_hash}",
                    )

                expected_prev_hash = row["hash"]

            return True, len(rows), None


# Singleton instance for platform-wide access
_global_audit_log: Optional[AuditLog] = None


def get_audit_log(db_path: str = "data/alexia.db") -> AuditLog:
    """Retrieve or initialize the global AuditLog instance."""
    global _global_audit_log
    if _global_audit_log is None or _global_audit_log.db_path != db_path:
        _global_audit_log = AuditLog(db_path=db_path)
    return _global_audit_log
