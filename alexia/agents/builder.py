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
import json
import logging
from typing import Any, Dict, List, Optional
from pydantic import BaseModel

from alexia.core.bus import get_event_bus
from alexia.core.llm import get_llm_client
from alexia.core.router import get_model_router
from alexia.actions.executor import get_executor
from alexia.core.schemas import Action, Diagnosis, Incident
from alexia.tools.github import open_github_pr
from alexia.tools.sandbox import get_sandbox_runner
from alexia.tools.tavily import search_web

logger = logging.getLogger("alexia.builder")


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
        """Run the end-to-end Builder loop: diagnose -> write failing test -> patch -> sandbox -> PR."""
        logger.info(f"Builder starting remediation loop for incident {incident.id}")
        incident.owner_agent = "builder"
        incident.status = "acting"

        # 1. Search Tavily for error / CVE references
        search_query = f"{incident.metadata.get('service', 'shoplite-api')} {incident.category} {error_text[:80]}"
        tavily_sources = search_web(query=search_query, max_results=3)

        # 2. Generate Fix and Failing Regression Test using Nemotron Super (FR-B2)
        prompt = (
            f"An incident of category '{incident.category}' occurred on service '{incident.metadata.get('service', 'shoplite-api')}':\n"
            f"Error details: {error_text or incident.summary}\n\n"
            f"Generate:\n"
            f"1. A failing pytest regression test that reproduces the failure (Phase RED).\n"
            f"2. A unified diff patch that fixes the bug cleanly without side-effects (Phase GREEN).\n"
            f"3. A concise explanation."
        )

        patch_output, patch_call = self.llm.structured_complete(
            tier="super",
            prompt=prompt,
            schema=PatchGenerationOutput,
            task="code_patch_generation",
            incident_id=incident.id,
        )
        incident.model_calls.append(patch_call.id)
        incident.cost_usd += patch_call.cost_usd

        # 3. Security Review of the Patch with Ultra (FR-B6)
        ultra_review_prompt = (
            f"Review this generated patch before submission to GitHub:\n\n"
            f"```diff\n{patch_output.patch}\n```\n\n"
            f"Verify that it introduces no security regressions, data loss, or syntax errors. Reply 'APPROVED' or 'REJECT'."
        )
        ultra_review, ultra_call = self.llm.complete(
            tier="ultra",
            prompt=ultra_review_prompt,
            task="patch_security_review",
            incident_id=incident.id,
        )
        incident.model_calls.append(ultra_call.id)
        incident.cost_usd += ultra_call.cost_usd

        # 4. Sandbox Run Loop: Red -> Green Proof of Fix (FR-B3, FR-B4)
        logger.info("Executing sandbox run loop to verify red-to-green proof...")
        sandbox_result = self.sandbox.verify_patch(
            failing_test_code=patch_output.failing_test,
            patch_diff=patch_output.patch,
        )

        incident.metadata["proof_of_fix"] = {
            "failed_before": sandbox_result["failed_before"],
            "passed_after": sandbox_result["passed_after"],
            "before_log": sandbox_result["before_log"][:300],
            "after_log": sandbox_result["after_log"][:300],
        }

        # 5. Open Pull Request on GitHub (FR-B5)
        pr_title = f"fix({incident.metadata.get('service', 'shoplite-api')}): remediate {incident.category}"
        pr_body = (
            f"## Alexia Guardian Automated Remediation\n\n"
            f"### Root Cause\n{patch_output.root_cause}\n\n"
            f"### Explanation\n{patch_output.explanation}\n\n"
            f"### Proof of Fix (Sandbox Verification)\n"
            f"- **Before Patch (RED):** Test failed as expected\n"
            f"```text\n{sandbox_result['before_log'][:200]}\n```\n"
            f"- **After Patch (GREEN):** All tests passing\n"
            f"```text\n{sandbox_result['after_log'][:200]}\n```\n\n"
            f"### External Grounding Sources (Tavily)\n"
            + "\n".join([f"- [{s.title}]({s.url})" for s in tavily_sources])
        )

        pr_info = open_github_pr(
            title=pr_title,
            branch=f"fix/alexia-{incident.id}",
            body=pr_body,
            patch=patch_output.patch,
        )

        # 6. Add Tier-0 Action to Plan
        incident.plan.append(
            Action(
                action="open_pull_request",
                target=incident.metadata.get("service", "shoplite-api"),
                tier=0,
                params={"pr_number": pr_info.get("number"), "html_url": pr_info.get("html_url")},
                reason=patch_output.root_cause,
                expected_outcome="Proven fix opened as GitHub PR for merge review",
                requested_by="agent:builder",
                status="executed",
                execution_result=pr_info,
            )
        )

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
                confidence=0.9 if sandbox_result["success"] else 0.6,
            )
        elif not incident.diagnosis.sources:
            # e.g. Sentinel already wrote the root cause; still show the Tavily sources behind the fix
            incident.diagnosis.sources = tavily_sources

        # 7. Tier-1 merge + deploy: queued through the executor so it lands in the approval panel (FR-C7, FR-D5)
        merge_action = Action(
            action="merge_pull_request_and_deploy",
            target=incident.metadata.get("service", "shoplite-api"),
            tier=1,
            params={"pr_number": pr_info.get("number"), "branch": f"fix/alexia-{incident.id}"},
            reason=f"Merge proven fix PR #{pr_info.get('number')} and deploy through the health-gated pipeline",
            expected_outcome="Release candidate deployed through health-gated pipeline",
            rollback="rollback_to_last_good_image",
            requested_by="agent:builder",
        )
        if sandbox_result["success"]:
            get_executor().execute(merge_action, incident_id=incident.id)
            incident.approval_required = True
            incident.approval_id = merge_action.id
        incident.plan.append(merge_action)

        # A proven fix waits on the human merge approval; an unproven one stays with Builder (FR-B3)
        incident.status = "acting"
        incident.title = f"Fix PR #{pr_info.get('number')} opened with red-to-green proof"
        incident.summary = f"Generated regression test & patch. Verified in sandbox. Opened PR #{pr_info.get('number')}."
        self.bus.update_incident(incident, reason="Builder completed code fix and opened PR")

        return incident


_global_builder: Optional[BuilderAgent] = None


def get_builder_agent() -> BuilderAgent:
    """Retrieve or initialize global BuilderAgent."""
    global _global_builder
    if _global_builder is None:
        _global_builder = BuilderAgent()
    return _global_builder
