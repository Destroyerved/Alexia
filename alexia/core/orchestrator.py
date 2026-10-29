"""Alexia Core Orchestrator: Multi-agent coordination and headline loop manager.

Implements PRD Section 5.1, 5.2, and FR-C2:
- Subscribes to telemetry events on the EventBus.
- Executes the core autonomous loop:
  DETECT -> TRIAGE -> SNAPSHOT -> DIAGNOSE -> PLAN -> ACT -> VERIFY -> LEARN
- Coordinates multi-agent collaboration across Healer, Sentinel, Builder, Deployer, and Integrity.
- Dispatches Push Notifications for critical/high incidents.
"""

from __future__ import annotations
import asyncio
import logging
from typing import Any, Dict, Optional

from alexia.actions.executor import get_executor
from alexia.agents.builder import get_builder_agent
from alexia.agents.deployer import get_deployer_agent
from alexia.agents.healer import get_healer_agent
from alexia.agents.integrity import get_integrity_agent
from alexia.agents.sentinel import get_sentinel_agent
from alexia.core.bus import get_event_bus
from alexia.core.router import get_model_router
from alexia.core.schemas import Event, Incident, Notification, generate_id

logger = logging.getLogger("alexia.orchestrator")


class Orchestrator:
    """Central autonomous engine coordinating all specialized agents."""

    def __init__(self):
        self.bus = get_event_bus()
        self.router = get_model_router()
        self.executor = get_executor()
        self.healer = get_healer_agent()
        self.sentinel = get_sentinel_agent()
        self.builder = get_builder_agent()
        self.deployer = get_deployer_agent()
        self.integrity = get_integrity_agent()

    def start(self) -> None:
        """Register event handlers and subscribe to bus events."""
        self.bus.subscribe("*", self.handle_bus_event)
        logger.info("Alexia Orchestrator subscribed to EventBus.")

    async def handle_bus_event(self, event: Event) -> None:
        """Handle incoming telemetry events from collectors."""
        logger.info(f"Orchestrator received event: {event.kind} from {event.source} (severity: {event.severity})")

        # Skip internal system notifications
        if event.source == "system.internal":
            return

        # -------------------------------------------------------------------
        # 1. Security Breach Events (SQLi, Leaked Secret, Brute Force)
        # -------------------------------------------------------------------
        if event.kind in ("sqli_pattern", "secret_in_diff", "bruteforce", "row_read_anomaly"):
            inc = Incident(
                id=generate_id("inc"),
                category="security",
                severity="critical" if event.kind in ("sqli_pattern", "secret_in_diff") else "high",
                owner_agent="sentinel",
                events=[event.id],
                title=f"Security Alert: {event.kind} detected",
                summary=f"Sentinel triggered on {event.kind} telemetry",
                metadata={"kind": event.kind, "service": event.service, **event.data},
            )
            self.bus.create_incident(inc)

            # Trigger push notification
            self._send_push(inc)

            # Execute Sentinel loop
            await self.sentinel.handle_security_incident(
                incident=inc,
                attacker_ip=event.data.get("ip", "198.51.100.42"),
                raw_payload=event.data.get("payload", event.data.get("diff", "")),
                query_log=event.data.get("query", ""),
            )

        # -------------------------------------------------------------------
        # 2. Runtime Failure Events (Crash, OOM, 5xx Spikes, Disk Full)
        # -------------------------------------------------------------------
        elif event.kind in ("container_exit", "oom", "health_fail", "error_spike", "disk_high"):
            inc = Incident(
                id=generate_id("inc"),
                category="unknown",
                severity=event.severity,
                owner_agent="healer",
                events=[event.id],
                title=f"Runtime Incident: {event.kind} on {event.service}",
                summary=f"Healer investigating {event.kind} event",
                metadata={"kind": event.kind, "service": event.service, **event.data},
            )
            self.bus.create_incident(inc)

            self._send_push(inc)

            # Execute Healer loop
            error_msg = event.data.get("error", event.data.get("message", f"Container issue: {event.kind}"))
            await self.healer.handle_incident(incident=inc, error_text=error_msg)

        # -------------------------------------------------------------------
        # 3. Deploy Request Events
        # -------------------------------------------------------------------
        elif event.kind == "deploy_request":
            commit_sha = event.data.get("commit_sha", "c0ffee12")
            diff_text = event.data.get("diff", "")
            mig_sql = event.data.get("migration_sql", "")
            await self.deployer.deploy_commit(
                commit_sha=commit_sha,
                diff_text=diff_text,
                migration_sql=mig_sql,
                service=event.service,
            )

    def _send_push(self, incident: Incident) -> None:
        """Construct and send a redacted push notification (FR-M2, FR-M3)."""
        try:
            summary = self.router.summarize_for_push(
                incident_title=incident.title,
                severity=incident.severity,
                actions_taken=[a.action for a in incident.plan] or ["autonomous guardian inspecting"],
            )
            notif = Notification(
                id=generate_id("ntf"),
                incident_id=incident.id,
                severity=incident.severity,
                title=incident.title,
                body=summary,
                deep_link=f"/m/incident/{incident.id}",
                actions=["review", "reject"] if incident.severity in ("critical", "high") else [],
            )

            # Broadcast through SSE to live web/mobile clients
            self.bus.broadcast_sse({"type": "notification", "data": notif.model_dump()})

            # Send via remote push sender if configured
            from alexia.remote.push import send_push_notification
            send_push_notification(notif)
        except Exception as e:
            logger.warning(f"Failed to deliver push notification: {e}")


_global_orchestrator: Optional[Orchestrator] = None


def get_orchestrator() -> Orchestrator:
    """Retrieve or initialize global Orchestrator."""
    global _global_orchestrator
    if _global_orchestrator is None:
        _global_orchestrator = Orchestrator()
    return _global_orchestrator
