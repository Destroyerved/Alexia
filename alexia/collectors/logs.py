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
        self._last_spike_at = 0.0
        self._position = 0

    def record_log_line(self, line: str) -> Optional[Event]:
        """Process an incoming log line and return an Event if an anomaly is triggered."""
        now = time.time()
        lower = line.lower()

        # Check for error indicators
        if any(term in lower for term in ("error", "exception", "traceback", "zerodivisionerror", "500 internal")):
            self._recent_errors.append(now)

        # Retain only errors in the last 60 seconds
        self._recent_errors = [t for t in self._recent_errors if now - t <= 60]

        # Trigger error spike if > 5 errors in 60s, at most once per 30s per collector.
        if len(self._recent_errors) >= 5 and now - self._last_spike_at >= 30:
            self._last_spike_at = now
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

    def read_new_lines(self, from_end: bool = False) -> List[str]:
        """Read complete appended lines, handling rotation and partial writes.

        ``from_end`` skips content that existed before the collector started, so
        a restart does not replay (and re-alert on) historical log lines.  A
        partially written final line is left unread until its newline arrives.
        """
        if not os.path.exists(self.log_path):
            return []
        size = os.path.getsize(self.log_path)
        if from_end and self._position == 0:
            self._position = size
        if size < self._position:
            self._position = 0  # log rotated or truncated
        lines: List[str] = []
        with open(self.log_path, "r", encoding="utf-8", errors="replace") as handle:
            handle.seek(self._position)
            while True:
                start = handle.tell()
                line = handle.readline()
                if not line:
                    break
                if not line.endswith("\n"):
                    handle.seek(start)  # wait for the writer to finish the line
                    break
                lines.append(line.rstrip("\r\n"))
            self._position = handle.tell()
        return lines

    async def run(self) -> None:
        self._running = True
        first_pass = True
        while self._running:
            for line in self.read_new_lines(from_end=first_pass):
                event = self.record_log_line(line)
                if event is not None:
                    await self.bus.publish(event)
            first_pass = False
            await asyncio.sleep(2.0)

    def start(self) -> None:
        if not self._running:
            self._task = asyncio.create_task(self.run())

    def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()

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
