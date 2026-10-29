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
import shutil
import sqlite3
import sys
from typing import Dict, Any

BACKUP_NAME_RE = re.compile(r"^alexia-\d{8}-\d{6}\.db$")


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

    src_conn = sqlite3.connect(db_path, timeout=15)
    dst_conn = sqlite3.connect(dest_path, timeout=15)
    try:
        with dst_conn:
            src_conn.backup(dst_conn)
    finally:
        dst_conn.close()
        src_conn.close()

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


if __name__ == "__main__":
    run_backup()
