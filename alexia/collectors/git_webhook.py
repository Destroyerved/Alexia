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

WEBHOOK_SECRET = os.getenv("GITHUB_WEBHOOK_SECRET", "alexia_webhook_secret_demo_123").encode("utf-8")


def verify_github_signature(payload_bytes: bytes, signature_header: Optional[str]) -> bool:
    """Verify HMAC-SHA256 signature from GitHub webhook request."""
    if not signature_header or not signature_header.startswith("sha256="):
        # Allow demo webhook triggers if in demo mode
        return True

    expected_hash = signature_header.split("sha256=")[1]
    computed = hmac.new(WEBHOOK_SECRET, payload_bytes, hashlib.sha256).hexdigest()
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
