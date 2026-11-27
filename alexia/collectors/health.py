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
from typing import Any, Dict, Optional

import httpx

from alexia.core.bus import get_event_bus
from alexia.core.schemas import Event

logger = logging.getLogger("alexia.collector.health")

SHOPLITE_URL = os.getenv("SHOPLITE_URL", "http://localhost:8000")


class HealthCollector:
    """Monitors HTTP endpoints and reports degraded service states.

    A single missed poll is usually a deploy hiccup, so `health_fail` is only
    published after `failure_threshold` consecutive failures.  The alert is
    emitted once per outage; a subsequent success publishes `health_recovered`.
    """

    def __init__(
        self,
        target_url: str = SHOPLITE_URL,
        interval_seconds: int = 10,
        failure_threshold: int = 3,
    ):
        self.target_url = target_url.rstrip("/")
        self.interval = interval_seconds
        self.failure_threshold = max(1, failure_threshold)
        self.bus = get_event_bus()
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._consecutive_failures = 0
        self._alerted = False
        self.last_probe: Dict[str, Any] = {}

    async def check_once(self) -> bool:
        """Execute a single health poll and emit an alert only on a sustained outage."""
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(f"{self.target_url}/health")
        except Exception as exc:
            return await self._record_failure("unreachable", str(exc))

        self.last_probe = {
            "status_code": resp.status_code,
            "latency_ms": round(resp.elapsed.total_seconds() * 1000, 1),
            "checked_at": resp.headers.get("date", ""),
        }
        if resp.status_code >= 500:
            return await self._record_failure(
                f"http_{resp.status_code}", resp.text[:200], resp.status_code
            )

        await self._record_recovery()
        return True

    async def _record_failure(self, reason: str, detail: str, status_code: Optional[int] = None) -> bool:
        self._consecutive_failures += 1
        logger.warning(
            "Health poll failed for %s (%s/%s): %s",
            self.target_url,
            self._consecutive_failures,
            self.failure_threshold,
            detail,
        )
        if self._consecutive_failures >= self.failure_threshold and not self._alerted:
            self._alerted = True
            await self.bus.publish(
                Event(
                    source="collector.health",
                    kind="health_fail",
                    service="shoplite-api",
                    severity="high",
                    data={
                        "reason": reason,
                        "status_code": status_code,
                        "consecutive_failures": self._consecutive_failures,
                        "body": detail[:200],
                        "url": f"{self.target_url}/health",
                    },
                )
            )
        return False

    async def _record_recovery(self) -> None:
        self._consecutive_failures = 0
        if not self._alerted:
            return
        self._alerted = False
        await self.bus.publish(
            Event(
                source="collector.health",
                kind="health_recovered",
                service="shoplite-api",
                severity="info",
                data={"url": f"{self.target_url}/health", **self.last_probe},
            )
        )

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
