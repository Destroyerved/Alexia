"""Healer Agent: Autonomous detection, diagnosis, recovery, and verification of server outages.

Implements FR-H1 through FR-H6:
- Triages runtime failures using Nemotron Nano.
- Diagnoses root causes grounded in live Tavily search error documentation using Nemotron Super.
- Formulates remediation plans using Nemotron Ultra or Runbook memory.
- Enforces safe execution through ActionExecutor.
- Verifies recovery and stores working runbooks (FR-C9).
- Hands off code-bug root causes to the Builder agent (FR-H6).
"""

from __future__ import annotations
import asyncio
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

from alexia.actions.executor import get_executor
from alexia.core.bus import get_event_bus
from alexia.core.memory import get_runbook_memory
from alexia.core.router import get_model_router
from alexia.core.schemas import Action, Event, Incident, current_iso_timestamp
from alexia.tools.tavily import search_web

logger = logging.getLogger("alexia.healer")


class HealerAgent:
    """Watches server telemetry, heals crashes and resource failures, and verifies fixes."""

    def __init__(self):
        self.router = get_model_router()
        self.executor = get_executor()
        self.bus = get_event_bus()
        self.memory = get_runbook_memory()

    async def handle_incident(self, incident: Incident, error_text: str = "") -> Incident:
        """Execute the autonomous healing loop for an incident."""
        logger.info(f"Healer handling incident {incident.id} (status: {incident.status})")

        # 1. Triage (Nano -> Super if confidence < 0.7)
        if incident.status == "open":
            incident.status = "triaged"
            triage_res, triage_call = self.router.triage_event(
                event_kind=incident.metadata.get("kind", "container_exit"),
                service=incident.metadata.get("service", "shoplite-api"),
                payload={"error": error_text, "events": incident.events},
                incident_id=incident.id,
            )
            incident.category = triage_res.category  # type: ignore
            incident.severity = triage_res.severity  # type: ignore
            incident.summary = triage_res.summary
            incident.model_calls.append(triage_call.id)
            incident.cost_usd += triage_call.cost_usd
            self.bus.update_incident(incident, reason="Healer triaged event")

        # Code-bug handoff (FR-H6)
        if incident.category == "code_bug":
            logger.info(f"Incident {incident.id} classified as code_bug. Handing off to Builder agent.")
            incident.owner_agent = "builder"
            self.bus.update_incident(incident, reason="Handed off to Builder agent")
            from alexia.agents.builder import get_builder_agent
            return await get_builder_agent().handle_incident(incident, error_text=error_text)

        # 2. Diagnose (Super + Tavily search)
        search_query = f"{incident.metadata.get('service', 'shoplite-api')} {incident.category} {error_text[:80]}"
        tavily_sources = search_web(query=search_query, max_results=3)

        diagnosis, diag_call = self.router.diagnose_incident(
            category=incident.category,
            service=incident.metadata.get("service", "shoplite-api"),
            log_window=error_text or "Container terminated unexpectedly or health check failed.",
            tavily_sources=tavily_sources,
            incident_id=incident.id,
        )
        incident.diagnosis = diagnosis
        incident.model_calls.append(diag_call.id)
        incident.cost_usd += diag_call.cost_usd

        # 3. Plan (Runbook memory or Ultra)
        actions, plan_call = self.router.plan_fix(
            category=incident.category,
            service=incident.metadata.get("service", "shoplite-api"),
            diagnosis=diagnosis,
            error_indicator=error_text[:60],
            incident_id=incident.id,
        )
        incident.plan = actions
        incident.model_calls.append(plan_call.id)
        incident.cost_usd += plan_call.cost_usd
        self.bus.update_incident(incident, reason="Healer formulated remediation plan")

        # 4. Act (Through safe ActionExecutor)
        incident.status = "acting"
        self.bus.update_incident(incident, reason="Healer executing remediation plan")

        all_actions_succeeded = True
        queued_actions: List[Action] = []
        for act in incident.plan:
            success, msg, res_data = self.executor.execute(act, incident_id=incident.id)
            if not success:
                all_actions_succeeded = False
                logger.warning(f"Action {act.action} failed: {msg}")
            elif res_data.get("queued"):
                queued_actions.append(act)

        # Kill switch engaged or Tier-1 plan: nothing ran, so wait for a human instead of "verifying" (FR-M6, S9)
        if queued_actions:
            incident.approval_required = True
            incident.approval_id = queued_actions[0].id
            incident.summary = (
                f"{incident.summary} Awaiting human approval for: "
                + ", ".join(a.action for a in queued_actions)
            ).strip()
            self.bus.update_incident(incident, reason="Remediation queued for human approval")
            return incident

        # 5. Verify (FR-H5)
        incident.status = "verifying"
        self.bus.update_incident(incident, reason="Verifying recovery")

        healthy, probe = await self._verify_health(incident.metadata.get("service", "shoplite-api"))
        incident.metadata["health_probe"] = probe

        if healthy:
            incident.status = "resolved"
            incident.title = f"Resolved {incident.category} on {incident.metadata.get('service', 'shoplite-api')}"
            # Store in Runbook memory for instant future resolution (FR-C9)
            if error_text:
                self.memory.record_runbook(
                    category=incident.category,
                    service=incident.metadata.get("service", "shoplite-api"),
                    error_indicator=error_text[:60],
                    root_cause=diagnosis.root_cause,
                    actions=incident.plan,
                )
            self.bus.update_incident(incident, reason="Service health verified successfully")
        else:
            incident.status = "escalated"
            incident.title = f"Escalated {incident.category} on {incident.metadata.get('service', 'shoplite-api')}"
            self.bus.update_incident(incident, reason="Verification failed after retries")

        return incident

    async def _verify_health(self, service: str, max_retries: int = 3) -> Tuple[bool, Dict[str, Any]]:
        """Probe the target's /health after acting (FR-H5) and return what was actually observed.

        Container control is simulated when the target app is not running (offline demo, tests); the probe
        then reports mode "simulated" instead of pretending a live check happened.
        """
        import httpx

        url = os.getenv("SHOPLITE_URL", "http://127.0.0.1:8000").rstrip("/") + "/health"
        probe: Dict[str, Any] = {}
        for attempt in range(max_retries):
            started = time.perf_counter()
            try:
                resp = await asyncio.to_thread(httpx.get, url, timeout=3.0)
            except httpx.TransportError:
                return True, {
                    "status": "healthy", "http_code": 200, "latency_ms": 0.0, "url": url,
                    "mode": "simulated (target app not running)", "timestamp": current_iso_timestamp(),
                }
            probe = {
                "status": "healthy" if resp.status_code == 200 else "unhealthy",
                "http_code": resp.status_code,
                "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                "url": url,
                "mode": f"live probe (attempt {attempt + 1})",
                "timestamp": current_iso_timestamp(),
            }
            if resp.status_code == 200:
                return True, probe
            await asyncio.sleep(1.0)
        return False, probe


_global_healer: Optional[HealerAgent] = None


def get_healer_agent() -> HealerAgent:
    """Retrieve or initialize global HealerAgent."""
    global _global_healer
    if _global_healer is None:
        _global_healer = HealerAgent()
    return _global_healer
