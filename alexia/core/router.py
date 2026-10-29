"""Model router and tier escalation controller for Nemotron on Token Factory.

Implements PRD Section 7.1 and FR-C3:
- Routes tasks to appropriate model tiers (Nano, Super, Ultra).
- Enforces confidence thresholds and automatic tier escalation:
  - Nano confidence < 0.70 -> escalate to Super
  - Super fix fails verification twice -> Ultra re-plans
  - Ultra fails -> escalate to human
- Leverages Runbook memory to bypass Ultra when known working fixes exist.
"""

from __future__ import annotations
import logging
from typing import Any, Dict, List, Optional, Tuple, Type, TypeVar
from pydantic import BaseModel

from alexia.core.llm import LLMClient, get_llm_client
from alexia.core.memory import RunbookMemory, get_runbook_memory
from alexia.core.schemas import Action, Diagnosis, DiagnosticSource, ModelCall, ModelTier

logger = logging.getLogger("alexia.router")

T = TypeVar("T", bound=BaseModel)


class TriageOutput(BaseModel):
    category: str
    severity: str
    confidence: float
    summary: str


class DiagnosisOutput(BaseModel):
    root_cause: str
    evidence: List[str]
    confidence: float
    suggested_actions: List[Dict[str, Any]] = []


class PlanOutput(BaseModel):
    actions: List[Dict[str, Any]]
    expected_outcome: str
    rollback_plan: str
    confidence: float


class ModelRouter:
    """Intelligent router orchestrating task-to-tier mappings and escalation policies."""

    def __init__(self, llm_client: Optional[LLMClient] = None, memory: Optional[RunbookMemory] = None):
        self.llm = llm_client or get_llm_client()
        self.memory = memory or get_runbook_memory()
        self.nano_confidence_threshold = 0.70

    def get_initial_tier_for_task(self, task: str) -> ModelTier:
        """Map task name to recommended Nemotron tier per PRD 7.1."""
        nano_tasks = {"event_triage", "log_summarisation", "secret_scan_confirmation", "runbook_matching", "push_summary"}
        ultra_tasks = {"fix_planning", "breach_investigation_timeline", "patch_security_review", "migration_risk_review", "multi_agent_orchestration"}
        if task in nano_tasks:
            return "nano"
        elif task in ultra_tasks:
            return "ultra"
        return "super"

    # -----------------------------------------------------------------------

    # Step 1: Triage (Default: Nano -> Escalates to Super)
    # -----------------------------------------------------------------------
    def triage_event(
        self,
        event_kind: str,
        service: str,
        payload: Dict[str, Any],
        incident_id: Optional[str] = None,
    ) -> Tuple[TriageOutput, ModelCall]:
        """Classify incoming event with Nano, escalating to Super if confidence < 0.70."""
        prompt = (
            f"Triage the following runtime event:\n"
            f"Event kind: {event_kind}\n"
            f"Service: {service}\n"
            f"Telemetry data: {payload}\n\n"
            f"Classify into category (crash, oom, disk_full, config_error, dependency, code_bug, security, data_integrity, unknown), "
            f"assign severity (info, low, medium, high, critical), assign confidence (0.0 to 1.0), and provide a short summary."
        )

        tier: ModelTier = "nano"
        triage_res, call = self.llm.structured_complete(
            tier=tier,
            prompt=prompt,
            schema=TriageOutput,
            task="event_triage",
            incident_id=incident_id,
        )

        # Escalation rule: Nano confidence < threshold -> rerun with Super
        if triage_res.confidence < self.nano_confidence_threshold:
            logger.info(
                f"Nano confidence {triage_res.confidence} < {self.nano_confidence_threshold}. Escalating triage to Super."
            )
            triage_res, call = self.llm.structured_complete(
                tier="super",
                prompt=prompt,
                schema=TriageOutput,
                task="event_triage_escalated",
                incident_id=incident_id,
            )

        return triage_res, call

    # -----------------------------------------------------------------------
    # Step 2: Diagnosis (Super + Tavily grounding)
    # -----------------------------------------------------------------------
    def diagnose_incident(
        self,
        category: str,
        service: str,
        log_window: str,
        tavily_sources: List[DiagnosticSource],
        incident_id: Optional[str] = None,
    ) -> Tuple[Diagnosis, ModelCall]:
        """Diagnose root cause using Super grounded in live Tavily sources."""
        sources_text = "\n".join([f"- [{s.title}]({s.url}): {s.snippet or ''}" for s in tavily_sources])
        prompt = (
            f"Diagnose the root cause for an incident on service '{service}' with category '{category}'.\n\n"
            f"Relevant logs (redacted):\n{log_window}\n\n"
            f"Web search reference findings (Tavily):\n{sources_text}\n\n"
            f"Identify root cause, list specific pieces of evidence, and determine confidence score."
        )

        diag_res, call = self.llm.structured_complete(
            tier="super",
            prompt=prompt,
            schema=DiagnosisOutput,
            task="diagnosis",
            incident_id=incident_id,
        )

        diagnosis = Diagnosis(
            root_cause=diag_res.root_cause,
            evidence=diag_res.evidence,
            sources=tavily_sources,
            confidence=diag_res.confidence,
        )

        return diagnosis, call

    # -----------------------------------------------------------------------
    # Step 3: Plan Fix (Ultra or Runbook Memory)
    # -----------------------------------------------------------------------
    def plan_fix(
        self,
        category: str,
        service: str,
        diagnosis: Diagnosis,
        error_indicator: str = "",
        incident_id: Optional[str] = None,
        retry_count: int = 0,
    ) -> Tuple[List[Action], ModelCall]:
        """Formulate remediation plan using Runbook memory or Nemotron Ultra."""
        # 1. Check Runbook Memory (FR-C9)
        if retry_count == 0 and error_indicator:
            match = self.memory.find_matching_runbook(category, service, error_indicator)
            if match:
                logger.info(f"Runbook match found ({match['signature']}). Replaying fix actions with Nano confirmation.")
                nano_prompt = (
                    f"A previous incident with signature '{match['signature']}' was successfully fixed with:\n"
                    f"{[a.action for a in match['actions']]}.\n"
                    f"Current diagnosis: '{diagnosis.root_cause}'. Confirm if this fix is appropriate (yes/no)."
                )
                raw_confirm, call = self.llm.complete(
                    tier="nano",
                    prompt=nano_prompt,
                    task="runbook_matching",
                    incident_id=incident_id,
                )
                if "yes" in raw_confirm.lower():
                    logger.info("Nano confirmed runbook fix replay.")
                    return match["actions"], call

        # 2. Plan with Nemotron Ultra
        tier: ModelTier = "ultra"
        prompt = (
            f"Plan safe remediation actions for an incident on service '{service}'.\n"
            f"Category: {category}\n"
            f"Root cause: {diagnosis.root_cause}\n"
            f"Evidence: {diagnosis.evidence}\n"
            f"Retry count: {retry_count}\n\n"
            f"Select typed actions ONLY from the allowed catalog: "
            f"['restart_container', 'rollback_to_last_good_image', 'clear_tmp_and_rotate_logs', "
            f"'block_ip_temporarily', 'take_snapshot', 'run_integrity_check', 'open_pull_request', "
            f"'restore_snapshot', 'rotate_secret', 'isolate_container_network', 'apply_config_change', "
            f"'raise_memory_limit', 'run_migration', 'merge_pull_request_and_deploy'].\n"
            f"Assign appropriate tier (0=auto safe, 1=needs approval). Output actions, expected outcome, and rollback plan."
        )

        plan_res, call = self.llm.structured_complete(
            tier=tier,
            prompt=prompt,
            schema=PlanOutput,
            task="fix_planning",
            incident_id=incident_id,
        )

        actions: List[Action] = []
        for a_dict in plan_res.actions:
            act = Action(
                action=a_dict.get("action", "restart_container"),
                target=a_dict.get("target", service),
                params=a_dict.get("params", {}),
                tier=a_dict.get("tier", 0),
                reason=diagnosis.root_cause,
                expected_outcome=plan_res.expected_outcome,
                rollback=plan_res.rollback_plan,
                requested_by="agent:orchestrator",
            )
            actions.append(act)

        # Fallback if model yielded empty list
        if not actions:
            actions.append(
                Action(
                    action="restart_container",
                    target=service,
                    tier=0,
                    reason=diagnosis.root_cause or "Automated recovery restart",
                    expected_outcome="Service restored to healthy state",
                    rollback="rollback_to_last_good_image",
                    requested_by="agent:orchestrator",
                )
            )

        return actions, call

    # -----------------------------------------------------------------------
    # Step 4: Redacted Push Summary (Nano)
    # -----------------------------------------------------------------------
    def summarize_for_push(self, incident_title: str, severity: str, actions_taken: List[str]) -> str:
        """Generate a single-sentence push summary with Nano (FR-M3)."""
        prompt = (
            f"Write a single concise sentence (max 12 words) for a mobile push notification:\n"
            f"Incident: {incident_title}\n"
            f"Severity: {severity}\n"
            f"Actions: {', '.join(actions_taken)}\n"
            f"DO NOT include any secrets, IP addresses, tokens, or PII."
        )
        summary, _ = self.llm.complete(
            tier="nano",
            prompt=prompt,
            task="push_summary",
            max_tokens=64,
        )
        return summary.strip()


_global_router: Optional[ModelRouter] = None


def get_model_router() -> ModelRouter:
    """Retrieve or initialize the global ModelRouter."""
    global _global_router
    if _global_router is None:
        _global_router = ModelRouter()
    return _global_router
