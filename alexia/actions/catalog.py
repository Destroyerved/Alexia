"""Action catalog defining allowed operations and their safety tiers.

Implements PRD Section 9.1:
- Tier 0 (Auto): safe, automated actions executed immediately.
- Tier 1 (Approval): high-impact operations requiring explicit human approval.
- Tier 2 (Forbidden): destructive or unauthorized operations rejected in code.
"""

from __future__ import annotations
from typing import Any, Dict, Optional, Set, Tuple

from alexia.core.schemas import ActionTier

TIER_0_ACTIONS: Set[str] = {
    "restart_container",
    "rollback_to_last_good_image",
    "clear_tmp_and_rotate_logs",
    "block_ip_temporarily",
    "take_snapshot",
    "run_integrity_check",
    "open_pull_request",
}

TIER_1_ACTIONS: Set[str] = {
    "restore_snapshot",
    "rotate_secret",
    "isolate_container_network",
    "apply_config_change",
    "raise_memory_limit",
    "run_migration",
    "merge_pull_request_and_deploy",
    "kill_process",
}

DATA_TOUCHING_ACTIONS: Set[str] = {
    "restore_snapshot",
    "run_migration",
    "clear_tmp_and_rotate_logs",
    "rollback_to_last_good_image",
}


def get_action_tier(action_name: str) -> ActionTier:
    """Determine the tier of a requested action.

    Returns:
        0: Auto-executable
        1: Approval-required
        2: Strictly forbidden (anything not in Tier 0 or 1)
    """
    if action_name in TIER_0_ACTIONS:
        return 0
    elif action_name in TIER_1_ACTIONS:
        return 1
    return 2


def touches_data(action_name: str) -> bool:
    """Check if action has potential to touch or mutate database/volume data."""
    return action_name in DATA_TOUCHING_ACTIONS


def validate_action_params(action_name: str, params: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """Validate parameters according to action specifications."""
    tier = get_action_tier(action_name)
    if tier == 2:
        return False, f"Action '{action_name}' is forbidden (Tier 2 policy violation)."

    if action_name == "block_ip_temporarily":
        ip = params.get("ip")
        if not ip:
            return False, "Parameter 'ip' is required for block_ip_temporarily."
        duration = params.get("duration_minutes", 60)
        if duration > 1440:
            return False, "Temporary IP block cannot exceed 24 hours (1440 minutes)."

    elif action_name == "raise_memory_limit":
        limit_mb = params.get("limit_mb")
        if not limit_mb or limit_mb <= 0:
            return False, "Parameter 'limit_mb' must be a positive integer."

    elif action_name == "restore_snapshot":
        snap_id = params.get("snapshot_id")
        if not snap_id:
            return False, "Parameter 'snapshot_id' is required for restore_snapshot."

    return True, None
