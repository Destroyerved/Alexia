"""Docker event collector monitoring container status and crashes.

Implements FR-H1:
- Attaches to Docker daemon event stream.
- Detects container crashes ('die' with non-zero exit code), OOM ('oom'), and kill signals.
- Publishes typed 'container_exit' and 'oom' events to the bus.
"""

from __future__ import annotations
import asyncio
import logging
from typing import Optional

from alexia.core.bus import get_event_bus
from alexia.core.schemas import Event

logger = logging.getLogger("alexia.collector.docker")


class DockerEventsCollector:
    """Streams container events from Docker daemon to the EventBus."""

    def __init__(self, target_container: str = "shoplite-api"):
        self.target_container = target_container
        self.bus = get_event_bus()
        self._running = False
        self._task: Optional[asyncio.Task] = None

    async def emit_crash_event(self, exit_code: int = 1, error_message: str = "Process exited unexpectedly") -> None:
        """Helper to emit an immediate crash event (used by chaos triggers and daemon)."""
        await self.bus.publish(
            Event(
                source="collector.docker",
                kind="oom" if exit_code == 137 else "container_exit",
                service=self.target_container,
                severity="critical" if exit_code == 137 else "high",
                data={
                    "container": self.target_container,
                    "exit_code": exit_code,
                    "error": error_message,
                },
            )
        )

    async def run(self) -> None:
        self._running = True
        try:
            import docker
            client = docker.from_env()
            for event in client.events(decode=True):
                if not self._running:
                    break
                if event.get("Type") == "container":
                    status = event.get("status")
                    actor = event.get("Actor", {})
                    name = actor.get("Attributes", {}).get("name", "")

                    if self.target_container in name:
                        if status == "oom":
                            await self.emit_crash_event(137, "Container terminated by OOM killer")
                        elif status == "die":
                            exit_code = int(actor.get("Attributes", {}).get("exitCode", 1))
                            if exit_code != 0:
                                await self.emit_crash_event(exit_code, f"Container died with exit code {exit_code}")
                await asyncio.sleep(0.01)
        except Exception as e:
            logger.info(f"Docker daemon not attached or unavailable ({e}). Docker collector running in event-listener mode.")

    def start(self) -> None:
        if not self._running:
            self._task = asyncio.create_task(self.run())

    def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
