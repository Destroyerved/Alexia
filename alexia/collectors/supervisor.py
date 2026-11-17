"""Lifecycle management for background telemetry collectors.

The API process owns the collectors.  Before this module existed they were
implemented but never started, so the Healer waited forever for events that
the health poller and Docker stream were supposed to emit.

Configuration (all optional):

- ``ALEXIA_COLLECTORS=on|off|auto`` — master switch (``auto`` disables them in
  tests and enables them otherwise).
- ``ALEXIA_DOCKER_EVENTS=on|off|auto`` — Docker stream toggle.
- ``ALEXIA_LOG_PATH`` — tail this file for error spikes.
- ``ALEXIA_HEALTH_INTERVAL_SECONDS`` / ``ALEXIA_HEALTH_FAILURE_THRESHOLD``.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import List, Optional

from alexia.collectors.docker_events import DockerEventsCollector
from alexia.collectors.health import HealthCollector
from alexia.collectors.logs import LogsCollector

logger = logging.getLogger("alexia.collectors")


def _env_flag(name: str, default: str = "auto") -> str:
    return (os.getenv(name, default) or default).strip().lower()


def collectors_enabled() -> bool:
    """Return whether the runtime should start telemetry collectors."""
    setting = _env_flag("ALEXIA_COLLECTORS")
    if setting in {"0", "false", "no", "off"}:
        return False
    if setting in {"1", "true", "yes", "on"}:
        return True
    return os.getenv("ALEXIA_ENV", "development").strip().lower() not in {"test", "testing"}


class CollectorSupervisor:
    """Owns the collectors' asyncio tasks and shuts them down cleanly."""

    def __init__(self) -> None:
        self._tasks: List[asyncio.Task] = []
        self._collectors: List[object] = []
        self.started = False

    @property
    def active(self) -> List[str]:
        return [type(collector).__name__ for collector in self._collectors]

    def start(self) -> None:
        """Start the configured collectors; safe to call once per process."""
        if self.started:
            return
        if not collectors_enabled():
            logger.info("Telemetry collectors disabled (ALEXIA_COLLECTORS/ALEXIA_ENV).")
            return

        self.started = True
        interval = int(os.getenv("ALEXIA_HEALTH_INTERVAL_SECONDS", "10") or "10")
        threshold = int(os.getenv("ALEXIA_HEALTH_FAILURE_THRESHOLD", "3") or "3")
        health = HealthCollector(
            target_url=os.getenv("SHOPLITE_URL", "http://localhost:8000"),
            interval_seconds=max(1, interval),
            failure_threshold=max(1, threshold),
        )
        self._start_collector("health", health)

        docker_setting = _env_flag("ALEXIA_DOCKER_EVENTS")
        if docker_setting not in {"0", "false", "no", "off"}:
            self._start_collector(
                "docker",
                DockerEventsCollector(os.getenv("ALEXIA_TARGET_CONTAINER", "shoplite-api")),
            )

        log_path = os.getenv("ALEXIA_LOG_PATH", "").strip()
        if log_path and os.path.exists(log_path):
            self._start_collector("logs", LogsCollector(log_path=log_path))
        elif log_path:
            logger.info("ALEXIA_LOG_PATH is set but %s does not exist; log collector not started.", log_path)

        logger.info("Telemetry collectors started: %s", ", ".join(self.active) or "none")

    def _start_collector(self, name: str, collector: object) -> None:
        task = asyncio.create_task(self._supervise(name, collector))  # type: ignore[arg-type]
        self._tasks.append(task)
        self._collectors.append(collector)

    @staticmethod
    async def _supervise(name: str, collector) -> None:
        try:
            await collector.run()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Collector %s crashed; the remaining collectors keep running.", name)

    async def stop(self) -> None:
        """Cancel every task and wait for it, so shutdown does not leak readers/threads."""
        self.started = False
        for collector in self._collectors:
            try:
                collector.stop()
            except Exception:
                logger.debug("Collector stop() failed", exc_info=True)
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        self._collectors.clear()


_supervisor: Optional[CollectorSupervisor] = None


def get_collector_supervisor() -> CollectorSupervisor:
    global _supervisor
    if _supervisor is None:
        _supervisor = CollectorSupervisor()
    return _supervisor
