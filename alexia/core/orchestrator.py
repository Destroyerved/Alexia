"""Alexia Core Orchestrator: Multi-agent coordination and headline loop manager.

Implements PRD Section 5.1, 5.2, and FR-C2:
- Subscribes to telemetry events on the EventBus.
- Executes the core autonomous loop:
  DETECT -> TRIAGE -> SNAPSHOT -> DIAGNOSE -> PLAN -> ACT -> VERIFY -> LEARN
- Coordinates multi-agent collaboration across Healer, Sentinel, Builder, Deployer, and Integrity.
- Persists and dispatches redacted Notifications for web and mobile companion clients.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from alexia.actions.executor import get_executor
from alexia.agents.builder import get_builder_agent
from alexia.agents.deployer import get_deployer_agent
from alexia.agents.healer import get_healer_agent
from alexia.agents.integrity import get_integrity_agent
from alexia.agents.sentinel import get_sentinel_agent
from alexia.core.bus import get_event_bus
from alexia.core.redact import redact
from alexia.core.router import get_model_router
from alexia.core.schemas import Event, Incident, Notification, generate_id
from alexia.core.state_store import get_state_store

logger = logging.getLogger("alexia.orchestrator")


class Orchestrator:
    """Central autonomous engine coordinating all specialized agents."""

    @property
    def bus(self):
        return get_event_bus()

    @property
    def router(self):
        return get_model_router()

    @property
    def executor(self):
        return get_executor()

    @property
    def healer(self):
        return get_healer_agent()

    @property
    def sentinel(self):
        return get_sentinel_agent()

    @property
    def builder(self):
        return get_builder_agent()

    @property
    def deployer(self):
        return get_deployer_agent()

    @property
    def integrity(self):
        return get_integrity_agent()

    def start(self) -> None:
        """Register event handlers on the active EventBus."""
        self.bus.subscribe("*", self.handle_bus_event)
        logger.info("Alexia Orchestrator subscribed to EventBus.")

    async def handle_bus_event(self, event: Event) -> None:
        """Handle incoming telemetry events on a worker thread so blocking calls never stall HTTP/SSE."""
        await asyncio.to_thread(asyncio.run, self._handle_event(event))

    async def _handle_event(self, event: Event) -> None:
        logger.info(f"Orchestrator received event: {event.kind} from {event.source} (severity: {event.severity})")

        if event.source == "system.internal":
            return

        # 1. Security Breach Events (SQLi, Leaked Secret, Brute Force)
        if event.kind in ("sqli_pattern", "secret_in_diff", "bruteforce", "row_read_anomaly"):
            redacted_data = redact(event.data)
            inc = Incident(
                id=generate_id("inc"),
                category="security",
                severity="critical" if event.kind in ("sqli_pattern", "secret_in_diff") else "high",
                owner_agent="sentinel",
                events=[event.id],
                title=f"Security Alert: {event.kind} detected",
                summary=f"Sentinel triggered on {event.kind} telemetry",
                metadata={"kind": event.kind, "service": event.service, **redacted_data},
            )
            self.bus.create_incident(inc)
            self._send_push(inc)

            await self.sentinel.handle_security_incident(
                incident=inc,
                attacker_ip=event.data.get("ip", "198.51.100.42"),
                raw_payload=event.data.get("payload", event.data.get("diff", "")),
                query_log=event.data.get("query", ""),
            )

        # 2. Runtime Failure Events (Crash, OOM, 5xx Spikes, Disk Full)
        elif event.kind in ("container_exit", "oom", "health_fail", "error_spike", "disk_high"):
            redacted_data = redact(event.data)
            inc = Incident(
                id=generate_id("inc"),
                category="unknown",
                severity=event.severity,
                owner_agent="healer",
                events=[event.id],
                title=f"Runtime Incident: {event.kind} on {event.service}",
                summary=f"Healer investigating {event.kind} event",
                metadata={"kind": event.kind, "service": event.service, **redacted_data},
            )
            self.bus.create_incident(inc)
            self._send_push(inc)

            error_msg = event.data.get("error", event.data.get("message", f"Container issue: {event.kind}"))
            await self.healer.handle_incident(incident=inc, error_text=error_msg)

        # 3. Deploy Request Events
        elif event.kind == "deploy_request":
            commit_sha = event.data.get("commit_sha", "c0ffee12")
            diff_text = event.data.get("diff", "")
            mig_sql = event.data.get("migration_sql", "")
            await self.deployer.deploy_commit(
                commit_sha=commit_sha,
                diff_text=diff_text,
                migration_sql=mig_sql,
                service=event.service,
                force_deploy=bool(event.data.get("force_deploy", False)),
                event_id=event.id,
            )

    def _send_push(self, incident: Incident) -> None:
        """Construct, persist, and dispatch a redacted notification (FR-M2, FR-M3)."""
        try:
            safe_title = str(redact(incident.title, mask_ips=True))
            summary = self.router.summarize_for_push(
                incident_title=safe_title,
                severity=incident.severity,
                actions_taken=[a.action for a in incident.plan] or ["autonomous guardian inspecting"],
            )
            notif = Notification(
                id=generate_id("ntf"),
                incident_id=incident.id,
                severity=incident.severity,
                title=safe_title,
                body=summary,
                deep_link=f"/m/incident/{incident.id}",
                actions=["review", "reject"] if incident.severity in ("critical", "high") else [],
            )

            stored = get_state_store().record_notification(notif.model_dump())
            self.bus.broadcast_sse({"type": "notification", "data": stored})

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
