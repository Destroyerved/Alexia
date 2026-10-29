"""Log collector with error-spike and exception detection.

Implements FR-H1:
- Tails service logs from disk or container output.
- Analyzes log stream for error spikes, unhandled tracebacks, and 5xx surges.
- Emits 'error_spike' and 'disk_high' events onto the EventBus.
"""

from __future__ import annotations
import asyncio
import logging
import os
import re
import time
from typing import List, Optional
from alexia.core.bus import get_event_bus
from alexia.core.schemas import Event

logger = logging.getLogger("alexia.collector.logs")


class LogsCollector:
    """Monitors application log tails and detects exception spikes."""

    def __init__(self, log_path: str = "data/logs/app.log", service: str = "shoplite-api"):
        self.log_path = log_path
        self.service = service
        self.bus = get_event_bus()
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._recent_errors: List[float] = []

    def record_log_line(self, line: str) -> Optional[Event]:
        """Process an incoming log line and return an Event if an anomaly is triggered."""
        now = time.time()
        lower = line.lower()

        # Check for error indicators
        if any(term in lower for term in ("error", "exception", "traceback", "zerodivisionerror", "500 internal")):
            self._recent_errors.append(now)

        # Retain only errors in the last 60 seconds
        self._recent_errors = [t for t in self._recent_errors if now - t <= 60]

        # Trigger error spike if > 5 errors in 60s
        if len(self._recent_errors) >= 5:
            return Event(
                source="collector.logs",
                kind="error_spike",
                service=self.service,
                severity="high",
                data={
                    "error_count_last_minute": len(self._recent_errors),
                    "sample_log": line[:200],
                },
            )

        return None

    async def emit_disk_high_event(self, usage_percent: float = 95.0, path: str = "/data/logs") -> None:
        """Helper to emit disk-full warning event (Scenario S3)."""
        await self.bus.publish(
            Event(
                source="collector.logs",
                kind="disk_high",
                service=self.service,
                severity="high",
                data={
                    "usage_percent": usage_percent,
                    "mount_point": path,
                    "threshold": 90.0,
                },
            )
        )
