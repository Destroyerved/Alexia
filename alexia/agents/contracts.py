"""Agent registry and runtime contract validation.

The registry is the single place that knows how to obtain the five agents and
what each one promises.  It deliberately contains no business logic: callers
receive the real agent instance, typed through the shared `GuardianAgent`
contract, and use the declared entrypoints.

`capabilities` are behavior labels describing what an agent owns; they are not
method names.  `entrypoints` are the only callable surface.  The validator below
rejects drift between the registry and each agent's own declarations so the two
cannot silently disagree.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Tuple


@dataclass(frozen=True)
class AgentContract:
    agent_id: str
    role: str
    capabilities: Tuple[str, ...]
    entrypoints: Tuple[str, ...]
    getter: Callable[[], Any]


def _builder():
    from alexia.agents.builder import get_builder_agent

    return get_builder_agent()


def _deployer():
    from alexia.agents.deployer import get_deployer_agent

    return get_deployer_agent()


def _healer():
    from alexia.agents.healer import get_healer_agent

    return get_healer_agent()


def _sentinel():
    from alexia.agents.sentinel import get_sentinel_agent

    return get_sentinel_agent()


def _integrity():
    from alexia.agents.integrity import get_integrity_agent

    return get_integrity_agent()


AGENT_CONTRACTS: Dict[str, AgentContract] = {
    "builder": AgentContract(
        agent_id="builder",
        role="Software engineer: diff review, regression tests, patches, red-to-green proof, PRs",
        capabilities=(
            "diff_review",
            "patch_generation",
            "sandbox_verification",
            "pull_request_authoring",
        ),
        entrypoints=("review_diff", "handle_incident"),
        getter=_builder,
    ),
    "deployer": AgentContract(
        agent_id="deployer",
        role="Release gatekeeper: pre-deploy gates, health gate, automatic rollback",
        capabilities=(
            "predeploy_secret_gate",
            "predeploy_migration_gate",
            "predeploy_review_gate",
            "postdeploy_health_gate",
            "rollback",
        ),
        entrypoints=("deploy_commit",),
        getter=_deployer,
    ),
    "healer": AgentContract(
        agent_id="healer",
        role="Site reliability engineer: triage, diagnosis, catalogued recovery, verification",
        capabilities=(
            "incident_triage",
            "root_cause_diagnosis",
            "remediation_planning",
            "safe_action_execution",
            "recovery_verification",
            "runbook_memory",
        ),
        entrypoints=("handle_incident",),
        getter=_healer,
    ),
    "sentinel": AgentContract(
        agent_id="sentinel",
        role="Security lead: secret/SQLi/brute-force detection, containment, evidence, reports",
        capabilities=(
            "secret_scanning",
            "bruteforce_detection",
            "sqli_detection",
            "evidence_preservation",
            "ip_containment",
            "breach_reporting",
        ),
        entrypoints=("scan_diff_for_secrets", "handle_security_incident"),
        getter=_sentinel,
    ),
    "integrity": AgentContract(
        agent_id="integrity",
        role="Data guardian: snapshots, migration guard, exposure assessment, audit verification",
        capabilities=(
            "snapshot_creation",
            "snapshot_restore",
            "migration_guard",
            "exposure_assessment",
            "integrity_verification",
            "audit_chain_verification",
        ),
        entrypoints=(
            "take_precautionary_snapshot",
            "restore_from_snapshot",
            "guard_migration",
            "assess_exposure",
            "verify_audit_history",
        ),
        getter=_integrity,
    ),
}

AGENT_IDS: Tuple[str, ...] = tuple(AGENT_CONTRACTS)


def get_agent(agent_id: str) -> Any:
    """Return the live singleton for an agent id, raising on typos."""
    contract = AGENT_CONTRACTS.get(agent_id)
    if contract is None:
        raise KeyError(f"Unknown agent {agent_id!r}; expected one of {', '.join(AGENT_IDS)}")
    return contract.getter()


def all_agents() -> Dict[str, Any]:
    """Instantiate and return every registered agent."""
    return {agent_id: contract.getter() for agent_id, contract in AGENT_CONTRACTS.items()}


def _validate_declaration(agent_id: str, label: str, values: Tuple[str, ...]) -> List[str]:
    errors: List[str] = []
    if not values:
        errors.append(f"{agent_id}: no {label} declared")
    if any(not isinstance(value, str) or not value.strip() for value in values):
        errors.append(f"{agent_id}: {label} must be non-empty strings")
    if len(set(values)) != len(values):
        errors.append(f"{agent_id}: duplicate {label} declared")
    return errors


def validate_agent_contracts() -> List[str]:
    """Return a list of contract violations (empty means the team is healthy)."""
    errors: List[str] = []
    for agent_id, contract in AGENT_CONTRACTS.items():
        agent = contract.getter()
        if getattr(agent, "agent_id", None) != agent_id:
            errors.append(f"{agent_id}: instance agent_id is {getattr(agent, 'agent_id', None)!r}")
        if getattr(agent, "role", None) != contract.role:
            errors.append(f"{agent_id}: role metadata differs from registry")

        # Capability labels are descriptive; entrypoints are the callable surface.
        # Both declarations must match between the registry and the live agent.
        errors.extend(_validate_declaration(agent_id, "capabilities", contract.capabilities))
        errors.extend(_validate_declaration(agent_id, "entrypoints", contract.entrypoints))

        if tuple(getattr(agent, "capabilities", ())) != contract.capabilities:
            errors.append(f"{agent_id}: capabilities differ from registry")
        if tuple(getattr(agent, "entrypoints", ())) != contract.entrypoints:
            errors.append(f"{agent_id}: entrypoints differ from registry")

        for entrypoint in contract.entrypoints:
            if not callable(getattr(agent, entrypoint, None)):
                errors.append(f"{agent_id}: missing entrypoint {entrypoint}()")

        if not callable(getattr(agent, "describe", None)):
            errors.append(f"{agent_id}: missing describe()")
            continue
        description = agent.describe()
        if description.get("id") != agent_id:
            errors.append(f"{agent_id}: describe() id differs from registry")
        if description.get("capabilities") != list(contract.capabilities):
            errors.append(f"{agent_id}: describe() capabilities differ from registry")
        if description.get("entrypoints") != list(contract.entrypoints):
            errors.append(f"{agent_id}: describe() entrypoints differ from registry")
    return errors
