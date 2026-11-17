"""Shared agent contract and metadata for the five Guardian agents.

Agents communicate through a small, typed surface rather than importing each
other's internals ad hoc:

- Every agent exposes an immutable identity (`agent_id`, `role`).
- Every agent declares `capabilities`: behavior labels describing what it owns.
- Every agent declares `entrypoints`: the public callables other components may
  invoke. Only entrypoints form the callable surface of an agent.
- All payloads are Pydantic models from `alexia.core.schemas` (`Incident`,
  `Action`, `Event`, `Diagnosis`) or JSON-safe dictionaries.
- Every side effect must go through `alexia.actions.executor.ActionExecutor`.

`alexia.agents.contracts` uses this metadata to validate the whole team at
startup and in tests, so a missing handler fails fast instead of at 3am.
"""

from __future__ import annotations

from typing import Any, Dict, Tuple


class GuardianAgent:
    """Base metadata contract implemented by all five specialized agents."""

    agent_id: str = ""
    role: str = ""
    # Behavior vocabulary (what the agent does), not method names.
    capabilities: Tuple[str, ...] = ()
    # Public callables (how other components use the agent).
    entrypoints: Tuple[str, ...] = ()

    def describe(self) -> Dict[str, Any]:
        """Machine-readable description used by the registry and `/api/v1/agents`."""
        return {
            "id": self.agent_id,
            "role": self.role,
            "capabilities": list(self.capabilities),
            "entrypoints": list(self.entrypoints),
        }
