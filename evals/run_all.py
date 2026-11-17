"""Evaluation harness running demo scenarios 3x to ensure 100% reliability.

Implements PRD Section 10:
- Executes every PRD scenario (S1-S9) three times through the real agent pipeline.
- Evaluates against PRD acceptance criteria:
  - Detection latency < 30s
  - Red-to-green proof verified (failed before, passed after)
  - IP contained
  - Hash chain verified
- Outputs formatted markdown summary table suitable for hackathon evidence.
"""

from __future__ import annotations
import asyncio
import json
import logging
import os
import sys
import time
from typing import Any, Dict, List, Optional

# Ensure repository root is on sys.path and UTF-8 output on Windows
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
# Evaluate in a scratch data dir so runs never touch (or leave paused) the live data/alexia.db
if not os.environ.get("ALEXIA_DATA_DIR"):
    import tempfile

    os.environ["ALEXIA_DATA_DIR"] = tempfile.mkdtemp(prefix="alexia_eval_data_")

from alexia.actions.approvals import get_approval_manager
from alexia.actions.executor import get_executor

from alexia.api.demo import reset_demo_environment, run_scenario
from alexia.core.audit import get_audit_log
from alexia.core.bus import get_event_bus
from alexia.core.memory import get_runbook_memory
from alexia.core.orchestrator import get_orchestrator
from alexia.core.schemas import Incident

logging.basicConfig(level=logging.WARNING)


def _executed(inc: Incident, action: str) -> bool:
    return any(a.action == action and a.status == "executed" for a in inc.plan)


def _pending_approval(action_id: Optional[str], action: str) -> bool:
    return any(a["id"] == action_id and a["action_name"] == action for a in get_approval_manager().list_pending())


async def evaluate_scenario(scenario_id: str, run_index: int) -> Dict[str, Any]:
    """Execute a single scenario run and evaluate the PRD Section 10 acceptance criteria."""
    bus = get_event_bus()
    audit = get_audit_log()
    executor = get_executor()

    reset_demo_environment()

    start_time = time.time()
    trigger_res = await run_scenario(scenario_id)
    detect_s = round(time.time() - start_time, 2)
    await asyncio.wait_for(bus.drain(), timeout=120)  # every agent loop for this scenario has finished
    duration = round(time.time() - start_time, 2)
    is_valid_chain, rows, _ = audit.verify_chain()

    inc = bus.get_incident(trigger_res["incident_id"]) if trigger_res.get("incident_id") else None
    checks: Dict[str, bool] = {"incident opened": inc is not None or scenario_id == "s8"}

    if scenario_id == "s1" and inc:
        proof = inc.metadata.get("proof_of_fix") or {}
        checks.update({
            "rollback executed": _executed(inc, "rollback_to_last_good_image"),
            "rollback < 60s": duration < 60,
            "test fails before patch": proof.get("failed_before") is True,
            "test passes after patch": proof.get("passed_after") is True,
            "fix PR opened": _executed(inc, "open_pull_request"),
            "merge queued for approval": _pending_approval(inc.approval_id, "merge_pull_request_and_deploy"),
        })
    elif scenario_id == "s2" and inc:
        checks.update({
            "detected < 15s": detect_s < 15,
            "restart executed": _executed(inc, "restart_container"),
            "resolved < 60s": inc.status == "resolved" and duration < 60,
            "runbook entry stored": get_runbook_memory().find_matching_runbook(
                category=inc.category, service="shoplite-api", error_indicator=str(inc.metadata.get("error", ""))[:60]
            ) is not None,
        })
    elif scenario_id == "s3" and inc:
        checks.update({
            "logs rotated": _executed(inc, "clear_tmp_and_rotate_logs"),
            "resolved": inc.status == "resolved",
        })
    elif scenario_id == "s4" and inc:
        checks.update({
            "deploy blocked": inc.title.startswith("Deployment Blocked"),
            "rotation queued (Tier 1)": _pending_approval(inc.approval_id, "rotate_secret"),
            "secret never stored raw": "sk_live_51Mz" not in inc.model_dump_json(),
        })
    elif scenario_id == "s5" and inc:
        checks.update({
            "IP blocked < 30s": executor.is_ip_blocked("203.0.113.195") and detect_s < 30,
            "timeline recorded": bool(inc.diagnosis.evidence),
            "incident contained": inc.status == "resolved",
        })
    elif scenario_id == "s6" and inc:
        proof = inc.metadata.get("proof_of_fix") or {}
        exposure = inc.metadata.get("exposure_assessment") or {}
        reports = inc.metadata.get("reports") or {}
        checks.update({
            "detected < 30s": detect_s < 30,
            "evidence preserved": bool(inc.metadata.get("evidence_hash")),
            "IP blocked": executor.is_ip_blocked("198.51.100.88"),
            "exposure assessed": bool(exposure.get("affected_tables")) and "estimated_rows_exposed" in exposure,
            "red->green proof": proof.get("failed_before") is True and proof.get("passed_after") is True,
            "merge queued for approval": _pending_approval(inc.approval_id, "merge_pull_request_and_deploy"),
            "CERT-In/DPDP/GDPR drafts": {"cert_in", "dpdp", "gdpr"} <= set(reports),
        })
    elif scenario_id == "s7" and inc:
        checks.update({
            "deploy blocked": inc.title.startswith("Deployment Blocked"),
            "rows at risk reported": "estimated_records_at_risk" in (inc.metadata.get("migration") or {}),
            "migration queued (Tier 1)": _pending_approval(inc.approval_id, "run_migration"),
        })
    elif scenario_id == "s8":
        checks.update({
            "merge approval pending for phone": _pending_approval(trigger_res.get("action_id"), "merge_pull_request_and_deploy"),
        })
    elif scenario_id == "s9" and inc:
        checks.update({
            "autonomy paused": executor.is_autonomy_paused(),
            "restart queued, not executed": not _executed(inc, "restart_container") and inc.approval_required,
            "incident not auto-resolved": inc.status != "resolved",
        })

    failed = [name for name, ok in checks.items() if not ok]
    return {
        "scenario": scenario_id.upper(),
        "run": run_index + 1,
        "passed": not failed and is_valid_chain,
        "duration_s": duration,
        "audit_chain_valid": is_valid_chain,
        "details": f"{len(checks) - len(failed)}/{len(checks)} criteria" + (f"; FAILED: {', '.join(failed)}" if failed else ""),
    }


async def main():
    print("=" * 70)
    print("Alexia Autonomous DevSecOps Guardian — Scenario Evaluation Suite")
    print("Executing 3 consecutive runs per scenario to ensure 100% determinism")
    print("=" * 70)

    # Initialize bus and orchestrator
    bus = get_event_bus()
    await bus.start()
    orchestrator = get_orchestrator()
    orchestrator.start()

    scenarios = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]
    results: Dict[str, List[Dict[str, Any]]] = {s: [] for s in scenarios}

    for s in scenarios:
        print(f"\nEvaluating Scenario {s.upper()}...")
        for run_idx in range(3):
            res = await evaluate_scenario(s, run_idx)
            results[s].append(res)
            status_symbol = "✓ PASS" if res["passed"] else "✗ FAIL"
            print(f"  Run {run_idx + 1}/3: {status_symbol} ({res['duration_s']}s) - {res['details']}")

    await bus.stop()

    # Print Markdown Summary Table
    print("\n" + "=" * 70)
    print("### Acceptance Criteria Verification Table")
    print("| Scenario | Description | Run 1 | Run 2 | Run 3 | Audit Chain | Result |")
    print("|---|---|---|---|---|---|---|")

    scenario_names = {
        "s1": "Bad Deploy & Rollback",
        "s2": "Crash Self-Healing",
        "s3": "Disk Full & Log Rotation",
        "s4": "Leaked Secret Gating",
        "s5": "Brute-Force Containment",
        "s6": "SQLi & Data Exposure (Headline)",
        "s7": "Destructive Migration Guard",
        "s8": "Remote Mobile Approval",
        "s9": "Autonomy Kill Switch",
    }

    all_scenarios_passed = True

    for s, runs in results.items():
        all_passed = all(r["passed"] for r in runs)
        if not all_passed:
            all_scenarios_passed = False
        r1 = "✓" if runs[0]["passed"] else "✗"
        r2 = "✓" if runs[1]["passed"] else "✗"
        r3 = "✓" if runs[2]["passed"] else "✗"
        chain = "100% ✓" if all(r["audit_chain_valid"] for r in runs) else "FAIL"
        overall = "**PASS**" if all_passed else "**FAIL**"
        print(f"| **{s.upper()}** | {scenario_names.get(s, s)} | {r1} | {r2} | {r3} | {chain} | {overall} |")

    n_passed = sum(all(r["passed"] for r in runs) for runs in results.values())
    verdict = "ALL PASSED" if all_scenarios_passed else "SOME FAILED"
    print(f"\nOverall Suite Result: {verdict} ({n_passed}/{len(results)})")
    return 0 if all_scenarios_passed else 1


if __name__ == "__main__":
    code = asyncio.run(main())
    sys.exit(code)
