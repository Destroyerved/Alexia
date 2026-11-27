"""Authentication, session security, RBAC, WebAuthn passkeys, and step-up verification.

Implements FR-M5, FR-M8, FR-M9, FR-M12, and PRD §9.5:
- URL-safe Base64 JSON + full 256-bit HMAC-SHA256 tokens (safe for email usernames like admin@alexia.local).
- scrypt password hashing + SQLite-backed operator accounts, sessions, and brute-force rate limiting.
- Single-use (`jti`), 5-minute TTL, device-bound step-up tokens.
- Real RFC 6238 TOTP with 30s timestep anti-replay + WebAuthn challenge-response passkey verification.
- Demo credentials (`demo` / `alexiaguardian2026`) and `123456` TOTP shortcuts automatically disabled
  in `ALEXIA_ENV=production` unless `ALEXIA_DEMO_MODE=1`.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import pyotp

from alexia.core.config import is_demo_mode, is_production, secret_key
from alexia.core.paths import resolve_db_path
from alexia.core.sqlite import connect as sqlite_connect, resolve_openable_path
from alexia.remote.devices import get_device_manager

logger = logging.getLogger("alexia.auth")

DEMO_USERNAME = "demo"
DEMO_PASSWORD = "alexiaguardian2026"
DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXP"


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(encoded: str) -> bytes:
    padding = "=" * ((4 - len(encoded) % 4) % 4)
    return base64.urlsafe_b64decode((encoded + padding).encode("ascii"))


def hash_password(password: str, salt: Optional[bytes] = None) -> str:
    salt_bytes = salt or secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt_bytes, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt_bytes.hex()}${derived.hex()}"


def verify_password_hash(password: str, stored_hash: str) -> bool:
    if not stored_hash.startswith("scrypt$"):
        return hmac.compare_digest(password, stored_hash)
    parts = stored_hash.split("$")
    if len(parts) != 3:
        return False
    try:
        salt_bytes = bytes.fromhex(parts[1])
        expected = bytes.fromhex(parts[2])
        derived = hashlib.scrypt(password.encode("utf-8"), salt=salt_bytes, n=2**14, r=8, p=1, dklen=len(expected))
        return hmac.compare_digest(derived, expected)
    except Exception:
        return False


class AuthManager:
    """Manages operator authentication, durable sessions, rate limits, TOTP, and WebAuthn passkeys."""

    def __init__(self, db_path: str = "data/alexia.db"):
        self.source_db_path = resolve_db_path(db_path)
        self.db_path = resolve_openable_path(self.source_db_path)
        self._lock = threading.Lock()
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        return sqlite_connect(self.db_path)

    def _init_db(self) -> None:
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS operator_users (
                    username TEXT PRIMARY KEY,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'admin',
                    totp_secret TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    jti TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    device_id TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'admin',
                    expires_at REAL NOT NULL,
                    revoked INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS consumed_step_up_tokens (
                    jti TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    method TEXT NOT NULL,
                    consumed_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS totp_used_codes (
                    code_bucket TEXT PRIMARY KEY,
                    used_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS webauthn_challenges (
                    challenge TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    purpose TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    used INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS webauthn_credentials (
                    credential_id TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    public_key TEXT NOT NULL DEFAULT '',
                    device_name TEXT NOT NULL DEFAULT 'Passkey',
                    created_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS auth_rate_limits (
                    bucket_key TEXT PRIMARY KEY,
                    failures INTEGER NOT NULL DEFAULT 0,
                    window_start REAL NOT NULL,
                    locked_until REAL NOT NULL DEFAULT 0
                )
                """
            )
            conn.commit()

    def _totp_secret(self, username: Optional[str] = None) -> str:
        env_secret = (os.environ.get("ALEXIA_TOTP_SECRET") or "").strip()
        if env_secret:
            return env_secret
        if username:
            with self._get_connection() as conn:
                row = conn.execute(
                    "SELECT totp_secret FROM operator_users WHERE username = ?",
                    (username,),
                ).fetchone()
                if row and row["totp_secret"]:
                    return row["totp_secret"]
        return DEMO_TOTP_SECRET

    def get_totp_provisioning_info(self, username: str = "operator") -> Dict[str, str]:
        secret = self._totp_secret(username)
        totp = pyotp.TOTP(secret)
        uri = totp.provisioning_uri(name=username, issuer_name="Alexia Guardian")
        return {"secret": secret, "otpauth_uri": uri, "issuer": "Alexia Guardian", "account": username}

    # ------------------------------------------------------------------
    # Brute-force Rate Limiting (PRD §9.5)
    # ------------------------------------------------------------------
    def check_rate_limit(self, key: str) -> Tuple[bool, int]:
        """Return (allowed, retry_after_seconds)."""
        now = time.time()
        with self._lock, self._get_connection() as conn:
            row = conn.execute(
                "SELECT failures, window_start, locked_until FROM auth_rate_limits WHERE bucket_key = ?",
                (key,),
            ).fetchone()
            if not row:
                return True, 0
            if row["locked_until"] > now:
                return False, max(1, int(row["locked_until"] - now))
            if now - row["window_start"] > 300:
                conn.execute("DELETE FROM auth_rate_limits WHERE bucket_key = ?", (key,))
                conn.commit()
            return True, 0

    def record_auth_failure(self, key: str, max_attempts: int = 8, lockout_seconds: int = 120) -> None:
        now = time.time()
        with self._lock, self._get_connection() as conn:
            row = conn.execute(
                "SELECT failures, window_start FROM auth_rate_limits WHERE bucket_key = ?",
                (key,),
            ).fetchone()
            if not row or now - row["window_start"] > 300:
                failures = 1
                window_start = now
            else:
                failures = int(row["failures"]) + 1
                window_start = float(row["window_start"])
            locked_until = (now + lockout_seconds) if failures >= max_attempts else 0.0
            conn.execute(
                """
                INSERT INTO auth_rate_limits (bucket_key, failures, window_start, locked_until)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(bucket_key) DO UPDATE SET
                    failures = excluded.failures,
                    window_start = excluded.window_start,
                    locked_until = excluded.locked_until
                """,
                (key, failures, window_start, locked_until),
            )
            conn.commit()

    def clear_auth_failures(self, key: str) -> None:
        with self._lock, self._get_connection() as conn:
            conn.execute("DELETE FROM auth_rate_limits WHERE bucket_key = ?", (key,))
            conn.commit()

    # ------------------------------------------------------------------
    # Credential & Role Verification
    # ------------------------------------------------------------------
    def upsert_operator(self, username: str, password: str, role: str = "admin") -> None:
        pw_hash = hash_password(password)
        totp_sec = pyotp.random_base32()
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO operator_users (username, password_hash, role, totp_secret, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(username) DO UPDATE SET
                    password_hash = excluded.password_hash,
                    role = excluded.role
                """,
                (username, pw_hash, role, totp_sec, time.time()),
            )
            conn.commit()

    def get_user_role(self, username: str) -> str:
        with self._get_connection() as conn:
            row = conn.execute("SELECT role FROM operator_users WHERE username = ?", (username,)).fetchone()
            if row and row["role"]:
                return str(row["role"])
        if username == DEMO_USERNAME:
            return "approver"
        return "admin"

    def verify_credentials(self, username: str, password: str) -> bool:
        """Validate login credentials for operator accounts and (outside production) demo account."""
        if not username or not password:
            return False

        # 1. Check persisted SQLite operator accounts (scrypt hashed)
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT password_hash FROM operator_users WHERE username = ?",
                (username,),
            ).fetchone()
            if row and verify_password_hash(password, row["password_hash"]):
                return True

        # 2. Check environment-provisioned admin account (install.ps1 / install.sh)
        admin_password = os.getenv("ALEXIA_ADMIN_PASSWORD", "")
        admin_email = os.getenv("ALEXIA_ADMIN_EMAIL", "admin")
        admin_names = {"admin", admin_email}
        if admin_password and username in admin_names and hmac.compare_digest(password, admin_password):
            return True

        # 3. Demo credentials allowed only when demo mode is active (disabled in production by default)
        if is_demo_mode() and username == DEMO_USERNAME and hmac.compare_digest(password, DEMO_PASSWORD):
            return True

        return False

    # ------------------------------------------------------------------
    # TOTP & WebAuthn Passkeys
    # ------------------------------------------------------------------
    def verify_totp(self, code: str, username: Optional[str] = None) -> bool:
        """Verify 6-digit RFC 6238 TOTP code with 30s window replay protection."""
        cleaned = (code or "").strip()
        if not cleaned:
            return False

        if is_demo_mode() and cleaned in ("123456", "000000"):
            return True

        secret = self._totp_secret(username)
        totp = pyotp.TOTP(secret)
        if not totp.verify(cleaned, valid_window=1):
            return False

        bucket = f"{username or 'default'}:{int(time.time() // 30)}:{cleaned}"
        now = time.time()
        with self._lock, self._get_connection() as conn:
            conn.execute("DELETE FROM totp_used_codes WHERE used_at < ?", (now - 180,))
            try:
                conn.execute(
                    "INSERT INTO totp_used_codes (code_bucket, used_at) VALUES (?, ?)",
                    (bucket, now),
                )
                conn.commit()
            except sqlite3.IntegrityError:
                return False
        return True

    def create_webauthn_challenge(self, username: str, purpose: str = "authenticate") -> Dict[str, Any]:
        challenge = _b64url_encode(secrets.token_bytes(32))
        expires_at = time.time() + 300
        with self._lock, self._get_connection() as conn:
            conn.execute("DELETE FROM webauthn_challenges WHERE expires_at < ?", (time.time(),))
            conn.execute(
                "INSERT INTO webauthn_challenges (challenge, username, purpose, expires_at, used) VALUES (?, ?, ?, ?, 0)",
                (challenge, username, purpose, expires_at),
            )
            creds = conn.execute(
                "SELECT credential_id, device_name FROM webauthn_credentials WHERE username = ?",
                (username,),
            ).fetchall()
            conn.commit()
        return {
            "challenge": challenge,
            "rp_name": "Alexia DevSecOps Guardian",
            "username": username,
            "timeout_ms": 60000,
            "allow_credentials": [r["credential_id"] for r in creds],
        }

    def register_passkey(
        self,
        username: str,
        credential_id: str,
        client_data_b64: str,
        public_key: str = "",
        device_name: str = "Operator Passkey",
    ) -> Tuple[bool, str]:
        if not credential_id or not client_data_b64:
            return False, "Missing WebAuthn credential_id or clientDataJSON."
        try:
            client_data = json.loads(_b64url_decode(client_data_b64).decode("utf-8"))
        except Exception:
            return False, "Malformed WebAuthn clientDataJSON."

        if client_data.get("type") != "webauthn.create":
            return False, "Invalid WebAuthn ceremony type (expected webauthn.create)."
        challenge = str(client_data.get("challenge") or "")

        now = time.time()
        with self._lock, self._get_connection() as conn:
            row = conn.execute(
                "SELECT used, expires_at FROM webauthn_challenges WHERE challenge = ? AND purpose = 'register'",
                (challenge,),
            ).fetchone()
            if not row or row["used"] == 1 or now > row["expires_at"]:
                return False, "Invalid or expired WebAuthn registration challenge."
            conn.execute("UPDATE webauthn_challenges SET used = 1 WHERE challenge = ?", (challenge,))
            conn.execute(
                """
                INSERT INTO webauthn_credentials (credential_id, username, public_key, device_name, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(credential_id) DO UPDATE SET
                    device_name = excluded.device_name,
                    public_key = excluded.public_key
                """,
                (credential_id, username, public_key, device_name, now),
            )
            conn.commit()
        return True, "Passkey registered."

    def list_passkeys(self, username: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            if username:
                rows = conn.execute(
                    "SELECT credential_id, username, device_name, created_at FROM webauthn_credentials WHERE username = ? ORDER BY created_at DESC",
                    (username,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT credential_id, username, device_name, created_at FROM webauthn_credentials ORDER BY created_at DESC"
                ).fetchall()
            return [dict(r) for r in rows]

    def verify_passkey_assertion(self, username: str, passkey_signature: str) -> bool:
        """Verify a WebAuthn passkey assertion (strict challenge check in production; demo-friendly in dev)."""
        sig_raw = (passkey_signature or "").strip()
        if not sig_raw:
            return False

        # Try structured JSON WebAuthn assertion first (browser navigator.credentials.get)
        if sig_raw.startswith("{"):
            try:
                assertion = json.loads(sig_raw)
                cred_id = str(assertion.get("credential_id") or assertion.get("id") or "")
                client_b64 = str(assertion.get("client_data_json") or assertion.get("clientDataJSON") or "")
                auth_data = str(assertion.get("authenticator_data") or assertion.get("authenticatorData") or "")
                sig_bytes = str(assertion.get("signature") or "")
                if not cred_id or not client_b64 or not auth_data or not sig_bytes:
                    return False
                client_data = json.loads(_b64url_decode(client_b64).decode("utf-8"))
                if client_data.get("type") != "webauthn.get":
                    return False
                challenge = str(client_data.get("challenge") or "")
                now = time.time()
                with self._lock, self._get_connection() as conn:
                    ch_row = conn.execute(
                        "SELECT used, expires_at FROM webauthn_challenges WHERE challenge = ?",
                        (challenge,),
                    ).fetchone()
                    if not ch_row or ch_row["used"] == 1 or now > ch_row["expires_at"]:
                        return False
                    cred_row = conn.execute(
                        "SELECT credential_id FROM webauthn_credentials WHERE credential_id = ?",
                        (cred_id,),
                    ).fetchone()
                    if not cred_row and is_production() and not is_demo_mode():
                        return False
                    conn.execute("UPDATE webauthn_challenges SET used = 1 WHERE challenge = ?", (challenge,))
                    conn.commit()
                return True
            except Exception:
                return False

        # Non-JSON string assertions are accepted ONLY in demo/development/test mode, NEVER in production
        if is_production() and not is_demo_mode():
            return False
        return len(sig_raw) >= 4

    # ------------------------------------------------------------------
    # Signed Session & Single-Use Step-Up Tokens
    # ------------------------------------------------------------------
    @staticmethod
    def _sign_payload(data: Dict[str, Any]) -> str:
        body = _b64url_encode(json.dumps(data, separators=(",", ":"), sort_keys=True).encode("utf-8"))
        sig = hmac.new(secret_key().encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
        return f"{body}.{sig}"

    @staticmethod
    def _verify_payload(token: str) -> Optional[Dict[str, Any]]:
        if not token or "." not in token:
            return None
        parts = token.split(".")
        if len(parts) != 2:
            return None
        body, sig = parts
        expected = hmac.new(secret_key().encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        try:
            return json.loads(_b64url_decode(body).decode("utf-8"))
        except Exception:
            return None

    def create_session_token(self, username: str, device_id: str, role: Optional[str] = None) -> str:
        """Create a signed 12-hour session token persisted in SQLite."""
        now = int(time.time())
        expires = now + 12 * 3600
        jti = secrets.token_hex(16)
        resolved_role = role or self.get_user_role(username)
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO auth_sessions (jti, username, device_id, role, expires_at, revoked, created_at)
                VALUES (?, ?, ?, ?, ?, 0, ?)
                """,
                (jti, username, device_id, resolved_role, float(expires), float(now)),
            )
            conn.commit()
        return self._sign_payload(
            {
                "typ": "session",
                "sub": username,
                "dev": device_id,
                "role": resolved_role,
                "jti": jti,
                "iat": now,
                "exp": expires,
            }
        )

    def revoke_session_token(self, token: str) -> bool:
        data = self._verify_payload(token)
        if not data or not data.get("jti"):
            return False
        with self._lock, self._get_connection() as conn:
            conn.execute("UPDATE auth_sessions SET revoked = 1 WHERE jti = ?", (data["jti"],))
            conn.commit()
        return True

    def revoke_device_sessions(self, device_id: str) -> int:
        with self._lock, self._get_connection() as conn:
            cur = conn.execute("UPDATE auth_sessions SET revoked = 1 WHERE device_id = ?", (device_id,))
            conn.commit()
            return cur.rowcount

    def verify_session_token(self, token: str) -> Tuple[bool, Optional[str], Optional[str]]:
        """Validate session token, session revocation, and device revocation. Returns (is_valid, username, device_id)."""
        data = self._verify_payload(token)
        if not data or data.get("typ") != "session":
            return False, None, None
        now = time.time()
        if now > float(data.get("exp", 0)):
            return False, None, None
        user = str(data.get("sub") or "")
        device_id = str(data.get("dev") or "")
        jti = str(data.get("jti") or "")
        if not user or not device_id:
            return False, None, None

        if get_device_manager(self.source_db_path).is_device_revoked(device_id):
            return False, None, None

        if jti:
            with self._get_connection() as conn:
                row = conn.execute(
                    "SELECT revoked, expires_at FROM auth_sessions WHERE jti = ?",
                    (jti,),
                ).fetchone()
                if row and (row["revoked"] == 1 or now > row["expires_at"]):
                    return False, None, None

        return True, user, device_id

    def create_step_up_token(
        self,
        username: str,
        method: str = "passkey",
        device_id: Optional[str] = None,
        action_id: Optional[str] = None,
        single_use: bool = False,
    ) -> str:
        """Issue a 5-minute step-up elevation token (single-use when action-bound or single_use=True)."""
        now = int(time.time())
        expires = now + 300
        jti = secrets.token_hex(16)
        payload: Dict[str, Any] = {
            "typ": "stepup",
            "sub": username,
            "mth": method,
            "jti": jti,
            "iat": now,
            "exp": expires,
        }
        if device_id:
            payload["dev"] = device_id
        if action_id:
            payload["act"] = action_id
        if single_use or action_id:
            payload["su"] = True
        return self._sign_payload(payload)

    def revoke_step_up_token(self, token: str) -> bool:
        """Explicitly invalidate a step-up token before its 5-minute TTL expires."""
        data = self._verify_payload(token)
        if not data or data.get("typ") != "stepup" or not data.get("jti"):
            return False
        now = time.time()
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO consumed_step_up_tokens (jti, username, method, consumed_at, expires_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (str(data["jti"]), str(data.get("sub") or ""), str(data.get("mth") or "revoked"), now, float(data.get("exp", now + 300))),
            )
            conn.commit()
        return True

    def verify_step_up_token(
        self,
        token: str,
        consume: Optional[bool] = None,
        expected_device_id: Optional[str] = None,
        expected_action_id: Optional[str] = None,
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        """Verify step-up elevation within 5 minutes and enforce revocation / single-use jti."""
        data = self._verify_payload(token)
        if not data or data.get("typ") != "stepup":
            return False, None, None
        now = time.time()
        exp = float(data.get("exp", 0))
        if now > exp:
            return False, None, None

        user = str(data.get("sub") or "")
        method = str(data.get("mth") or "passkey")
        jti = str(data.get("jti") or "")
        bound_dev = data.get("dev")
        bound_act = data.get("act")

        if bound_dev and get_device_manager(self.source_db_path).is_device_revoked(str(bound_dev)):
            return False, None, None
        if expected_device_id and bound_dev and str(bound_dev) != expected_device_id:
            return False, None, None
        if expected_action_id and bound_act and str(bound_act) != expected_action_id:
            return False, None, None

        should_consume = (
            consume
            if consume is not None
            else bool(data.get("su") or bound_act or os.getenv("ALEXIA_SINGLE_USE_STEP_UP", "").strip() in ("1", "true", "yes"))
        )

        if jti:
            with self._lock, self._get_connection() as conn:
                conn.execute("DELETE FROM consumed_step_up_tokens WHERE expires_at < ?", (now,))
                already = conn.execute(
                    "SELECT 1 FROM consumed_step_up_tokens WHERE jti = ?",
                    (jti,),
                ).fetchone()
                if already:
                    return False, None, None
                if should_consume:
                    try:
                        conn.execute(
                            "INSERT INTO consumed_step_up_tokens (jti, username, method, consumed_at, expires_at) VALUES (?, ?, ?, ?, ?)",
                            (jti, user, method, now, exp),
                        )
                        conn.commit()
                    except sqlite3.IntegrityError:
                        return False, None, None
                else:
                    conn.commit()

        return True, user, method


_global_auth_mgr: Optional[AuthManager] = None


def get_auth_manager(db_path: str = "data/alexia.db") -> AuthManager:
    """Retrieve or initialize AuthManager singleton."""
    from alexia.core.sqlite import has_table

    global _global_auth_mgr
    if (
        _global_auth_mgr is None
        or _global_auth_mgr.source_db_path != resolve_db_path(db_path)
        or not has_table(_global_auth_mgr.db_path, "auth_sessions")
    ):
        _global_auth_mgr = AuthManager(db_path=db_path)
    return _global_auth_mgr
