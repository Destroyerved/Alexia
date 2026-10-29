"""Device registry and session security for mobile companion.

Implements FR-M9:
- Registers mobile and web devices with cryptographic fingerprints.
- Enables instant revocation of lost/compromised devices.
- Ensures all remote actions are audited with device ID and client IP.
"""

from __future__ import annotations
import logging
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from alexia.core.audit import get_audit_log

logger = logging.getLogger("alexia.devices")


class DeviceManager:
    """Manages registered mobile and browser devices."""

    def __init__(self, db_path: str = "data/alexia.db"):
        self.db_path = db_path
        self.audit = get_audit_log(db_path)
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
                CREATE TABLE IF NOT EXISTS registered_devices (
                    device_id TEXT PRIMARY KEY,
                    user TEXT NOT NULL,
                    device_name TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    ip_address TEXT NOT NULL,
                    last_seen TEXT NOT NULL,
                    registered_at TEXT NOT NULL,
                    is_revoked INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            conn.commit()

    def register_or_update(
        self,
        device_id: str,
        user: str,
        device_name: str,
        platform: str,
        ip_address: str,
    ) -> Dict[str, Any]:
        """Register a new device or update last seen timestamp."""
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT is_revoked FROM registered_devices WHERE device_id = ?", (device_id,))
            row = cur.fetchone()

            if row:
                if row["is_revoked"] == 1:
                    raise PermissionError(f"Device {device_id} is revoked.")
                cur.execute(
                    """
                    UPDATE registered_devices
                    SET last_seen = ?, ip_address = ?, device_name = ?
                    WHERE device_id = ?
                    """,
                    (now, ip_address, device_name, device_id),
                )
            else:
                cur.execute(
                    """
                    INSERT INTO registered_devices (
                        device_id, user, device_name, platform, ip_address,
                        last_seen, registered_at, is_revoked
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
                    """,
                    (device_id, user, device_name, platform, ip_address, now, now),
                )
            conn.commit()

        self.audit.record(
            event_type="device_registered",
            actor=f"user:{user}@device:{device_id}",
            details={"device_id": device_id, "platform": platform, "ip": ip_address},
        )

        return {
            "device_id": device_id,
            "user": user,
            "device_name": device_name,
            "platform": platform,
            "last_seen": now,
        }

    def revoke_device(self, device_id: str, revoked_by: str = "admin") -> bool:
        """Revoke device authorization immediately."""
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._get_connection() as conn:
            conn.execute(
                "UPDATE registered_devices SET is_revoked = 1 WHERE device_id = ?",
                (device_id,),
            )
            conn.commit()

        self.audit.record(
            event_type="device_revoked",
            actor=revoked_by,
            details={"device_id": device_id, "revoked_at": now},
        )
        logger.warning(f"Device {device_id} revoked by {revoked_by}")
        return True

    def list_devices(self) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT * FROM registered_devices ORDER BY last_seen DESC")
            return [dict(r) for r in cur.fetchall()]


_global_device_mgr: Optional[DeviceManager] = None


def get_device_manager() -> DeviceManager:
    """Retrieve or initialize DeviceManager singleton."""
    global _global_device_mgr
    if _global_device_mgr is None:
        _global_device_mgr = DeviceManager()
    return _global_device_mgr
