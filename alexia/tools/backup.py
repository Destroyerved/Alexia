"""Online SQLite database backup tool for Alexia DevSecOps Guardian.

Creates consistent online backups of `alexia.db` using SQLite's native backup API
into `ALEXIA_BACKUP_DIR` (default `backups/` or `C:\\Alexia\\backups`) as
`alexia-YYYYMMDD-HHMMSS.db`, mirrors to `ALEXIA_BACKUP_COPY_DIR` if configured,
verifies backups via `PRAGMA quick_check`, and prunes backups older than
`ALEXIA_BACKUP_KEEP` (default 14).
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import sys
from typing import Any, Dict, List, Optional

from alexia.core.sqlite import connect as sqlite_connect, quick_check

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
    """Return available online backups across main and second-copy folders, newest first."""
    backup_dir = os.environ.get("ALEXIA_BACKUP_DIR", "backups")
    copy_dir = os.environ.get("ALEXIA_BACKUP_COPY_DIR", "").strip()
    seen: Dict[str, Dict[str, Any]] = {}
    for folder in (backup_dir, copy_dir):
        if not folder or not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder), reverse=True):
            if not BACKUP_NAME_RE.match(name) or name in seen:
                continue
            path = os.path.join(folder, name)
            seen[name] = {"name": name, "path": path, "bytes": os.path.getsize(path)}
    return [seen[k] for k in sorted(seen.keys(), reverse=True)]


def verify_backup(name: Optional[str] = None) -> Dict[str, Any]:
    """Verify SQLite integrity (`PRAGMA quick_check`) of a stored backup."""
    backups = list_backups()
    if not backups:
        return {"ok": False, "error": "No Alexia backups exist yet."}
    chosen = next((b for b in backups if b["name"] == name), None) if name else backups[0]
    if chosen is None:
        return {"ok": False, "error": f"Backup {name!r} was not found."}
    ok, detail = quick_check(chosen["path"])
    return {"ok": ok, "name": chosen["name"], "path": chosen["path"], "bytes": chosen["bytes"], "detail": detail}


def restore_backup(name: Optional[str] = None) -> Dict[str, Any]:
    """Restore `alexia.db` from an online backup (newest by default) after verifying `PRAGMA quick_check`."""
    backups = list_backups()
    if not backups:
        raise FileNotFoundError("No Alexia backups are available to restore.")
    chosen = next((b for b in backups if b["name"] == name), None) if name else backups[0]
    if chosen is None:
        raise FileNotFoundError(f"Backup {name!r} was not found.")

    ok, detail = quick_check(chosen["path"])
    if not ok:
        raise ValueError(f"Refusing to restore corrupt backup {chosen['name']}: {detail}")

    db_path = resolve_db_path()
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    tmp_path = f"{db_path}.restore.tmp"
    pre_restore = f"{db_path}.pre-restore-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"

    _copy_database(chosen["path"], tmp_path)

    if os.path.exists(db_path):
        _copy_database(db_path, pre_restore)
    os.replace(tmp_path, db_path)
    _remove_sidecars(db_path)

    from alexia.core.audit import get_audit_log

    get_audit_log(db_path).record(
        event_type="database_restored_from_backup",
        actor="user:operator",
        details={"backup": chosen["name"], "restored_path": db_path, "pre_restore_copy": pre_restore},
    )
    print(f"[backup] Restored {chosen['name']} -> {db_path}")
    return {"success": True, "backup": chosen["name"], "restored_to": db_path, "pre_restore_copy": pre_restore}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Alexia SQLite online backup & verified restore utility")
    parser.add_argument("--restore", metavar="NAME", nargs="?", const="__latest__", help="Verify and restore backup NAME (or newest)")
    parser.add_argument("--verify", metavar="NAME", nargs="?", const="__latest__", help="Run PRAGMA quick_check on backup NAME (or newest)")
    args = parser.parse_args(argv)

    if args.verify is not None:
        target = None if args.verify == "__latest__" else args.verify
        res = verify_backup(target)
        print(json.dumps(res))
        return 0 if res.get("ok") else 1

    if args.restore is not None:
        target = None if args.restore == "__latest__" else args.restore
        restore_backup(target)
        return 0

    run_backup()
    return 0


if __name__ == "__main__":
    sys.exit(main())
