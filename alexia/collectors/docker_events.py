"""Docker event collector monitoring container status and crashes.

Implements FR-H1:
- Attaches to Docker daemon event stream.
- Detects container crashes ('die' with non-zero exit code), OOM ('oom'), and kill signals.
- Publishes typed 'container_exit' and 'oom' events to the bus.

The Docker SDK is blocking, so streaming happens on a daemon thread and events
are handed back to the asyncio loop.  Running the stream directly in an async
task would freeze the API, the SSE feed, and every other collector.
"""

from __future__ import annotations
import asyncio
import logging
import threading
from typing import Any, Dict, Optional

from alexia.core.bus import get_event_bus
from alexia.core.schemas import Event

logger = logging.getLogger("alexia.collector.docker")


class DockerEventsCollector:
    """Streams container events from the Docker daemon to the EventBus."""

    def __init__(self, target_container: str = "shoplite-api"):
        self.target_container = target_container
        self.bus = get_event_bus()
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._client: Any = None

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

    async def _handle_event(self, event: Dict[str, Any]) -> None:
        if event.get("Type") != "container":
            return
        status = str(event.get("status") or "")
        actor = event.get("Actor", {}) or {}
        name = (actor.get("Attributes", {}) or {}).get("name", "")
        if self.target_container not in name:
            return

        if status == "oom":
            await self.emit_crash_event(137, "Container terminated by OOM killer")
        elif status == "die":
            exit_code = int((actor.get("Attributes", {}) or {}).get("exitCode", 1))
            if exit_code != 0:
                await self.emit_crash_event(exit_code, f"Container died with exit code {exit_code}")
        elif status.startswith("health_status") and "unhealthy" in status.lower():
            await self.bus.publish(
                Event(
                    source="collector.docker",
                    kind="health_fail",
                    service=self.target_container,
                    severity="high",
                    data={
                        "container": self.target_container,
                        "reason": "docker_healthcheck_unhealthy",
                        "status": status,
                    },
                )
            )

    def _stream_events(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> None:
        """Blocking Docker stream; runs on a daemon thread, never on the event loop."""
        try:
            import docker

            self._client = docker.from_env()
            for event in self._client.events(decode=True):
                if self._stop.is_set() or not self._running:
                    break
                loop.call_soon_threadsafe(queue.put_nowait, event)
        except Exception as exc:  # daemon absent, permission denied, stream dropped
            if self._running:
                logger.info("Docker event stream unavailable (%s); collector backing off.", exc)
        finally:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, None)
            except RuntimeError:
                pass  # loop already closed during shutdown

    async def run(self) -> None:
        self._running = True
        self._stop.clear()
        loop = asyncio.get_running_loop()
        backoff = 5.0
        try:
            while self._running and not self._stop.is_set():
                queue: asyncio.Queue = asyncio.Queue()
                self._thread = threading.Thread(
                    target=self._stream_events,
                    args=(loop, queue),
                    name="alexia-docker-events",
                    daemon=True,
                )
                self._thread.start()
                received_any = False
                while self._running and not self._stop.is_set():
                    event = await queue.get()
                    if event is None:
                        break
                    received_any = True
                    backoff = 2.0
                    await self._handle_event(event)
                if not self._running or self._stop.is_set():
                    break
                wait_for = backoff if received_any else 30.0
                backoff = min(30.0, backoff * 2.0)
                await asyncio.sleep(wait_for)
        finally:
            self._running = False
            self._stop.set()
            client, self._client = self._client, None
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass

    def start(self) -> None:
        if not self._running:
            self._task = asyncio.create_task(self.run())

    def stop(self) -> None:
        self._running = False
        self._stop.set()
        client, self._client = self._client, None
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
        if self._task:
            self._task.cancel()
