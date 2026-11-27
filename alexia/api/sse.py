"""Server-Sent Events (SSE) streaming engine for dashboard and mobile PWA.

Implements FR-U1, FR-U2, NFR2:
- Streams real-time timeline events, incident status transitions, and notifications.
- Supports `Last-Event-ID` header / `last_event_id` query replay from the EventBus ring buffer.
- Enforces per-IP concurrent SSE stream limits to prevent connection-exhaustion DoS.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncGenerator, Dict

from fastapi import HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from alexia.core.bus import get_event_bus

logger = logging.getLogger("alexia.api.sse")

MAX_SSE_PER_IP = 24
_ACTIVE_BY_IP: Dict[str, int] = {}


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for") or request.headers.get("x-real-ip")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"


def _parse_last_event_id(request: Request) -> int | None:
    raw = request.headers.get("last-event-id") or request.query_params.get("last_event_id")
    if raw and raw.strip().isdigit():
        return int(raw.strip())
    return None


async def sse_event_generator(request: Request, client_ip: str) -> AsyncGenerator[dict, None]:
    """Generates standard ID-tagged SSE messages for connected clients."""
    bus = get_event_bus()
    queue = bus.register_sse_listener()
    last_id = _parse_last_event_id(request)

    try:
        yield {
            "id": str(bus._sse_seq),
            "data": json.dumps(
                {
                    "type": "connected",
                    "message": "Alexia real-time SSE stream established",
                    "replayed_from": last_id,
                }
            ),
        }

        if last_id is not None:
            for seq, missed in bus.get_sse_since(last_id):
                yield {"id": str(seq), "data": json.dumps(missed, default=str)}

        while True:
            if await request.is_disconnected():
                break

            try:
                envelope = await asyncio.wait_for(queue.get(), timeout=15.0)
                seq = envelope.get("_sse_id")
                payload = {k: v for k, v in envelope.items() if k != "_sse_id"}
                frame: dict = {"data": json.dumps(payload, default=str)}
                if seq is not None:
                    frame["id"] = str(seq)
                yield frame
            except asyncio.TimeoutError:
                yield {"data": json.dumps({"type": "ping"})}
            except asyncio.CancelledError:
                break
    finally:
        bus.unregister_sse_listener(queue)
        _ACTIVE_BY_IP[client_ip] = max(0, _ACTIVE_BY_IP.get(client_ip, 1) - 1)
        if _ACTIVE_BY_IP.get(client_ip, 0) <= 0:
            _ACTIVE_BY_IP.pop(client_ip, None)
        logger.debug("SSE client disconnected.")


def create_sse_response(request: Request) -> EventSourceResponse:
    """Return an EventSourceResponse wrapping the event generator with per-IP concurrency limits."""
    client_ip = _client_ip(request)
    active = _ACTIVE_BY_IP.get(client_ip, 0)
    if active >= MAX_SSE_PER_IP:
        raise HTTPException(status_code=429, detail="Too many concurrent SSE streams from this IP.")
    _ACTIVE_BY_IP[client_ip] = active + 1
    return EventSourceResponse(sse_event_generator(request, client_ip))
