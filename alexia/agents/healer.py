"""Healer Agent: Autonomous detection, diagnosis, recovery, retry/re-plan, and verification of server outages.

Implements FR-H1 through FR-H6:
- Triages runtime failures using Nemotron Nano (escalating to Super if confidence < 0.70).
- Diagnoses root causes grounded in live Tavily search error documentation using Nemotron Super.
- Formulates remediation plans using Runbook memory or Nemotron Ultra, retrying up to 2x with Ultra re-planning on verification failure (FR-H5).
- Enforces safe execution through ActionExecutor.
- Verifies recovery honestly (never simulating success in production) and stores working runbooks (FR-C9).
- Hands off code-bug root causes to the Builder agent (FR-H6).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

from alexia.actions.executor import get_executor
from alexia.agents.base import GuardianAgent
from alexia.core.bus import get_event_bus
from alexia.core.config import allow_simulated_health
from alexia.core.memory import get_runbook_memory
from alexia.core.router import get_model_router
from alexia.core.schemas import Action, Incident, current_iso_timestamp
from alexia.tools.tavily import search_web

logger = logging.getLogger("alexia.healer")

MAX_HEAL_RETRIES = 2


class HealerAgent(GuardianAgent):
    """Watches server telemetry, heals crashes and resource failures, and verifies fixes."""

    agent_id = "healer"
    role = "Site reliability engineer: triage, diagnosis, catalogued recovery, verification"
    capabilities = (
        "incident_triage",
        "root_cause_diagnosis",
        "remediation_planning",
        "safe_action_execution",
        "recovery_verification",
        "runbook_memory",
    )
    entrypoints = ("handle_incident",)

    @property
    def router(self):
        return get_model_router()

    @property
    def executor(self):
        return get_executor()

    @property
    def bus(self):
        return get_event_bus()

    @property
    def memory(self):
        return get_runbook_memory()

    async def handle_incident(self, incident: Incident, error_text: str = "") -> Incident:
        """Execute the autonomous healing loop with retry + Ultra re-planning."""
        logger.info(f"Healer handling incident {incident.id} (status: {incident.status})")
        service = incident.metadata.get("service", "shoplite-api")

        # 1. Triage (Nano -> Super if confidence < 0.7)
        if incident.status == "open":
            incident.status = "triaged"
            triage_res, triage_call = self.router.triage_event(
                event_kind=incident.metadata.get("kind", "container_exit"),
                service=service,
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
        search_query = f"{service} {incident.category} {error_text[:80]}"
        tavily_sources = search_web(query=search_query, max_results=3)

        diagnosis, diag_call = self.router.diagnose_incident(
            category=incident.category,
            service=service,
            log_window=error_text or "Container terminated unexpectedly or health check failed.",
            tavily_sources=tavily_sources,
            incident_id=incident.id,
        )
        incident.diagnosis = diagnosis
        incident.model_calls.append(diag_call.id)
        incident.cost_usd += diag_call.cost_usd

        # 3-5. Plan -> Act -> Verify loop (up to MAX_HEAL_RETRIES; retry_count > 0 forces Ultra re-planning)
        healthy = False
        probe: Dict[str, Any] = {}
        for retry_idx in range(MAX_HEAL_RETRIES):
            actions, plan_call = self.router.plan_fix(
                category=incident.category,
                service=service,
                diagnosis=diagnosis,
                error_indicator=error_text[:60],
                incident_id=incident.id,
                retry_count=retry_idx,
            )
            incident.plan = actions if retry_idx == 0 else (incident.plan + actions)
            incident.model_calls.append(plan_call.id)
            incident.cost_usd += plan_call.cost_usd
            self.bus.update_incident(incident, reason=f"Healer formulated remediation plan (attempt {retry_idx + 1})")

            incident.status = "acting"
            self.bus.update_incident(incident, reason="Healer executing remediation plan")

            queued_actions: List[Action] = []
            for act in actions:
                success, msg, res_data = self.executor.execute(act, incident_id=incident.id)
                if not success:
                    logger.warning(f"Action {act.action} failed: {msg}")
                elif res_data.get("queued"):
                    queued_actions.append(act)

            if queued_actions:
                incident.approval_required = True
                incident.approval_id = queued_actions[0].id
                incident.summary = (
                    f"{incident.summary} Awaiting human approval for: "
                    + ", ".join(a.action for a in queued_actions)
                ).strip()
                self.bus.update_incident(incident, reason="Remediation queued for human approval")
                return incident

            incident.status = "verifying"
            self.bus.update_incident(incident, reason="Verifying recovery")

            healthy, probe = await self._verify_health(service)
            incident.metadata["health_probe"] = probe
            if healthy:
                break
            logger.warning(f"Healer verification attempt {retry_idx + 1}/{MAX_HEAL_RETRIES} failed for {service}; re-planning with Ultra.")

        if healthy:
            incident.status = "resolved"
            incident.title = f"Resolved {incident.category} on {service}"
            if error_text:
                self.memory.record_runbook(
                    category=incident.category,
                    service=service,
                    error_indicator=error_text[:60],
                    root_cause=diagnosis.root_cause,
                    actions=[a for a in incident.plan if a.status == "executed"] or incident.plan,
                )
            self.bus.update_incident(incident, reason="Service health verified successfully")
        else:
            incident.status = "escalated"
            incident.title = f"Escalated {incident.category} on {service}"
            self.bus.update_incident(incident, reason="Verification failed after retries")

        return incident

    async def _verify_health(self, service: str, max_retries: int = 3) -> Tuple[bool, Dict[str, Any]]:
        """Probe the target's /health after acting (FR-H5) and return what was actually observed."""
        import httpx

        allow_simulation = allow_simulated_health()
        url = os.getenv("SHOPLITE_URL", "http://127.0.0.1:8000").rstrip("/") + "/health"
        probe: Dict[str, Any] = {}
        for attempt in range(max(1, max_retries)):
            started = time.perf_counter()
            try:
                resp = await asyncio.to_thread(httpx.get, url, timeout=3.0)
            except httpx.HTTPError as exc:
                if allow_simulation:
                    return True, {
                        "status": "healthy",
                        "http_code": 200,
                        "latency_ms": 0.0,
                        "url": url,
                        "mode": "simulated (target app not running)",
                        "timestamp": current_iso_timestamp(),
                    }
                probe = {
                    "status": "unreachable",
                    "http_code": None,
                    "latency_ms": 0.0,
                    "url": url,
                    "mode": "live probe",
                    "error": f"{type(exc).__name__}: {exc}",
                    "timestamp": current_iso_timestamp(),
                }
                if attempt + 1 < max_retries:
                    await asyncio.sleep(0.5)
                    continue
                return False, probe

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
            if attempt + 1 < max_retries:
                await asyncio.sleep(0.5)
        return False, probe


_global_healer: Optional[HealerAgent] = None


def get_healer_agent() -> HealerAgent:
    """Retrieve or initialize global HealerAgent."""
    global _global_healer
    if _global_healer is None:
        _global_healer = HealerAgent()
    return _global_healer
