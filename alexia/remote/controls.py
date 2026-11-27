"""Remote control handlers for mobile companion and dashboard.

Implements FR-M6, FR-M7, FR-M9:
- Kill switch: Pause all autonomy (safe direction, session-verified).
- Resume autonomy (requires single-use step-up authentication).
- Remote trigger for safe catalog actions (restart, rollback, block/unblock IP, snapshot, check).
- Rejects revoked devices immediately and enforces identical catalog tier safety guarantees as internal agents.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Tuple

from alexia.actions.catalog import get_action_tier
from alexia.actions.executor import get_executor
from alexia.core.schemas import Action
from alexia.remote.auth import get_auth_manager
from alexia.remote.devices import get_device_manager

logger = logging.getLogger("alexia.controls")


class RemoteController:
    """Handles safe remote control dispatches from authorized operator devices."""

    def toggle_autonomy(
        self,
        pause: bool,
        user: str,
        device_id: str,
        step_up_token: Optional[str] = None,
    ) -> Tuple[bool, str]:
        """Pause or resume global agent autonomy."""
        if get_device_manager().is_device_revoked(device_id):
            return False, f"Device '{device_id}' has been revoked."

        executor = get_executor()
        auth = get_auth_manager()

        if pause:
            executor.pause_autonomy(paused_by=f"user:{user}@device:{device_id}")
            return True, "Autonomy paused. All actions will queue for manual approval."

        if not step_up_token:
            return False, "Resuming autonomy requires step-up authentication (biometric/TOTP)."
        valid, elevated_user, method = auth.verify_step_up_token(
            step_up_token,
            expected_device_id=device_id,
        )
        if not valid:
            return False, "Invalid, expired, or already-used step-up authentication token."

        actor_user = elevated_user or user
        executor.resume_autonomy(
            resumed_by=f"user:{actor_user}@device:{device_id}",
            step_up_method=method or "biometric",
        )
        return True, "Autonomy resumed. Automated Tier-0 remediation active."

    def trigger_action(
        self,
        action_name: str,
        target: str,
        params: Dict[str, Any],
        user: str,
        device_id: str,
        step_up_token: Optional[str] = None,
    ) -> Tuple[bool, str, Dict[str, Any]]:
        """Trigger an authorized action remotely from a web or mobile device."""
        if get_device_manager().is_device_revoked(device_id):
            return False, f"Device '{device_id}' has been revoked.", {"error": "device_revoked"}

        executor = get_executor()
        auth = get_auth_manager()
        tier = get_action_tier(action_name)

        if tier == 2:
            return False, f"Action '{action_name}' is forbidden.", {"error": "forbidden_tier_2"}

        is_pre_approved = False
        actor_user = user
        if tier == 1:
            if not step_up_token:
                return False, f"Tier-1 action '{action_name}' requires step-up elevation.", {"error": "step_up_required"}
            valid, elevated_user, _ = auth.verify_step_up_token(
                step_up_token,
                expected_device_id=device_id,
            )
            if not valid:
                return False, "Invalid, expired, or already-used step-up elevation.", {"error": "invalid_step_up"}
            actor_user = elevated_user or user
            is_pre_approved = True

        action = Action(
            action=action_name,
            target=target,
            params=params,
            tier=tier,
            reason=f"Triggered remotely by {actor_user}",
            requested_by=f"user:{actor_user}@device:{device_id}",
        )

        success, msg, data = executor.execute(action, is_pre_approved=is_pre_approved)
        return success, msg, data


_global_controller: Optional[RemoteController] = None


def get_remote_controller() -> RemoteController:
    """Retrieve or initialize RemoteController singleton."""
    global _global_controller
    if _global_controller is None:
        _global_controller = RemoteController()
    return _global_controller
