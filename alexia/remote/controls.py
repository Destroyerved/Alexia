"""Remote control handlers for mobile companion and dashboard.

Implements FR-M6, FR-M7:
- Kill switch: Pause all autonomy (safe direction, session-only).
- Resume autonomy (requires step-up authentication).
- Remote trigger for safe catalog actions (restart, rollback, block IP, snapshot, check).
- Enforces identical catalog tier safety guarantees as internal agents.
"""

from __future__ import annotations
import logging
from typing import Any, Dict, Optional, Tuple

from alexia.actions.catalog import get_action_tier
from alexia.actions.executor import get_executor
from alexia.core.schemas import Action
from alexia.remote.auth import get_auth_manager

logger = logging.getLogger("alexia.controls")


class RemoteController:
    """Handles safe remote control dispatches from authorized mobile devices."""

    def __init__(self):
        self.executor = get_executor()
        self.auth = get_auth_manager()

    def toggle_autonomy(
        self,
        pause: bool,
        user: str,
        device_id: str,
        step_up_token: Optional[str] = None,
    ) -> Tuple[bool, str]:
        """Pause or resume global agent autonomy."""
        if pause:
            # Pausing is safe direction -> needs only valid session (FR-M6)
            self.executor.pause_autonomy(paused_by=f"user:{user}@device:{device_id}")
            return True, "Autonomy paused. All actions will queue for manual approval."
        else:
            # Resuming requires step-up authentication (FR-M6)
            if not step_up_token:
                return False, "Resuming autonomy requires step-up authentication (biometric/TOTP)."
            valid, elevated_user, method = self.auth.verify_step_up_token(step_up_token)
            if not valid:
                return False, "Invalid or expired step-up authentication token."

            self.executor.resume_autonomy(
                resumed_by=f"user:{user}@device:{device_id}",
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
        """Trigger an authorized action remotely from a mobile device."""
        tier = get_action_tier(action_name)

        # Tier 2 is impossible
        if tier == 2:
            return False, f"Action '{action_name}' is forbidden.", {"error": "forbidden_tier_2"}

        # Tier 1 requires step-up elevation
        is_pre_approved = False
        if tier == 1:
            if not step_up_token:
                return False, f"Tier-1 action '{action_name}' requires step-up elevation.", {"error": "step_up_required"}
            valid, _, _ = self.auth.verify_step_up_token(step_up_token)
            if not valid:
                return False, "Invalid or expired step-up elevation.", {"error": "invalid_step_up"}
            is_pre_approved = True

        action = Action(
            action=action_name,
            target=target,
            params=params,
            tier=tier,
            reason=f"Triggered remotely from mobile device by {user}",
            requested_by=f"user:{user}@device:{device_id}",
        )

        success, msg, data = self.executor.execute(action, is_pre_approved=is_pre_approved)
        return success, msg, data


_global_controller: Optional[RemoteController] = None


def get_remote_controller() -> RemoteController:
    """Retrieve or initialize RemoteController singleton."""
    global _global_controller
    if _global_controller is None:
        _global_controller = RemoteController()
    return _global_controller
