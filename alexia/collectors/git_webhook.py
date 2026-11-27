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
from typing import Any, Dict, List, Optional

import httpx

from alexia.core.bus import get_event_bus
from alexia.core.config import allow_unsigned_webhooks, is_production
from alexia.core.schemas import Event
from alexia.core.state_store import get_state_store

logger = logging.getLogger("alexia.collector.webhook")


def _unsigned_webhooks_allowed() -> bool:
    """Unsigned triggers are a development convenience, never a production default."""
    if is_production():
        return False
    explicit = os.getenv("ALEXIA_ALLOW_UNSIGNED_WEBHOOKS", "").strip()
    if explicit:
        return allow_unsigned_webhooks()
    if not bool(get_state_store().get_setting("webhook_signature_verification", True)):
        return True
    return allow_unsigned_webhooks()


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


async def _resolve_webhook_diff(payload: Dict[str, Any]) -> str:
    """Resolve unified diff from explicit payload, GitHub Compare API, or commit file lists."""
    explicit_diff = str(payload.get("diff") or "").strip()
    if explicit_diff:
        return explicit_diff

    token = (os.getenv("GITHUB_TOKEN") or "").strip()
    repo_name = str((payload.get("repository") or {}).get("full_name") or os.getenv("GITHUB_REPO") or "").strip()
    before = str(payload.get("before") or "").strip()
    after = str(payload.get("after") or "").strip()

    if token and not token.startswith("ghp_your_") and repo_name and before and after and not set(before) == {"0"}:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(
                    f"https://api.github.com/repos/{repo_name}/compare/{before}...{after}",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Accept": "application/vnd.github.v3.diff",
                    },
                )
                if resp.status_code == 200 and resp.text.strip():
                    return resp.text[:25000]
        except Exception as exc:
            logger.debug("GitHub compare diff fetch skipped (%s)", exc)

    commits = payload.get("commits") or []
    parts: List[str] = []
    for commit in commits[:10]:
        if not isinstance(commit, dict):
            continue
        msg = str(commit.get("message") or "").strip()
        if msg:
            parts.append(f"# commit: {msg}")
        patch = str(commit.get("patch") or commit.get("diff") or "").strip()
        if patch:
            parts.append(patch)
        for path in (commit.get("added") or []) + (commit.get("modified") or []):
            parts.append(f"+++ b/{path}")
        for path in commit.get("removed") or []:
            parts.append(f"--- a/{path}")
    return "\n".join(parts) or "Commit update on main"


async def handle_webhook_payload(payload: Dict[str, Any], event_name: str = "push") -> Optional[Event]:
    """Process verified GitHub webhook and emit deploy event."""
    bus = get_event_bus()

    if event_name == "push":
        ref = str(payload.get("ref") or "")
        if any(branch in ref for branch in ("main", "master", "demo")):
            commit_sha = str(payload.get("after") or "head")
            diff = await _resolve_webhook_diff(payload)
            evt = Event(
                source="webhook.git",
                kind="deploy_request",
                service=str(payload.get("service") or "shoplite-api"),
                severity="info",
                data={
                    "commit_sha": commit_sha,
                    "ref": ref,
                    "diff": diff,
                    "migration_sql": payload.get("migration_sql", ""),
                    "sender": (payload.get("sender") or {}).get("login", "git"),
                },
            )
            await bus.publish(evt)
            return evt

    if event_name == "pull_request":
        action = str(payload.get("action") or "")
        pr = payload.get("pull_request") or {}
        if action in ("opened", "synchronize", "reopened"):
            head_sha = str((pr.get("head") or {}).get("sha") or "pr-head")
            diff = str(payload.get("diff") or pr.get("body") or pr.get("title") or "Pull request diff")
            evt = Event(
                source="webhook.git",
                kind="deploy_request",
                service=str(payload.get("service") or "shoplite-api"),
                severity="info",
                data={
                    "commit_sha": head_sha,
                    "ref": str((pr.get("base") or {}).get("ref") or "main"),
                    "diff": diff,
                    "pr_number": pr.get("number"),
                    "sender": (payload.get("sender") or {}).get("login", "git"),
                },
            )
            await bus.publish(evt)
            return evt

    return None
