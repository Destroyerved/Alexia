"""Authentication log collector and brute-force attack detector.

Implements FR-S2:
- Tracks failed login attempts grouped by source IP address.
- Detects brute-force credential stuffing (> 10 failed logins per IP per minute).
- Emits 'bruteforce' security events to trigger Sentinel containment.
"""

from __future__ import annotations
import asyncio
import logging
import time
from typing import Dict, List, Optional
from alexia.core.bus import get_event_bus
from alexia.core.schemas import Event

logger = logging.getLogger("alexia.collector.auth")


class AuthLogCollector:
    """Monitors authentication attempts and triggers brute force alerts."""

    def __init__(self, failure_threshold: int = 10, window_seconds: int = 60, service: str = "shoplite-api"):
        self.failure_threshold = failure_threshold
        self.window_seconds = window_seconds
        self.service = service
        self.bus = get_event_bus()
        self._failures_by_ip: Dict[str, List[float]] = {}

    async def record_login_attempt(self, ip: str, success: bool, username: str = "") -> Optional[Event]:
        """Record an authentication event and evaluate brute-force criteria."""
        if success:
            return None

        now = time.time()
        if ip not in self._failures_by_ip:
            self._failures_by_ip[ip] = []

        self._failures_by_ip[ip].append(now)

        # Filter outside window
        self._failures_by_ip[ip] = [
            t for t in self._failures_by_ip[ip] if now - t <= self.window_seconds
        ]

        if len(self._failures_by_ip[ip]) >= self.failure_threshold:
            event = Event(
                source="collector.auth",
                kind="bruteforce",
                service=self.service,
                severity="high",
                data={
                    "ip": ip,
                    "failed_count": len(self._failures_by_ip[ip]),
                    "window_seconds": self.window_seconds,
                    "last_attempt_user": username,
                },
            )
            await self.bus.publish(event)
            # Reset after alert to avoid spamming
            self._failures_by_ip[ip] = []
            return event

        return None
