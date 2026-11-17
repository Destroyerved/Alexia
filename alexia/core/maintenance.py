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
from typing import List

logger = logging.getLogger("alexia.maintenance")

HEARTBEAT_INTERVAL_SECONDS = 300


async def _nightly_backup_loop(hour: int) -> None:
    last_day = None
    while True:
        now = datetime.datetime.now()
        if now.hour == hour and last_day != now.date():
            last_day = now.date()
            try:
                from alexia.tools.backup import run_backup

                result = await asyncio.to_thread(run_backup)
                logger.info(f"Nightly backup complete: {result}")
            except Exception as e:
                logger.error(f"Nightly backup failed: {e}")
        await asyncio.sleep(60)


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
    heartbeat = os.getenv("ALEXIA_HEARTBEAT_URL", "").strip()
    if heartbeat:
        tasks.append(asyncio.create_task(_heartbeat_loop(heartbeat)))
        logger.info("Heartbeat pings enabled.")
    return tasks
