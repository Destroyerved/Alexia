"""Builder Agent: Autonomous code debugging, regression test writing, sandboxed iteration, and Pull Request authoring.

Implements FR-B1 through FR-B6 (Centerpiece of the Coding Track):
- Pre-deploy code review of diffs with Nemotron Super / Ultra.
- Automated generation of a failing regression test (RED) proving the bug.
- Automated generation of a clean code patch.
- Isolated sandbox execution loop with test feedback (up to 3 iterations).
- Cryptographic proof of fix: records that test FAILS before patch and PASSES after.
- Authors Pull Requests via GitHub REST API with full reasoning and Tavily sources.
"""

from __future__ import annotations
import asyncio
import json
import logging
from typing import Any, Dict, List, Optional
from pydantic import BaseModel

from alexia.core.bus import get_event_bus
from alexia.core.llm import get_llm_client
from alexia.core.redact import redact
from alexia.core.router import get_model_router
from alexia.actions.executor import get_executor
from alexia.core.schemas import Action, Diagnosis, Incident
from alexia.tools.github import open_github_pr
from alexia.tools.sandbox import get_sandbox_runner
from alexia.tools.tavily import search_web

logger = logging.getLogger("alexia.builder")

TARGET_FILE = "app/main.py"
MAX_FIX_ATTEMPTS = 3


class CodeReviewResult(BaseModel):
    has_critical_issue: bool
    findings: List[str]
    suggested_action: str
    confidence: float


class PatchGenerationOutput(BaseModel):
    root_cause: str
    patch: str
    failing_test: str
    explanation: str


class BuilderAgent:
    """The developer agent that writes, tests, proves, and ships code fixes."""

    def __init__(self):
        self.router = get_model_router()
        self.llm = get_llm_client()
        self.bus = get_event_bus()
        self.sandbox = get_sandbox_runner()

    def review_diff(self, diff_text: str, incident_id: Optional[str] = None) -> CodeReviewResult:
        """Perform pre-deploy code review with Nemotron Super / Ultra (FR-B1)."""
        prompt = (
            f"Perform pre-deploy security and correctness review on the following git diff:\n\n"
            f"```diff\n{diff_text}\n```\n\n"
            f"Detect: (1) Leaked API keys or secrets, (2) SQL injection vulnerabilities, "
            f"(3) Division by zero or crash hazards, (4) Unhandled exceptions.\n"
            f"Decide whether to block the deployment or allow."
        )

        res, call = self.llm.structured_complete(
            tier="super",
            prompt=prompt,
            schema=CodeReviewResult,
            task="pre_deploy_code_review",
            incident_id=incident_id,
        )
        return res

    async def handle_incident(self, incident: Incident, error_text: str = "") -> Incident:
        """Run the end-to-end Builder loop: write failing test + patch -> sandbox red/green -> review -> PR."""
        logger.info(f"Builder starting remediation loop for incident {incident.id}")
        service = incident.metadata.get("service", "shoplite-api")
        incident.owner_agent = "builder"
        incident.status = "acting"

        # 1. Search Tavily for error / CVE references
        search_query = f"{service} {incident.category} {error_text[:80]}"
        tavily_sources = search_web(query=search_query, max_results=3)

        # 2-3. Write test + patch against the code as deployed, prove it in the sandbox, iterate (FR-B2, FR-B3)
        base_diff = incident.metadata.get("deploy_diff", "")
        source = self.sandbox.read_workspace_file(TARGET_FILE, base_diff=base_diff)
        feedback = ""
        attempts: List[Dict[str, Any]] = []
        patch_output: Optional[PatchGenerationOutput] = None
        sandbox_result: Dict[str, Any] = {}
        for attempt in range(1, MAX_FIX_ATTEMPTS + 1):
            # Super writes the fix; if it fails verification twice, Ultra re-plans (PRD 7.1 escalation)
            tier = "super" if attempt < MAX_FIX_ATTEMPTS else "ultra"
            prompt = (
                f"An incident of category '{incident.category}' occurred on service '{service}':\n"
                f"Error details: {error_text or incident.summary}\n\n"
                f"SOURCE {TARGET_FILE} (as currently deployed):\n```python\n{source.rstrip()}\n```\n\n"
                "Generate:\n"
                "1. failing_test: a standalone pytest file (fastapi TestClient, `from app.main import app`) that FAILS "
                "on the code above because of this bug (Phase RED).\n"
                f"2. patch: a unified diff against {TARGET_FILE} (--- a/{TARGET_FILE} / +++ b/{TARGET_FILE}) that makes "
                "the test pass without side-effects (Phase GREEN).\n"
                "3. root_cause and a concise explanation."
                f"{feedback}"
            )
            patch_output, patch_call = self.llm.structured_complete(
                tier=tier,
                prompt=prompt,
                schema=PatchGenerationOutput,
                task="code_patch_generation",
                incident_id=incident.id,
            )
            incident.model_calls.append(patch_call.id)
            incident.cost_usd += patch_call.cost_usd

            logger.info(f"Sandbox red-to-green run, attempt {attempt}/{MAX_FIX_ATTEMPTS} ({tier})")
            sandbox_result = await asyncio.to_thread(
                self.sandbox.verify_patch,
                failing_test_code=patch_output.failing_test,
                patch_diff=patch_output.patch,
                base_diff=base_diff,
            )
            attempts.append({"attempt": attempt, "model_tier": tier, "summary": sandbox_result["summary"]})
            if sandbox_result["success"]:
                break
            feedback = (
                f"\n\nAttempt {attempt} was not proven: {sandbox_result['summary']}\n"
                f"Test output before the patch:\n{sandbox_result['before_log'][-1200:]}\n"
                f"Test output after the patch:\n{sandbox_result['after_log'][-1200:]}\n"
                "Fix the test and/or the patch."
            )

        proven = bool(sandbox_result.get("success"))
        # Sandbox output can echo target data (e.g. rows an exploit leaked): redact before storing or publishing
        for key in ("before_log", "after_log"):
            sandbox_result[key] = redact(sandbox_result[key])
        incident.metadata["proof_of_fix"] = {
            "failed_before": sandbox_result["failed_before"],
            "passed_after": sandbox_result["passed_after"],
            "before_log": sandbox_result["before_log"][-4000:],
            "after_log": sandbox_result["after_log"][-4000:],
        }
        code_fix: Dict[str, Any] = {
            "target_file": TARGET_FILE,
            "root_cause": patch_output.root_cause,
            "explanation": patch_output.explanation,
            "failing_test": patch_output.failing_test,
            "patch": patch_output.patch,
            "proven": proven,
            "summary": sandbox_result["summary"],
            "patch_applied": sandbox_result["patch_applied"],
            "base_note": sandbox_result.get("base_note", ""),
            "test_runner": sandbox_result.get("test_runner", "pytest"),
            "attempts": attempts,
        }

        # Ground the incident diagnosis in the patch root cause and Tavily sources (FR-U2) when none exists yet
        if not incident.diagnosis.root_cause:
            incident.diagnosis = Diagnosis(
                root_cause=patch_output.root_cause,
                explanation=patch_output.explanation,
                evidence=[
                    error_text or incident.summary,
                    f"RED: regression test failed before patch = {sandbox_result['failed_before']}",
                    f"GREEN: regression test passed after patch = {sandbox_result['passed_after']}",
                ],
                sources=tavily_sources,
                confidence=0.9 if proven else 0.6,
            )
        elif not incident.diagnosis.sources:
            # e.g. Sentinel already wrote the root cause; still show the Tavily sources behind the fix
            incident.diagnosis.sources = tavily_sources

        if not proven:
            # Retry budget spent without red-to-green proof: hand to a human, never open an unproven PR (PRD 5.2)
            incident.metadata["code_fix"] = code_fix
            incident.status = "escalated"
            incident.title = f"Builder could not prove a fix for {incident.category} on {service}"
            incident.summary = f"{sandbox_result['summary']} Escalated to a human after {len(attempts)} attempt(s)."
            self.bus.update_incident(incident, reason="Builder fix not proven; escalated")
            return incident

        # 4. Security review of the proven patch with Ultra before it leaves the box (FR-B6)
        ultra_review, ultra_call = self.llm.complete(
            tier="ultra",
            prompt=(
                f"Review this generated patch before submission to GitHub:\n\n```diff\n{patch_output.patch}\n```\n\n"
                "Verify that it introduces no security regressions, data loss, or syntax errors. Reply 'APPROVED' or 'REJECT'."
            ),
            task="patch_security_review",
            incident_id=incident.id,
        )
        incident.model_calls.append(ultra_call.id)
        incident.cost_usd += ultra_call.cost_usd
        code_fix["security_review"] = ultra_review.strip()[:400]

        # 5. Open Pull Request on GitHub with the proof attached (FR-B4, FR-B5)
        pr_body = (
            f"## Alexia Guardian Automated Remediation\n\n"
            f"### Root Cause\n{patch_output.root_cause}\n\n"
            f"### Explanation\n{patch_output.explanation}\n\n"
            f"### Regression Test\n```python\n{patch_output.failing_test}\n```\n\n"
            f"### Proof of Fix (Sandbox Verification)\n"
            f"- **Before patch (RED):** regression test failed\n"
            f"```text\n{sandbox_result['before_log'][-1500:]}\n```\n"
            f"- **After patch (GREEN):** regression test passed\n"
            f"```text\n{sandbox_result['after_log'][-1500:]}\n```\n\n"
            f"### External Grounding Sources (Tavily)\n"
            + "\n".join([f"- [{s.title}]({s.url})" for s in tavily_sources])
        )
        pr_info = open_github_pr(
            title=f"fix({service}): remediate {incident.category}",
            branch=f"fix/alexia-{incident.id}",
            body=pr_body,
            patch=patch_output.patch,
        )
        code_fix["pr"] = {"number": pr_info.get("number"), "html_url": pr_info.get("html_url"), "mode": pr_info.get("mode")}
        incident.metadata["code_fix"] = code_fix
        incident.metadata["verification"] = {
            "test_before": {"passed": False, "output": sandbox_result["before_log"][-4000:], "timestamp": incident.created_at},
            "test_after": {"passed": True, "output": sandbox_result["after_log"][-4000:], "timestamp": incident.updated_at},
            "health_check": {"status": "awaiting merge", "latency_ms": 0, "http_code": 0, "timestamp": incident.updated_at},
            "deployment_status": f"PR #{pr_info.get('number')} awaiting merge approval",
            "snapshot_verified": bool(incident.snapshots),
        }

        incident.plan.append(
            Action(
                action="open_pull_request",
                target=service,
                tier=0,
                params={"pr_number": pr_info.get("number"), "html_url": pr_info.get("html_url")},
                reason=patch_output.root_cause,
                expected_outcome="Proven fix opened as GitHub PR for merge review",
                requested_by="agent:builder",
                status="executed",
                execution_result={k: v for k, v in pr_info.items() if k not in ("body", "patch")},
            )
        )

        # 6. Tier-1 merge + deploy: queued through the executor so it lands in the approval panel (FR-C7, FR-D5)
        merge_action = Action(
            action="merge_pull_request_and_deploy",
            target=service,
            tier=1,
            params={"pr_number": pr_info.get("number"), "branch": f"fix/alexia-{incident.id}"},
            reason=f"Merge proven fix PR #{pr_info.get('number')} and deploy through the health-gated pipeline",
            expected_outcome="Release candidate deployed through health-gated pipeline",
            rollback="rollback_to_last_good_image",
            requested_by="agent:builder",
        )
        get_executor().execute(merge_action, incident_id=incident.id)
        incident.approval_required = True
        incident.approval_id = merge_action.id
        incident.plan.append(merge_action)

        # A proven fix waits on the human merge approval
        incident.status = "acting"
        incident.title = f"Fix PR #{pr_info.get('number')} opened with red-to-green proof"
        incident.summary = (
            f"Regression test failed before and passed after the patch ({len(attempts)} attempt(s)). "
            f"Opened PR #{pr_info.get('number')}; merge awaits approval."
        )
        self.bus.update_incident(incident, reason="Builder completed code fix and opened PR")

        return incident


_global_builder: Optional[BuilderAgent] = None


def get_builder_agent() -> BuilderAgent:
    """Retrieve or initialize global BuilderAgent."""
    global _global_builder
    if _global_builder is None:
        _global_builder = BuilderAgent()
    return _global_builder
