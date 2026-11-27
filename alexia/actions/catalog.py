"""Action catalog defining allowed operations and their safety tiers.

Implements PRD Section 9.1:
- Tier 0 (Auto): safe, automated actions executed immediately.
- Tier 1 (Approval): high-impact operations requiring explicit human approval.
- Tier 2 (Forbidden): destructive or unauthorized operations rejected in code.
"""

from __future__ import annotations

import ipaddress
import os
from typing import Any, Dict, Optional, Set, Tuple

from alexia.core.schemas import ActionTier

TIER_0_ACTIONS: Set[str] = {
    "restart_container",
    "rollback_to_last_good_image",
    "clear_tmp_and_rotate_logs",
    "block_ip_temporarily",
    "unblock_ip",
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
    if action_name in TIER_1_ACTIONS:
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
        raw_ip = str(params.get("ip") or "").strip()
        if not raw_ip:
            return False, "Parameter 'ip' is required for block_ip_temporarily."
        try:
            parsed = ipaddress.ip_address(raw_ip)
        except ValueError:
            return False, f"Invalid IP address '{raw_ip}'."
        if parsed.is_loopback or parsed.is_unspecified or parsed.is_multicast:
            return False, f"Refusing to block loopback/unspecified/multicast IP '{raw_ip}'."
        try:
            duration = int(params.get("duration_minutes", 60))
        except (TypeError, ValueError):
            return False, "Parameter 'duration_minutes' must be an integer."
        if duration <= 0 or duration > 60:
            return False, "Tier-0 temporary IP block must be between 1 and 60 minutes (PRD §9.1)."

    elif action_name == "unblock_ip":
        raw_ip = str(params.get("ip") or "").strip()
        if not raw_ip:
            return False, "Parameter 'ip' is required for unblock_ip."
        try:
            ipaddress.ip_address(raw_ip)
        except ValueError:
            return False, f"Invalid IP address '{raw_ip}'."

    elif action_name == "raise_memory_limit":
        limit_mb = params.get("limit_mb")
        if not isinstance(limit_mb, int) or limit_mb <= 0 or limit_mb > 65536:
            return False, "Parameter 'limit_mb' must be a positive integer (1..65536)."

    elif action_name == "restore_snapshot":
        snap_id = params.get("snapshot_id")
        if not snap_id or not str(snap_id).strip():
            return False, "Parameter 'snapshot_id' is required for restore_snapshot."

    elif action_name == "kill_process":
        pid = params.get("pid")
        try:
            pid_int = int(pid)
        except (TypeError, ValueError):
            return False, "Parameter 'pid' must be a positive integer."
        if pid_int <= 1 or pid_int == os.getpid():
            return False, f"Refusing to terminate protected PID {pid_int}."

    return True, None
