"""Tamper-evident audit log backed by a cryptographic SHA-256 hash chain and keyed HMAC-SHA256 signatures.

Implements FR-C8: Append-only ledger where every row stores:
    hash      = sha256(prev_hash | timestamp | event_type | actor | canonical_json)
    signature = hmac_sha256(secret_key, prev_hash | timestamp | event_type | actor | canonical_json | hash)

Application connections install a SQLite authorizer that rejects UPDATE and DELETE operations on
`audit_log`, while `verify_chain()` validates both unkeyed SHA-256 hash links and keyed HMAC-SHA256
row signatures so offline database rewrites without `ALEXIA_SECRET_KEY` are detected.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from alexia.core.config import is_production, secret_key
from alexia.core.paths import resolve_db_path
from alexia.core.schemas import AuditEntry
from alexia.core.sqlite import connect as sqlite_connect, quick_check_connection, resolve_openable_path

GENESIS_HASH = "0" * 64


def _append_only_authorizer(action_code: int, arg1: Optional[str], arg2: Optional[str], db_name: Optional[str], trigger_name: Optional[str]) -> int:
    """Block UPDATE, DELETE, and DROP on audit_log from application connections."""
    if arg1 == "audit_log" and action_code in (sqlite3.SQLITE_DELETE, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DROP_TABLE):
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


class AuditLog:
    """Manages the append-only tamper-evident audit ledger in SQLite."""

    def __init__(self, db_path: str = "data/alexia.db", install_triggers: Optional[bool] = None):
        self.source_db_path = resolve_db_path(db_path)
        self.db_path = resolve_openable_path(self.source_db_path)
        self.install_triggers = is_production() if install_triggers is None else bool(install_triggers)
        os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
        self._lock = threading.Lock()
        self._init_db()

    def _get_connection(self, enforce_append_only: bool = False) -> sqlite3.Connection:
        conn = sqlite_connect(self.db_path)
        if enforce_append_only:
            conn.set_authorizer(_append_only_authorizer)
        return conn

    def _get_app_connection(self) -> sqlite3.Connection:
        return self._get_connection(enforce_append_only=True)

    def _init_db(self) -> None:
        with self._lock, self._get_connection(enforce_append_only=False) as conn:
            ok, detail = quick_check_connection(conn)
            if not ok:
                raise sqlite3.DatabaseError(
                    f"Audit ledger {self.db_path} failed its startup integrity check: {detail}"
                )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    details_json TEXT NOT NULL,
                    prev_hash TEXT NOT NULL,
                    hash TEXT NOT NULL,
                    signature TEXT NOT NULL DEFAULT ''
                )
                """
            )
            cols = {row[1] for row in conn.execute("PRAGMA table_info(audit_log)").fetchall()}
            if "signature" not in cols:
                conn.execute("ALTER TABLE audit_log ADD COLUMN signature TEXT NOT NULL DEFAULT ''")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log (timestamp)"
            )
            if self.install_triggers:
                conn.execute(
                    """
                    CREATE TRIGGER IF NOT EXISTS audit_log_no_update
                    BEFORE UPDATE ON audit_log
                    BEGIN
                        SELECT RAISE(ABORT, 'audit_log is append-only');
                    END;
                    """
                )
                conn.execute(
                    """
                    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
                    BEFORE DELETE ON audit_log
                    BEGIN
                        SELECT RAISE(ABORT, 'audit_log is append-only');
                    END;
                    """
                )
            conn.commit()

    @staticmethod
    def _compute_hash(prev_hash: str, timestamp: str, event_type: str, actor: str, details_json: str) -> str:
        """Deterministically calculate SHA-256 hash for row contents."""
        payload = f"{prev_hash}|{timestamp}|{event_type}|{actor}|{details_json}".encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    @staticmethod
    def _compute_signature(
        prev_hash: str,
        timestamp: str,
        event_type: str,
        actor: str,
        details_json: str,
        row_hash: str,
        key: Optional[str] = None,
    ) -> str:
        """Compute keyed HMAC-SHA256 signature binding row contents and chain link."""
        signing_key = (key if key is not None else secret_key()).encode("utf-8")
        payload = f"{prev_hash}|{timestamp}|{event_type}|{actor}|{details_json}|{row_hash}".encode("utf-8")
        digest = hmac.new(signing_key, payload, hashlib.sha256).hexdigest()
        return f"hmac-sha256:{digest}"

    def record(self, event_type: str, actor: str, details: Dict[str, Any]) -> AuditEntry:
        """Append a new event entry onto the cryptographic hash chain."""
        canonical_details = json.dumps(details, sort_keys=True, separators=(",", ":"), default=str)
        timestamp = datetime.now(timezone.utc).isoformat()

        with self._lock, self._get_app_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("BEGIN IMMEDIATE")
            cursor.execute("SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1")
            last_row = cursor.fetchone()

            prev_hash = last_row["hash"] if last_row else GENESIS_HASH

            row_hash = self._compute_hash(
                prev_hash=prev_hash,
                timestamp=timestamp,
                event_type=event_type,
                actor=actor,
                details_json=canonical_details,
            )
            signature = self._compute_signature(
                prev_hash=prev_hash,
                timestamp=timestamp,
                event_type=event_type,
                actor=actor,
                details_json=canonical_details,
                row_hash=row_hash,
            )

            cursor.execute(
                """
                INSERT INTO audit_log (timestamp, event_type, actor, details_json, prev_hash, hash, signature)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (timestamp, event_type, actor, canonical_details, prev_hash, row_hash, signature),
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
                signature=signature,
            )

    def get_entries(self, limit: int = 100, offset: int = 0) -> List[AuditEntry]:
        """Fetch audit log entries in reverse chronological order."""
        with self._get_app_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, timestamp, event_type, actor, details_json, prev_hash, hash, signature
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
                        signature=row["signature"] or "",
                    )
                )
            return entries

    def verify_chain(self, verify_signatures: bool = True) -> Tuple[bool, int, Optional[str]]:
        """Verify the cryptographic integrity of the entire audit chain.

        Returns:
            Tuple of (is_valid, verified_rows_count, error_message_if_any)
        """
        with self._lock, self._get_app_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, timestamp, event_type, actor, details_json, prev_hash, hash, signature
                FROM audit_log
                ORDER BY id ASC
                """
            )
            rows = cursor.fetchall()

            if not rows:
                return True, 0, None

            expected_prev_hash = GENESIS_HASH
            active_key = secret_key()

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

                # 3. Verify keyed HMAC-SHA256 row signature (defeats whole-chain hash recomputation attacks)
                stored_sig = row["signature"] or ""
                if verify_signatures and stored_sig.startswith("hmac-sha256:"):
                    expected_sig = self._compute_signature(
                        prev_hash=row["prev_hash"],
                        timestamp=row["timestamp"],
                        event_type=row["event_type"],
                        actor=row["actor"],
                        details_json=row["details_json"],
                        row_hash=recomputed_hash,
                        key=active_key,
                    )
                    if not hmac.compare_digest(stored_sig, expected_sig):
                        return (
                            False,
                            index,
                            f"Forged row signature at row {row['id']}: HMAC-SHA256 verification failed",
                        )

                expected_prev_hash = row["hash"]

            return True, len(rows), None


_global_audit_log: Optional[AuditLog] = None


def get_audit_log(db_path: str = "data/alexia.db") -> AuditLog:
    """Retrieve or initialize the global AuditLog instance."""
    from alexia.core.sqlite import has_table

    global _global_audit_log
    if (
        _global_audit_log is None
        or _global_audit_log.source_db_path != resolve_db_path(db_path)
        or not has_table(_global_audit_log.db_path, "audit_log")
    ):
        _global_audit_log = AuditLog(db_path=db_path)
    return _global_audit_log
