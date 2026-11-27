"""Web Push notification manager using VAPID keys.

Implements FR-M2, FR-M3, FR-M4:
- Sends Web Push notifications using VAPID protocol.
- Stores browser and mobile PWA push subscriptions in SQLite.
- Ensures all notification bodies are pre-redacted (no secrets or PII).
- Supports demo mode fallback when push credentials are mock.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import sqlite3
import threading
from typing import Any, Dict, List, Optional

from alexia.core.paths import resolve_db_path
from alexia.core.redact import redact
from alexia.core.schemas import Notification
from alexia.core.sqlite import connect as sqlite_connect, resolve_openable_path
from alexia.core.state_store import get_state_store

logger = logging.getLogger("alexia.push")


def _in_quiet_hours(start_hhmm: str, end_hhmm: str) -> bool:
    """Check whether current local time falls inside configured quiet hours (HH:MM)."""
    if not start_hhmm or not end_hhmm or ":" not in start_hhmm or ":" not in end_hhmm:
        return False
    try:
        sh, sm = [int(x) for x in start_hhmm.split(":", 1)]
        eh, em = [int(x) for x in end_hhmm.split(":", 1)]
        now = datetime.datetime.now().time()
        start_t = datetime.time(sh % 24, sm % 60)
        end_t = datetime.time(eh % 24, em % 60)
        if start_t <= end_t:
            return start_t <= now <= end_t
        return now >= start_t or now <= end_t
    except Exception:
        return False


class PushManager:
    """Manages Web Push subscriptions and notification dispatch."""

    def __init__(self, db_path: str = "data/alexia.db"):
        self.source_db_path = resolve_db_path(db_path)
        self.db_path = resolve_openable_path(self.source_db_path)
        self._lock = threading.Lock()
        self._init_db()

    @property
    def vapid_private_key(self) -> str:
        return os.getenv("VAPID_PRIVATE_KEY", "").strip()

    @property
    def vapid_public_key(self) -> str:
        return os.getenv("VAPID_PUBLIC_KEY", "").strip()

    @property
    def vapid_claims_email(self) -> str:
        return os.getenv("VAPID_CLAIMS_EMAIL", "admin@alexia-guardian.dev").strip()

    def get_public_key_info(self) -> Dict[str, Any]:
        pub = self.vapid_public_key
        configured = bool(pub and not pub.startswith("your_vapid"))
        return {
            "public_key": pub if configured else "",
            "configured": configured,
        }

    def _get_connection(self) -> sqlite3.Connection:
        return sqlite_connect(self.db_path)

    def _init_db(self) -> None:
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS push_subscriptions (
                    endpoint TEXT PRIMARY KEY,
                    p256dh TEXT NOT NULL,
                    auth TEXT NOT NULL,
                    device_id TEXT,
                    user_agent TEXT,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def register_subscription(
        self,
        endpoint: str,
        p256dh: str,
        auth: str,
        device_id: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> None:
        """Register a new browser/mobile Web Push subscription."""
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, device_id, user_agent, created_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
                """,
                (endpoint, p256dh, auth, device_id, user_agent),
            )
            conn.commit()
        logger.info(f"Registered Web Push subscription for device: {device_id or 'unknown'}")

    def remove_subscription(self, endpoint: str) -> None:
        with self._lock, self._get_connection() as conn:
            conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
            conn.commit()

    def list_subscriptions(self) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT * FROM push_subscriptions")
            return [dict(r) for r in cur.fetchall()]

    def _is_suppressed(self, severity: str) -> bool:
        store = get_state_store(self.source_db_path)
        settings = store.get_settings()
        if settings.get("notifications_muted"):
            return True
        if severity != "critical" and _in_quiet_hours(
            str(settings.get("quiet_hours_start") or ""),
            str(settings.get("quiet_hours_end") or ""),
        ):
            return True
        return False

    def send(self, notification: Notification) -> int:
        """Dispatch a pre-redacted notification to all registered push subscriptions."""
        if self._is_suppressed(notification.severity):
            logger.info("Push notification %s suppressed by mute/quiet-hours policy.", notification.id)
            return 0

        safe_dump = notification.model_dump()
        safe_dump["title"] = str(redact(safe_dump.get("title", "")))
        safe_dump["body"] = str(redact(safe_dump.get("body", "")))

        # Persist into StateStore notifications feed if not already recorded
        get_state_store(self.source_db_path).record_notification(safe_dump)

        subs = self.list_subscriptions()
        if not subs:
            logger.info("No active push subscriptions registered. Notification emitted via SSE.")
            return 0

        payload = json.dumps(safe_dump)
        delivered = 0

        for sub in subs:
            if self.vapid_private_key and not self.vapid_private_key.startswith("your_vapid"):
                try:
                    from pywebpush import WebPushException, webpush

                    subscription_info = {
                        "endpoint": sub["endpoint"],
                        "keys": {
                            "p256dh": sub["p256dh"],
                            "auth": sub["auth"],
                        },
                    }
                    webpush(
                        subscription_info=subscription_info,
                        data=payload,
                        vapid_private_key=self.vapid_private_key,
                        vapid_claims={"sub": f"mailto:{self.vapid_claims_email}"},
                    )
                    delivered += 1
                except Exception as e:
                    status_code = getattr(getattr(e, "response", None), "status_code", None)
                    if status_code in (404, 410) or "410" in str(e) or "404" in str(e):
                        logger.info("Pruning expired push subscription (%s)", sub["endpoint"][:32])
                        self.remove_subscription(sub["endpoint"])
                    else:
                        logger.warning(f"Failed to deliver push to {sub['endpoint'][:30]}...: {e}")
            else:
                delivered += 1

        logger.info(f"Delivered push notification {notification.id} to {delivered} device(s).")
        return delivered


_global_push_mgr: Optional[PushManager] = None


def get_push_manager(db_path: str = "data/alexia.db") -> PushManager:
    """Retrieve or initialize PushManager singleton."""
    from alexia.core.sqlite import has_table

    global _global_push_mgr
    if (
        _global_push_mgr is None
        or _global_push_mgr.source_db_path != resolve_db_path(db_path)
        or not has_table(_global_push_mgr.db_path, "push_subscriptions")
    ):
        _global_push_mgr = PushManager(db_path=db_path)
    return _global_push_mgr


def send_ntfy_alert(notification: Notification) -> bool:
    """Mirror high/critical alerts to the ntfy topic the installer sets up (ALEXIA_ALERT_NTFY)."""
    url = os.getenv("ALEXIA_ALERT_NTFY", "").strip()
    if not url or notification.severity not in ("critical", "high"):
        return False
    if get_push_manager()._is_suppressed(notification.severity):
        return False
    try:
        import httpx

        safe_title = str(redact(notification.title)).encode("ascii", "replace").decode("ascii")
        safe_body = str(redact(notification.body)).encode("utf-8")
        resp = httpx.post(
            url,
            content=safe_body,
            headers={
                "Title": safe_title,
                "Priority": "urgent" if notification.severity == "critical" else "high",
                "Tags": "rotating_light" if notification.severity == "critical" else "warning",
            },
            timeout=5.0,
        )
        return resp.status_code < 300
    except Exception as e:
        logger.warning(f"ntfy alert failed: {e}")
        return False


def send_push_notification(notification: Notification) -> int:
    """Top-level helper to broadcast a push notification (Web Push devices + optional ntfy topic)."""
    send_ntfy_alert(notification)
    return get_push_manager().send(notification)
