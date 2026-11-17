"""Durable SQLite connections shared by every Alexia state store.

SQLite is Alexia's system of record: events, incidents, approvals, runbooks, the
audit ledger, and the autonomy kill switch all live in `data/alexia.db`.  A
plain `sqlite3.connect()` is not enough for a guardian that must survive a
process crash or a power cut, so every connection created here gets:

- **WAL journaling** so a crash cannot leave a half-written rollback journal
  and readers never block the writer.
- **`synchronous=FULL`** so a committed incident/audit row is fsynced before
  the call returns.
- **A busy timeout** so the server, CLI, and desktop manager can share the same
  file without spurious `database is locked` errors.
- **Automatic close on context-manager exit.**  `with sqlite3.connect(...)`
  only manages the transaction; it does *not* close the file handle.  The
  connection factory below closes it, which matters on Windows where leaked
  handles prevent restarts from replacing the database.

Use `connect()` directly when you need a long-lived connection, or `connection()`
when a context manager is more convenient.
"""

from __future__ import annotations

import contextlib
import os
import sqlite3
from typing import Iterator, Tuple

BUSY_TIMEOUT_MS = 10_000


class DurableConnection(sqlite3.Connection):
    """SQLite connection that commits/rolls back *and closes* on `with` exit."""

    def __exit__(self, exc_type, exc_value, traceback):  # type: ignore[override]
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def connect(db_path: str, timeout: float = 10.0) -> DurableConnection:
    """Open a durable connection to `db_path`, creating parent directories."""
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    conn = sqlite3.connect(
        db_path,
        timeout=timeout,
        factory=DurableConnection,
        cached_statements=128,
    )
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    conn.execute("PRAGMA foreign_keys = ON")
    if db_path != ":memory:":
        mode = conn.execute("PRAGMA journal_mode").fetchone()
        if not mode or str(mode[0]).lower() != "wal":
            conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = FULL")
        conn.execute("PRAGMA wal_autocheckpoint = 1000")
    return conn


@contextlib.contextmanager
def connection(db_path: str, timeout: float = 10.0) -> Iterator[DurableConnection]:
    """Context-managed durable connection (commits on success, closes always)."""
    conn = connect(db_path, timeout=timeout)
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def quick_check_connection(conn: sqlite3.Connection) -> Tuple[bool, str]:
    """Run `PRAGMA quick_check` on an already-open connection.

    Stores must validate the connection they actually resolved (after any
    platform fallback) instead of probing a path that another process may hold
    open with exclusive sharing on Windows.
    """
    try:
        row = conn.execute("PRAGMA quick_check").fetchone()
    except sqlite3.DatabaseError as exc:  # corrupted or unreadable file
        return False, str(exc)
    detail = str(row[0]) if row else "no result"
    return detail.lower() == "ok", detail


def quick_check(db_path: str) -> Tuple[bool, str]:
    """Run SQLite's `PRAGMA quick_check`; returns (ok, detail)."""
    if not os.path.exists(db_path):
        return True, "database does not exist yet"
    try:
        with connection(db_path) as conn:
            return quick_check_connection(conn)
    except sqlite3.DatabaseError as exc:  # corrupted or unreadable file
        return False, str(exc)
