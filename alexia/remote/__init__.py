"""Remote companion backend: authentication, WebAuthn/TOTP step-up, devices, Web Push, and controls."""

from alexia.remote.auth import AuthManager, get_auth_manager
from alexia.remote.devices import DeviceManager, get_device_manager
from alexia.remote.push import PushManager, get_push_manager, send_push_notification
from alexia.remote.controls import RemoteController, get_remote_controller

__all__ = [
    "AuthManager",
    "get_auth_manager",
    "DeviceManager",
    "get_device_manager",
    "PushManager",
    "get_push_manager",
    "send_push_notification",
    "RemoteController",
    "get_remote_controller",
]
