"""Online SQLite database backup tool for Alexia DevSecOps Guardian.

Creates consistent online backups of `alexia.db` using SQLite's native backup API
into `ALEXIA_BACKUP_DIR` (default `backups/` or `C:\\Alexia\\backups`) as
`alexia-YYYYMMDD-HHMMSS.db`, mirrors to `ALEXIA_BACKUP_COPY_DIR` if configured,
and prunes backups older than `ALEXIA_BACKUP_KEEP` (default 14).
"""

from __future__ import annotations
import datetime
import os
import re
import sys
from typing import Dict, Any, List, Optional

from alexia.core.sqlite import connect as sqlite_connect

BACKUP_NAME_RE = re.compile(r"^alexia-\d{8}-\d{6}\.db$")


def _remove_sidecars(path: str) -> None:
    for suffix in ("-wal", "-shm"):
        try:
            os.remove(f"{path}{suffix}")
        except FileNotFoundError:
            pass


def _copy_database(src_path: str, dst_path: str) -> None:
    """Copy a live SQLite database into one self-contained, checked file."""
    src_conn = sqlite_connect(src_path, timeout=15)
    dst_conn = sqlite_connect(dst_path, timeout=15)
    try:
        src_conn.backup(dst_conn)
        check = dst_conn.execute("PRAGMA quick_check").fetchone()
        if not check or str(check[0]).lower() != "ok":
            raise RuntimeError(f"SQLite copy failed quick_check: {check[0] if check else 'no result'}")
        dst_conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        dst_conn.execute("PRAGMA journal_mode=DELETE")
    finally:
        dst_conn.close()
        src_conn.close()
    _remove_sidecars(dst_path)


def resolve_db_path() -> str:
    if os.environ.get("ALEXIA_DB"):
        return os.environ["ALEXIA_DB"]
    data_dir = os.environ.get("ALEXIA_DATA_DIR", "data")
    return os.path.join(data_dir, "alexia.db")


def run_backup() -> Dict[str, Any]:
    db_path = resolve_db_path()
    backup_dir = os.environ.get("ALEXIA_BACKUP_DIR", "backups")
    copy_dir = os.environ.get("ALEXIA_BACKUP_COPY_DIR", "").strip()
    keep = int(os.environ.get("ALEXIA_BACKUP_KEEP", "14") or "14")

    os.makedirs(backup_dir, exist_ok=True)
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)

    # Ensure source DB exists even on a fresh install
    if not os.path.exists(db_path):
        from alexia.core.audit import get_audit_log
        from alexia.core.bus import get_event_bus

        get_event_bus(db_path=db_path)
        get_audit_log(db_path=db_path)

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"alexia-{stamp}.db"
    dest_path = os.path.join(backup_dir, filename)

    _copy_database(db_path, dest_path)

    size_bytes = os.path.getsize(dest_path)
    print(f"[backup] Saved {dest_path} ({size_bytes} bytes)")

    copied = False
    if copy_dir:
        try:
            os.makedirs(copy_dir, exist_ok=True)
            copy_dest = os.path.join(copy_dir, filename)
            shutil.copy2(dest_path, copy_dest)
            copied = True
            print(f"[backup] Mirrored second copy to {copy_dest}")
        except Exception as exc:
            print(f"[backup] Warning: could not copy to {copy_dir}: {exc}", file=sys.stderr)

    # Prune old backups beyond keep count
    for folder in [backup_dir, copy_dir if copied else None]:
        if not folder or not os.path.exists(folder):
            continue
        files = sorted(
            [f for f in os.listdir(folder) if BACKUP_NAME_RE.match(f)],
            reverse=True,
        )
        for old_file in files[keep:]:
            try:
                os.remove(os.path.join(folder, old_file))
                print(f"[backup] Pruned old backup {old_file} from {folder}")
            except Exception:
                pass

    return {
        "name": filename,
        "path": dest_path,
        "bytes": size_bytes,
        "copied": copied,
    }


def list_backups() -> List[Dict[str, Any]]:
    """Return available online backups, newest first."""
    backup_dir = os.environ.get("ALEXIA_BACKUP_DIR", "backups")
    if not os.path.isdir(backup_dir):
        return []
    items: List[Dict[str, Any]] = []
    for name in sorted(os.listdir(backup_dir), reverse=True):
        if not BACKUP_NAME_RE.match(name):
            continue
        path = os.path.join(backup_dir, name)
        items.append({"name": name, "path": path, "bytes": os.path.getsize(path)})
    return items


def restore_backup(name: Optional[str] = None) -> Dict[str, Any]:
    """Restore `alexia.db` from an online backup (newest by default).

    The backup is copied through SQLite's backup API into a temp file, checked, and
    atomically renamed over the live database. The pre-restore database is kept aside
    so an operator can recover from choosing the wrong backup.
    """
    backups = list_backups()
    if not backups:
        raise FileNotFoundError("No Alexia backups are available to restore.")
    chosen = next((b for b in backups if b["name"] == name), None) if name else backups[0]
    if chosen is None:
        raise FileNotFoundError(f"Backup {name!r} was not found.")

    db_path = resolve_db_path()
    tmp_path = f"{db_path}.restore.tmp"
    pre_restore = f"{db_path}.pre-restore-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"

    _copy_database(chosen["path"], tmp_path)

    if os.path.exists(db_path):
        # Online backup rather than copy2: committed pages may still be in the live WAL.
        _copy_database(db_path, pre_restore)
    os.replace(tmp_path, db_path)
    _remove_sidecars(db_path)

    from alexia.core.audit import get_audit_log

    get_audit_log(db_path).record(
        event_type="database_restored_from_backup",
        actor="user:operator",
        details={"backup": chosen["name"], "restored_path": db_path, "pre_restore_copy": pre_restore},
    )
    return {"success": True, "backup": chosen["name"], "restored_to": db_path, "pre_restore_copy": pre_restore}


if __name__ == "__main__":
    run_backup()
