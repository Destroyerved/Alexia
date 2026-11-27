"""Background upkeep promised by the service installers (deploy/windows/install.ps1, deploy/linux/install.sh).

- Nightly online SQLite backup at ALEXIA_BACKUP_HOUR (local time, default 03:00) for service installs
  (ALEXIA_BACKUP_DIR or ALEXIA_SUPERVISED set), via alexia.tools.backup.run_backup.
- Heartbeat GET to ALEXIA_HEARTBEAT_URL every 5 minutes (e.g. healthchecks.io), so a dead box is noticed.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import os
import time
from typing import List

from alexia.core.config import is_test

logger = logging.getLogger("alexia.maintenance")

HEARTBEAT_INTERVAL_SECONDS = 300


def _needs_catchup_backup() -> bool:
    try:
        from alexia.tools.backup import list_backups

        backups = list_backups()
        if not backups:
            return True
        newest_path = backups[0].get("path") or ""
        if not newest_path or not os.path.exists(newest_path):
            return True
        age_seconds = time.time() - os.path.getmtime(newest_path)
        return age_seconds > 86400
    except Exception:
        return False


async def _run_and_verify_backup(reason: str) -> None:
    from alexia.tools.backup import run_backup, verify_backup

    result = await asyncio.to_thread(run_backup)
    v_res = await asyncio.to_thread(verify_backup, result.get("name"))
    logger.info("SQLite backup (%s) complete: %s | verified=%s", reason, result, v_res.get("ok"))


async def _nightly_backup_loop(hour: int) -> None:
    if await asyncio.to_thread(_needs_catchup_backup):
        try:
            await _run_and_verify_backup("startup-catchup")
        except Exception as exc:
            logger.error("Catch-up backup failed: %s", exc)

    last_day = None
    while True:
        now = datetime.datetime.now()
        if now.hour == hour and last_day != now.date():
            last_day = now.date()
            try:
                await _run_and_verify_backup("nightly")
            except Exception as e:
                logger.error(f"Nightly backup failed: {e}")
        await asyncio.sleep(60)


async def _integrity_check_loop(interval_seconds: int) -> None:
    """Scheduled periodic database integrity check (FR-I2)."""
    await asyncio.sleep(min(30, interval_seconds))
    while True:
        try:
            from alexia.agents.integrity import get_integrity_agent

            res = await asyncio.to_thread(get_integrity_agent().verify_integrity, "shoplite-api")
            if not res.get("integrity_ok", True):
                logger.error("Scheduled integrity check detected issue: %s", res)
        except Exception as exc:
            logger.warning("Scheduled integrity check failed: %s", exc)
        await asyncio.sleep(interval_seconds)


async def _heartbeat_loop(url: str) -> None:
    import httpx

    while True:
        try:
            await asyncio.to_thread(httpx.get, url, timeout=10.0)
        except Exception as e:
            logger.warning(f"Heartbeat ping failed: {e}")
        await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)


def start_maintenance() -> List[asyncio.Task]:
    """Start the loops this install is configured for; the caller cancels them on shutdown."""
    tasks: List[asyncio.Task] = []
    if os.getenv("ALEXIA_BACKUP_DIR") or os.getenv("ALEXIA_SUPERVISED"):
        hour = int(os.getenv("ALEXIA_BACKUP_HOUR", "3") or "3")
        tasks.append(asyncio.create_task(_nightly_backup_loop(hour)))
        logger.info(f"Nightly SQLite backup scheduled for {hour:02d}:00 local time.")
    if not is_test():
        integrity_sec = int(os.getenv("ALEXIA_INTEGRITY_INTERVAL_SECONDS", "3600") or "3600")
        if integrity_sec > 0:
            tasks.append(asyncio.create_task(_integrity_check_loop(max(60, integrity_sec))))
    heartbeat = os.getenv("ALEXIA_HEARTBEAT_URL", "").strip()
    if heartbeat:
        tasks.append(asyncio.create_task(_heartbeat_loop(heartbeat)))
        logger.info("Heartbeat pings enabled.")
    return tasks
