"""Centralized runtime environment, security, and simulation policy for Alexia.

Every module must consult these helpers dynamically (rather than reading
``os.environ`` once at import time) so environment overrides in tests,
Docker containers, and OS service units take effect immediately.
"""

from __future__ import annotations

import os
from typing import List, Tuple

PLACEHOLDER_SECRETS = frozenset(
    {
        "",
        "alexia_demo_secret_key_change_in_prod",
        "alexia_default_approval_hmac_secret",
        "change_me_super_secret_master_key_for_hmac_and_tokens",
        "alexia_webhook_secret_demo_123",
        "your_secret_here",
        "changeme",
    }
)


def env_name() -> str:
    """Normalized runtime environment name (development, test, production)."""
    return (os.environ.get("ALEXIA_ENV") or "development").strip().lower()


def is_production() -> bool:
    """True when running in production mode."""
    return env_name() in ("prod", "production")


def is_test() -> bool:
    """True when running under automated tests."""
    return env_name() in ("test", "testing")


def _truthy(value: str | None, default: bool = False) -> bool:
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def is_demo_mode(settings_override: bool | None = None) -> bool:
    """Whether interactive demo accounts/scenarios are enabled.

    Defaults to False in production unless ALEXIA_DEMO_MODE=1 is explicitly set,
    and True in development/test unless ALEXIA_DEMO_MODE=0 is explicitly set.
    """
    raw = os.environ.get("ALEXIA_DEMO_MODE")
    if raw is not None and raw.strip() != "":
        return _truthy(raw)
    if is_production():
        return False
    if settings_override is not None:
        return bool(settings_override)
    return True


def secret_key() -> str:
    """Active HMAC master key for sessions, step-up tokens, approvals, and audit signatures."""
    key = (
        os.environ.get("ALEXIA_SECRET_KEY")
        or os.environ.get("ALEXIA_JWT_SECRET")
        or ""
    ).strip()
    if key:
        return key
    return "alexia_demo_secret_key_change_in_prod"


def has_strong_secret_key() -> bool:
    key = (
        os.environ.get("ALEXIA_SECRET_KEY")
        or os.environ.get("ALEXIA_JWT_SECRET")
        or ""
    ).strip()
    return len(key) >= 16 and key not in PLACEHOLDER_SECRETS


def allow_simulated_health() -> bool:
    """In production, health probes NEVER fake success."""
    if is_production():
        return False
    return _truthy(os.environ.get("ALEXIA_ALLOW_SIMULATED_HEALTH"), default=True)


def allow_simulated_actions() -> bool:
    """Whether infrastructure actions (Docker/GitHub) may fall back to simulation when tools are absent.

    In production, defaults to False unless ALEXIA_ALLOW_SIMULATED_ACTIONS=1 or ALEXIA_DEMO_MODE=1.
    """
    raw = os.environ.get("ALEXIA_ALLOW_SIMULATED_ACTIONS")
    if raw is not None and raw.strip() != "":
        return _truthy(raw)
    if is_production() and not is_demo_mode():
        return False
    return True


def allow_unsigned_webhooks() -> bool:
    """In production, GitHub webhooks MUST carry a valid HMAC-SHA256 signature."""
    if is_production():
        return False
    return _truthy(os.environ.get("ALEXIA_ALLOW_UNSIGNED_WEBHOOKS"), default=True)


def require_api_auth() -> bool:
    """Whether mutating API endpoints strictly require a valid operator session token.

    Enabled automatically in production (unless ALEXIA_REQUIRE_AUTH=0 is explicitly set for an isolated test),
    and opt-in via ALEXIA_REQUIRE_AUTH=1 in development.
    """
    raw = os.environ.get("ALEXIA_REQUIRE_AUTH")
    if raw is not None and raw.strip() != "":
        return _truthy(raw)
    return is_production()


def public_readonly() -> bool:
    """Whether read-only GET endpoints may be accessed without login when require_api_auth() is active."""
    raw = os.environ.get("ALEXIA_PUBLIC_READONLY")
    if raw is not None and raw.strip() != "":
        return _truthy(raw)
    if is_demo_mode():
        return True
    return not is_production()


def enable_api_docs() -> bool:
    """Enable /docs and /redoc in development or when ALEXIA_ENABLE_DOCS=1."""
    raw = os.environ.get("ALEXIA_ENABLE_DOCS")
    if raw is not None and raw.strip() != "":
        return _truthy(raw)
    return not is_production()


def cors_origins() -> List[str]:
    """Allowed CORS origins. Restricted in production unless explicitly configured."""
    raw = (os.environ.get("ALEXIA_CORS_ORIGINS") or "").strip()
    if raw:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]
    if is_production():
        public_url = (os.environ.get("ALEXIA_INTERNET_URL") or "").strip().rstrip("/")
        port = (os.environ.get("PORT") or "8080").strip()
        origins = [
            f"http://localhost:{port}",
            f"http://127.0.0.1:{port}",
        ]
        if public_url:
            origins.append(public_url)
        return origins
    return ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8080", "http://127.0.0.1:8080"]


def scenario_cooldown_seconds() -> int:
    """Cooldown in seconds between public scenario triggers (NFR5: 120s default in production)."""
    raw = os.environ.get("ALEXIA_SCENARIO_COOLDOWN_SECONDS")
    if raw is not None and raw.strip() != "":
        try:
            return max(0, int(raw.strip()))
        except ValueError:
            pass
    return 120 if is_production() else 0


def validate_production_config() -> Tuple[bool, List[str]]:
    """Validate security-critical configuration in production mode."""
    warnings: List[str] = []
    if not is_production():
        return True, warnings

    if not has_strong_secret_key():
        warnings.append(
            "ALEXIA_SECRET_KEY (or ALEXIA_JWT_SECRET) is missing, <16 chars, or set to a known placeholder."
        )
    webhook_secret = (os.environ.get("GITHUB_WEBHOOK_SECRET") or "").strip()
    if not webhook_secret or webhook_secret in PLACEHOLDER_SECRETS:
        warnings.append(
            "GITHUB_WEBHOOK_SECRET is missing or set to a known placeholder."
        )
    strict = _truthy(os.environ.get("ALEXIA_STRICT_STARTUP"), default=False)
    return (len(warnings) == 0 or not strict), warnings
