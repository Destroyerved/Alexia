"""Server-Sent Events (SSE) streaming engine for dashboard and mobile PWA.

Implements FR-U1, FR-U2, NFR2:
- Streams real-time timeline events, incident status transitions, and notifications.
- Provides sub-second reactive updates to connected web and mobile clients.
"""

from __future__ import annotations
import asyncio
import json
import logging
from typing import AsyncGenerator
from fastapi import Request
from sse_starlette.sse import EventSourceResponse

from alexia.core.bus import get_event_bus

logger = logging.getLogger("alexia.api.sse")


async def sse_event_generator(request: Request) -> AsyncGenerator[str, None]:
    """Generates SSE messages for connected clients."""
    bus = get_event_bus()
    queue = bus.register_sse_listener()

    try:
        # Initial handshake ping
        yield json.dumps({"type": "connected", "message": "Alexia real-time SSE stream established"})

        while True:
            if await request.is_disconnected():
                break

            try:
                # Wait for next event with a 15-second keepalive ping
                message = await asyncio.wait_for(queue.get(), timeout=15.0)
                yield json.dumps(message)
            except asyncio.TimeoutError:
                # Keepalive heartbeat
                yield json.dumps({"type": "ping"})
            except asyncio.CancelledError:
                break
    finally:
        bus.unregister_sse_listener(queue)
        logger.debug("SSE client disconnected.")


def create_sse_response(request: Request) -> EventSourceResponse:
    """Return an EventSourceResponse wrapping the event generator."""
    return EventSourceResponse(sse_event_generator(request))
