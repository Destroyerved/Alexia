"""Runtime data locations shared by every Alexia component.

Service installs (deploy/windows/install.ps1, deploy/linux/install.sh) set ALEXIA_DATA_DIR, so every
module must resolve the SQLite database and evidence/snapshot folders from it rather than from the
process working directory; otherwise state splits across two databases.
"""

from __future__ import annotations

import os

DEFAULT_DB_PATH = "data/alexia.db"


def data_dir() -> str:
    """Directory holding alexia.db, evidence/ and snapshots/ (ALEXIA_DATA_DIR, else ./data)."""
    return os.environ.get("ALEXIA_DATA_DIR") or "data"


def resolve_db_path(db_path: str = DEFAULT_DB_PATH) -> str:
    """Map the default database path onto ALEXIA_DB / ALEXIA_DATA_DIR (explicit paths are kept) and
    make sure its folder exists."""
    if db_path == DEFAULT_DB_PATH:
        if os.environ.get("ALEXIA_DB"):
            db_path = os.environ["ALEXIA_DB"]
        elif os.environ.get("ALEXIA_DATA_DIR"):
            db_path = os.path.join(os.environ["ALEXIA_DATA_DIR"], "alexia.db")
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    return db_path


def evidence_dir() -> str:
    return os.environ.get("EVIDENCE_DIR") or os.path.join(data_dir(), "evidence")


def snapshot_dir() -> str:
    return os.environ.get("SNAPSHOT_DIR") or os.path.join(data_dir(), "snapshots")
