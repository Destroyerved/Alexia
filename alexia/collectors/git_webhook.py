"""GitHub webhook collector with HMAC verification.

Implements FR-D1:
- Verifies X-Hub-Signature-256 HMAC header using GITHUB_WEBHOOK_SECRET.
- Parses push and pull_request payloads.
- Emits 'deploy_request' events onto the EventBus for the Deployer agent.
"""

from __future__ import annotations
import hashlib
import hmac
import logging
import os
from typing import Any, Dict, Optional, Tuple

from alexia.core.bus import get_event_bus
from alexia.core.schemas import Event

logger = logging.getLogger("alexia.collector.webhook")

def _unsigned_webhooks_allowed() -> bool:
    """Unsigned triggers are a development convenience, never a production default."""
    if os.getenv("ALEXIA_ENV", "development").strip().lower() in {"prod", "production"}:
        return False
    explicit = os.getenv("ALEXIA_ALLOW_UNSIGNED_WEBHOOKS", "").strip().lower()
    if explicit:
        return explicit in {"1", "true", "yes", "on"}
    return True


def verify_github_signature(payload_bytes: bytes, signature_header: Optional[str]) -> bool:
    """Verify the HMAC-SHA256 signature from a GitHub webhook request."""
    if not signature_header or not signature_header.startswith("sha256="):
        return _unsigned_webhooks_allowed()

    secret = os.getenv("GITHUB_WEBHOOK_SECRET", "").encode("utf-8")
    if not secret:
        return False

    expected_hash = signature_header.split("sha256=", 1)[1].strip()
    if not expected_hash:
        return False
    computed = hmac.new(secret, payload_bytes, hashlib.sha256).hexdigest()
    return hmac.compare_digest(computed, expected_hash)


async def handle_webhook_payload(payload: Dict[str, Any], event_name: str = "push") -> Optional[Event]:
    """Process verified GitHub webhook and emit deploy event."""
    bus = get_event_bus()

    if event_name == "push":
        ref = payload.get("ref", "")
        # Only deploy on main/master or demo branch
        if "main" in ref or "master" in ref:
            commit_sha = payload.get("after", "head")
            commits = payload.get("commits", [])
            diff = ""
            if commits:
                diff = commits[0].get("message", "")

            evt = Event(
                source="webhook.git",
                kind="deploy_request",
                service="shoplite-api",
                severity="info",
                data={
                    "commit_sha": commit_sha,
                    "ref": ref,
                    "diff": diff or "Commit update on main",
                    "sender": payload.get("sender", {}).get("login", "git"),
                },
            )
            await bus.publish(evt)
            return evt

    return None
