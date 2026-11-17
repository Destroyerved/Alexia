"""Snapshot and database integrity tooling.

Implements FR-I1, FR-I2, FR-I4:
- Snapshots database and data volumes with SHA-256 hash recorded in the audit log.
- Performs integrity checks (checksums, row counts, table sanity).
- Enables one-click restore with post-restore verification.
"""

from __future__ import annotations
import hashlib
import json
import logging
import os
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from alexia.core.audit import get_audit_log
from alexia.core.schemas import generate_id
from alexia.core.paths import snapshot_dir
from alexia.core.sqlite import connect as sqlite_connect

logger = logging.getLogger("alexia.snapshots")

SNAPSHOT_DIR = snapshot_dir()


def shoplite_db_path() -> str:
    """Target database location, resolved at call time so env changes are honoured."""
    raw = os.getenv("DATABASE_URL", "sqlite:///./data/shoplite.db")
    return raw.replace("sqlite:///", "").replace("./", "", 1)


def _compute_file_sha256(filepath: str) -> str:
    hasher = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def _finalize_database_file(path: str, conn: sqlite3.Connection) -> None:
    """Checkpoint WAL data into the main file so a snapshot is one self-contained file.

    The SHA-256 metadata must cover every committed page.  Leaving data in a
    `-wal` sidecar would let the hash verify while the snapshot silently depends
    on a second file, and a restore could miss it after sidecar cleanup.
    """
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("PRAGMA journal_mode=DELETE")
    except sqlite3.DatabaseError:
        logger.warning("Could not checkpoint %s; snapshot may still have a WAL sidecar.", path)
    finally:
        conn.close()
    for suffix in ("-wal", "-shm"):
        try:
            os.remove(f"{path}{suffix}")
        except FileNotFoundError:
            pass


def create_snapshot(target: str = "shoplite-api", description: str = "") -> Dict[str, Any]:
    """Create a persistent snapshot of the database with SHA-256 audit verification.

    Uses SQLite's online backup API instead of copying the file: with WAL enabled a plain
    `copy2` can miss committed pages that still live in the -wal sidecar.
    """
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    snap_id = generate_id("snap")
    timestamp = datetime.now(timezone.utc).isoformat()
    snap_filename = f"{snap_id}_{target}.db"
    dest_path = os.path.join(SNAPSHOT_DIR, snap_filename)
    source_path = shoplite_db_path()

    # 1. Capture snapshot from SQLite target DB if present, or create synthetic DB
    if os.path.exists(source_path):
        src_conn = sqlite_connect(source_path)
        dst_conn = sqlite_connect(dest_path)
        try:
            src_conn.backup(dst_conn)
        finally:
            src_conn.close()
        _finalize_database_file(dest_path, dst_conn)
    else:
        # Create sample state file
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        conn = sqlite_connect(dest_path)
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS snapshot_meta (snap_id TEXT, created_at TEXT)")
            conn.execute("INSERT INTO snapshot_meta VALUES (?, ?)", (snap_id, timestamp))
            conn.commit()
        finally:
            _finalize_database_file(dest_path, conn)

    file_hash = _compute_file_sha256(dest_path)
    file_size = os.path.getsize(dest_path)

    metadata = {
        "id": snap_id,
        "target": target,
        "path": dest_path,
        "sha256": file_hash,
        "size_bytes": file_size,
        "description": description or f"Snapshot of {target}",
        "created_at": timestamp,
    }

    # Save meta json
    meta_path = os.path.join(SNAPSHOT_DIR, f"{snap_id}.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    # Record in tamper-evident audit log (FR-I1)
    audit = get_audit_log()
    audit.record(
        event_type="snapshot_created",
        actor="agent:integrity",
        details=metadata,
    )

    logger.info(f"Created snapshot {snap_id} (hash: {file_hash[:16]}...)")
    return metadata


def verify_snapshot(snapshot_id: str) -> Dict[str, Any]:
    """Re-hash a stored snapshot and compare it with the SHA-256 recorded at creation."""
    meta_path = os.path.join(SNAPSHOT_DIR, f"{snapshot_id}.json")
    if not os.path.exists(meta_path):
        return {"ok": False, "snapshot_id": snapshot_id, "error": "metadata not found"}
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except (OSError, ValueError) as exc:
        return {"ok": False, "snapshot_id": snapshot_id, "error": f"metadata unreadable: {exc}"}

    src_path = meta.get("path", "")
    if not os.path.exists(src_path):
        return {"ok": False, "snapshot_id": snapshot_id, "error": "snapshot file missing"}
    current_hash = _compute_file_sha256(src_path)
    ok = current_hash == meta.get("sha256")
    return {
        "ok": ok,
        "snapshot_id": snapshot_id,
        "expected_sha256": meta.get("sha256"),
        "actual_sha256": current_hash,
        "size_bytes": os.path.getsize(src_path),
        "created_at": meta.get("created_at"),
    }


def restore_snapshot(snapshot_id: str) -> Dict[str, Any]:
    """Restore the target database from a verified snapshot, then verify the result.

    The snapshot is copied through SQLite's backup API into a temporary file and atomically
    renamed over the live database, so an interrupted restore cannot leave a half-written file.
    """
    meta_path = os.path.join(SNAPSHOT_DIR, f"{snapshot_id}.json")
    if not os.path.exists(meta_path):
        raise FileNotFoundError(f"Snapshot metadata not found for {snapshot_id}")

    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    src_path = meta["path"]
    if not os.path.exists(src_path):
        raise FileNotFoundError(f"Snapshot data file not found at {src_path}")

    # Checksum verification before restore
    current_hash = _compute_file_sha256(src_path)
    if current_hash != meta["sha256"]:
        raise ValueError(
            f"Snapshot corruption detected! Stored hash {meta['sha256']} does not match current {current_hash}"
        )

    target_path = shoplite_db_path()
    os.makedirs(os.path.dirname(target_path) or ".", exist_ok=True)
    tmp_path = f"{target_path}.restore-{snapshot_id}.tmp"
    src_conn = sqlite_connect(src_path)
    dst_conn = sqlite_connect(tmp_path)
    try:
        src_conn.backup(dst_conn)
        check = dst_conn.execute("PRAGMA quick_check").fetchone()
        if not check or str(check[0]).lower() != "ok":
            raise ValueError(f"Restored copy failed SQLite quick_check: {check[0] if check else 'no result'}")
    finally:
        src_conn.close()
    _finalize_database_file(tmp_path, dst_conn)

    os.replace(tmp_path, target_path)
    # A restored main DB must not be paired with a stale WAL from the previous contents.
    for suffix in ("-wal", "-shm"):
        try:
            os.remove(f"{target_path}{suffix}")
        except FileNotFoundError:
            pass

    audit = get_audit_log()
    audit.record(
        event_type="snapshot_restored",
        actor="agent:integrity",
        details={"snapshot_id": snapshot_id, "restored_path": target_path, "sha256": current_hash},
    )

    logger.info(f"Restored snapshot {snapshot_id} to {target_path}")
    return {"status": "success", "success": True, "snapshot_id": snapshot_id, "restored_to": target_path}



def verify_integrity(target: str = "shoplite-api") -> Dict[str, Any]:
    """Execute scheduled integrity checks: table presence, row counts, quick sanity check."""
    db_path = shoplite_db_path()
    status: Dict[str, Any] = {
        "target": target,
        "database_exists": os.path.exists(db_path),
        "tables": {},
        "integrity_ok": True,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    if status["database_exists"]:
        try:
            with sqlite_connect(db_path) as conn:
                cur = conn.cursor()
                cur.execute("PRAGMA quick_check")
                quick_res = cur.fetchone()
                status["integrity_ok"] = bool(quick_res and quick_res[0] == "ok")

                cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
                tables = [r[0] for r in cur.fetchall()]
                for t in tables:
                    try:
                        cur.execute(f"SELECT COUNT(*) FROM '{t}'")
                        cnt = cur.fetchone()[0]
                        status["tables"][t] = cnt
                    except Exception:
                        pass
        except Exception as e:
            status["integrity_ok"] = False
            status["error"] = str(e)

    audit = get_audit_log()
    audit.record(
        event_type="integrity_check_completed",
        actor="agent:integrity",
        details=status,
    )
    return status


def list_snapshots() -> List[Dict[str, Any]]:
    """List all saved snapshots with metadata."""
    if not os.path.exists(SNAPSHOT_DIR):
        return []
    snapshots = []
    for f in os.listdir(SNAPSHOT_DIR):
        if f.endswith(".json"):
            try:
                with open(os.path.join(SNAPSHOT_DIR, f), "r") as jf:
                    snapshots.append(json.load(jf))
            except Exception:
                pass
    return sorted(snapshots, key=lambda x: x.get("created_at", ""), reverse=True)
