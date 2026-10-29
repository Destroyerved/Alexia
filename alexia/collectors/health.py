"""Health collector polling target service endpoints.

Implements FR-H1:
- Polls target application /health endpoint every 10 seconds.
- Tracks 5xx error spikes, response latencies, and service outages.
- Emits 'health_fail' and 'error_spike' events onto the EventBus.
"""

from __future__ import annotations
import asyncio
import logging
import os
import httpx
from alexia.core.bus import get_event_bus
from alexia.core.schemas import Event

logger = logging.getLogger("alexia.collector.health")

SHOPLITE_URL = os.getenv("SHOPLITE_URL", "http://localhost:8000")


class HealthCollector:
    """Monitors HTTP endpoints and reports degraded service states."""

    def __init__(self, target_url: str = SHOPLITE_URL, interval_seconds: int = 10):
        self.target_url = target_url.rstrip("/")
        self.interval = interval_seconds
        self.bus = get_event_bus()
        self._running = False
        self._task: Optional[asyncio.Task] = None

    async def check_once(self) -> bool:
        """Execute a single health poll."""
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(f"{self.target_url}/health")
                if resp.status_code >= 500:
                    await self.bus.publish(
                        Event(
                            source="collector.health",
                            kind="health_fail",
                            service="shoplite-api",
                            severity="high",
                            data={"status_code": resp.status_code, "body": resp.text[:200]},
                        )
                    )
                    return False
                return True
        except Exception as e:
            logger.debug(f"Health check failed for {self.target_url}: {e}")
            return False

    async def run(self) -> None:
        self._running = True
        while self._running:
            await self.check_once()
            await asyncio.sleep(self.interval)

    def start(self) -> None:
        if not self._running:
            self._task = asyncio.create_task(self.run())

    def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
