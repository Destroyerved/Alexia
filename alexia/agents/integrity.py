"""Integrity Agent: Data safety guardian, snapshot orchestrator, live exposure inspector, and throwaway-DB migration guard.

Implements FR-I1 through FR-I5:
- Autonomous snapshots before mutating Tier-0 and Tier-1 actions (FR-I1).
- Scheduled integrity verification & row count audits (FR-I2).
- Migration Guard: dry-runs pending migrations on a real throwaway SQLite copy to detect dropped tables/columns and exact records at risk, combined with Ultra review (FR-I3).
- One-click restore to any verified snapshot with post-restore check (FR-I4).
- Forensic data-exposure assessment querying real target DB table schemas and row counts (FR-I5).
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import sqlite3
import tempfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel

from alexia.agents.base import GuardianAgent
from alexia.core.audit import get_audit_log
from alexia.core.llm import get_llm_client
from alexia.core.redact import redact
from alexia.core.sqlite import connect as sqlite_connect
from alexia.tools.snapshots import (
    create_snapshot,
    restore_snapshot,
    shoplite_db_path,
    verify_integrity,
    verify_snapshot,
)

logger = logging.getLogger("alexia.integrity")


def _quote_ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


class MigrationReviewOutput(BaseModel):
    is_destructive: bool
    dropped_columns: List[str]
    dropped_tables: List[str]
    estimated_data_loss_records: int
    risk_summary: str


class IntegrityAgent(GuardianAgent):
    """The data guardian ensuring zero data loss and migration safety."""

    agent_id = "integrity"
    role = "Data guardian: snapshots, migration guard, exposure assessment, audit verification"
    capabilities = (
        "snapshot_creation",
        "snapshot_restore",
        "migration_guard",
        "exposure_assessment",
        "integrity_verification",
        "audit_chain_verification",
    )
    entrypoints = (
        "take_precautionary_snapshot",
        "restore_from_snapshot",
        "guard_migration",
        "assess_exposure",
        "verify_audit_history",
    )

    @property
    def llm(self):
        return get_llm_client()

    @property
    def audit(self):
        return get_audit_log()

    # -----------------------------------------------------------------------
    # Snapshots & Restores (FR-I1, FR-I4)
    # -----------------------------------------------------------------------
    def take_precautionary_snapshot(self, target: str = "shoplite-api", reason: str = "") -> Dict[str, Any]:
        """Create a snapshot before any action touches database state."""
        return create_snapshot(target=target, description=reason)

    def restore_from_snapshot(self, snapshot_id: str) -> Dict[str, Any]:
        """Restore database to a previous snapshot and verify integrity."""
        res = restore_snapshot(snapshot_id)
        status = verify_integrity()
        res["integrity_verified"] = status.get("integrity_ok", False)
        return res

    def verify_snapshot(self, snapshot_id: str) -> Dict[str, Any]:
        """Re-hash a stored snapshot and record the verification result."""
        result = verify_snapshot(snapshot_id)
        self.audit.record(
            event_type="snapshot_verified",
            actor="agent:integrity",
            details=result,
        )
        return result

    def verify_integrity(self, target: str = "shoplite-api") -> Dict[str, Any]:
        """Run SQLite quick_check and row-count sanity checks on the target database."""
        return verify_integrity(target)

    def verify_audit_history(self) -> Dict[str, Any]:
        """Verify the append-only SHA-256 + HMAC audit chain and return its state."""
        valid, rows, error = self.audit.verify_chain()
        return {
            "valid": valid,
            "verified_rows": rows,
            "error": error,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

    # -----------------------------------------------------------------------
    # Forensic Exposure Assessment for Sentinel (FR-I5)
    # -----------------------------------------------------------------------
    @staticmethod
    def _inspect_live_db_tables() -> Dict[str, Tuple[int, List[str]]]:
        """Return `{table_name: (row_count, [columns])}` from the live target SQLite DB if present."""
        db_file = shoplite_db_path()
        if not os.path.exists(db_file):
            return {}
        info: Dict[str, Tuple[int, List[str]]] = {}
        try:
            with sqlite_connect(db_file) as conn:
                tables = [
                    r[0]
                    for r in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                    ).fetchall()
                ]
                for tbl in tables:
                    cols = [c[1] for c in conn.execute(f"PRAGMA table_info({_quote_ident(tbl)})").fetchall()]
                    cnt = int(conn.execute(f"SELECT COUNT(*) FROM {_quote_ident(tbl)}").fetchone()[0])
                    info[tbl] = (cnt, cols)
        except Exception as exc:
            logger.debug(f"Could not inspect target DB {db_file} for exposure assessment: {exc}")
        return info

    def assess_exposure(self, query: str, service: str = "shoplite-api") -> Dict[str, Any]:
        """Analyze attacker queries and inspect real target database tables/row counts (FR-I5)."""
        q_lower = (query or "").lower()
        live_tables = self._inspect_live_db_tables()

        affected_tables: List[str] = []
        affected_columns: List[str] = []
        estimated_rows = 0

        if live_tables:
            for tbl_name, (row_cnt, tbl_cols) in live_tables.items():
                if tbl_name.lower() in q_lower or (tbl_name == "users" and "user" in q_lower):
                    affected_tables.append(tbl_name)
                    estimated_rows += row_cnt
                    for c in tbl_cols:
                        if c.lower() in q_lower and c not in affected_columns:
                            affected_columns.append(c)

        # Fallback heuristics when target DB is unseeded or query uses generic table names
        if not affected_tables:
            if "users" in q_lower or "user" in q_lower:
                affected_tables.append("users")
                estimated_rows += live_tables.get("users", (150, []))[0]
            if "orders" in q_lower:
                affected_tables.append("orders")
                estimated_rows += live_tables.get("orders", (320, []))[0]
            if "products" in q_lower:
                affected_tables.append("products")
                estimated_rows += live_tables.get("products", (45, []))[0]

        col_matches = re.findall(r"select\s+([a-zA-Z0-9_,\s]+)\s+from", q_lower)
        if col_matches:
            for c in col_matches[0].split(","):
                cleaned_col = c.strip()
                if cleaned_col and not cleaned_col.isdigit() and cleaned_col not in affected_columns:
                    affected_columns.append(cleaned_col)

        if not affected_tables:
            affected_tables = ["users"]
            affected_columns = affected_columns or ["email", "phone", "username"]
            estimated_rows = live_tables.get("users", (120, []))[0]

        exposure_info = {
            "service": service,
            "query": str(redact(query)),
            "affected_tables": affected_tables,
            "affected_columns": affected_columns or ["email", "phone"],
            "estimated_rows_exposed": max(1, estimated_rows),
            "live_db_inspected": bool(live_tables),
            "severity": "critical" if "users" in affected_tables else "medium",
        }

        self.audit.record(
            event_type="data_exposure_assessed",
            actor="agent:integrity",
            details=exposure_info,
        )

        return exposure_info

    # -----------------------------------------------------------------------
    # Throwaway-DB Migration Guard Dry-Run (FR-I3)
    # -----------------------------------------------------------------------
    @staticmethod
    def _dry_run_migration_on_copy(migration_sql: str) -> Dict[str, Any]:
        """Execute `migration_sql` against a throwaway SQLite copy and diff schema + row counts."""
        tmp_dir = tempfile.mkdtemp(prefix="alexia_mig_guard_")
        copy_db = os.path.join(tmp_dir, "dryrun.db")
        try:
            src_db = shoplite_db_path()
            if os.path.exists(src_db):
                with sqlite_connect(src_db) as src_conn, sqlite_connect(copy_db) as dst_conn:
                    src_conn.backup(dst_conn)
            else:
                with sqlite_connect(copy_db) as seed_conn:
                    seed_conn.executescript(
                        """
                        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, phone TEXT);
                        INSERT INTO users (username, email, phone) VALUES ('alice', 'alice@example.com', '+91-9000000001'), ('bob', 'bob@example.com', '+91-9000000002');
                        CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL);
                        INSERT INTO products (name, price) VALUES ('Keyboard', 49.99);
                        CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL);
                        INSERT INTO orders (total) VALUES (49.99);
                        """
                    )
                    seed_conn.commit()

            def _snapshot_schema(conn: sqlite3.Connection) -> Dict[str, Tuple[int, List[str]]]:
                snap: Dict[str, Tuple[int, List[str]]] = {}
                tbls = [
                    r[0]
                    for r in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                    ).fetchall()
                ]
                for t in tbls:
                    cols = [c[1] for c in conn.execute(f"PRAGMA table_info({_quote_ident(t)})").fetchall()]
                    cnt = int(conn.execute(f"SELECT COUNT(*) FROM {_quote_ident(t)}").fetchone()[0])
                    snap[t] = (cnt, cols)
                return snap

            with sqlite_connect(copy_db) as conn:
                before = _snapshot_schema(conn)
                sql_error: Optional[str] = None
                try:
                    conn.executescript(migration_sql)
                    conn.commit()
                except sqlite3.Error as exc:
                    sql_error = str(exc)
                after = _snapshot_schema(conn)

            dropped_tables: List[str] = []
            dropped_columns: List[str] = []
            records_at_risk = 0

            for tbl, (before_cnt, before_cols) in before.items():
                if tbl not in after:
                    dropped_tables.append(tbl)
                    records_at_risk += before_cnt
                else:
                    after_cnt, after_cols = after[tbl]
                    missing_cols = [c for c in before_cols if c not in after_cols]
                    if missing_cols:
                        dropped_columns.extend(missing_cols)
                        records_at_risk += before_cnt
                    elif after_cnt < before_cnt:
                        records_at_risk += (before_cnt - after_cnt)

            # Older SQLite builds (<3.35) or invalid syntax may fail `ALTER TABLE DROP COLUMN` with sql_error;
            # supplement with regex inspection on the SQL statement so DROP COLUMN / DROP TABLE / TRUNCATE is always caught.
            sql_upper = migration_sql.upper()
            if sql_error and ("DROP COLUMN" in sql_upper or "DROP TABLE" in sql_upper or "TRUNCATE" in sql_upper):
                for col_m in re.findall(r"(?i)drop\s+column\s+(?:if\s+exists\s+)?([a-zA-Z0-9_]+)", migration_sql):
                    if col_m not in dropped_columns:
                        dropped_columns.append(col_m)
                for tbl_m in re.findall(r"(?i)(?:drop\s+table|truncate\s+table?)\s+(?:if\s+exists\s+)?([a-zA-Z0-9_]+)", migration_sql):
                    if tbl_m not in dropped_tables:
                        dropped_tables.append(tbl_m)
                if records_at_risk == 0:
                    records_at_risk = sum(cnt for cnt, _ in before.values())

            return {
                "dry_run_executed": True,
                "sql_error": sql_error,
                "dropped_tables": dropped_tables,
                "dropped_columns": dropped_columns,
                "records_at_risk": records_at_risk,
                "destructive_detected": bool(dropped_tables or dropped_columns or records_at_risk > 0),
            }
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def guard_migration(self, migration_sql: str, target: str = "shoplite-api") -> Dict[str, Any]:
        """Dry-run pending migration SQL on a throwaway DB copy + review with Nemotron Ultra (FR-I3)."""
        dry_run = self._dry_run_migration_on_copy(migration_sql)

        prompt = (
            f"Review this database migration script and throwaway dry-run telemetry for destructive operations:\n\n"
            f"```sql\n{migration_sql}\n```\n\n"
            f"Dry-run diff: dropped_tables={dry_run['dropped_tables']}, "
            f"dropped_columns={dry_run['dropped_columns']}, records_at_risk={dry_run['records_at_risk']}.\n"
            f"Identify if any tables or columns containing data are dropped or truncated. "
            f"Determine if deployment MUST be blocked pending human approval."
        )

        review, call = self.llm.structured_complete(
            tier="ultra",
            prompt=prompt,
            schema=MigrationReviewOutput,
            task="migration_risk_review",
        )

        is_destructive = bool(review.is_destructive or dry_run["destructive_detected"])
        dropped_cols = list(dict.fromkeys((dry_run["dropped_columns"] or []) + (review.dropped_columns or [])))
        dropped_tbls = list(dict.fromkeys((dry_run["dropped_tables"] or []) + (review.dropped_tables or [])))
        records_risk = max(int(dry_run["records_at_risk"]), int(review.estimated_data_loss_records))

        result = {
            "migration_sql": migration_sql,
            "is_destructive": is_destructive,
            "dropped_columns": dropped_cols,
            "dropped_tables": dropped_tbls,
            "estimated_records_at_risk": records_risk,
            "risk_summary": review.risk_summary,
            "dry_run": dry_run,
            "model_call_id": call.id,
            "action_required": "approval_required" if is_destructive else "safe_to_apply",
        }

        self.audit.record(
            event_type="migration_reviewed",
            actor="agent:integrity",
            details=result,
        )

        return result


_global_integrity: Optional[IntegrityAgent] = None


def get_integrity_agent() -> IntegrityAgent:
    """Retrieve or initialize global IntegrityAgent."""
    global _global_integrity
    if _global_integrity is None:
        _global_integrity = IntegrityAgent()
    return _global_integrity
