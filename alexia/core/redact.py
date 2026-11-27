"""Redaction layer for sensitive data protection and prompt-injection containment.

Implements FR-C4 & NFR6: Masks secrets, tokens, credentials, URL query tokens,
PII (emails, international & local phone numbers, 12-digit national IDs), and
payment card numbers with Luhn verification before any prompt, log, forensic file,
search query, or push payload leaves the system boundary.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Union


def _luhn_checksum_valid(card_number_str: str) -> bool:
    """Validate a card number string using the standard Luhn algorithm."""
    digits = [int(c) for c in card_number_str if c.isdigit()]
    if len(digits) < 13 or len(digits) > 19:
        return False
    checksum = 0
    reverse_digits = digits[::-1]
    for i, d in enumerate(reverse_digits):
        if i % 2 == 1:
            doubled = d * 2
            checksum += doubled - 9 if doubled > 9 else doubled
        else:
            checksum += d
    return checksum % 10 == 0


RE_PRIVATE_KEY = re.compile(
    r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----",
    re.MULTILINE,
)
RE_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")

# Well-known API keys & tokens
RE_STRIPE_KEY = re.compile(r"\b(?:sk|pk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b")
RE_OPENAI_KEY = re.compile(r"\bsk-(?:proj-|svcacct-)?[a-zA-Z0-9_-]{20,}\b")
RE_TAVILY_KEY = re.compile(r"\btvly-[a-zA-Z0-9_-]{12,}\b")
RE_GITHUB_TOKEN = re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{30,}\b")
RE_AWS_KEY = re.compile(r"\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b")
RE_SLACK_TOKEN = re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")
RE_GOOGLE_KEY = re.compile(r"\bAIza[0-9A-Za-z\-_]{30,}\b")
RE_BEARER = re.compile(r"(?i)\bbearer\s+[a-zA-Z0-9_\-\.=]{16,}")
RE_BASIC_AUTH = re.compile(r"(?i)\bbasic\s+[a-zA-Z0-9+/=]{16,}")
RE_PASSWORD_URL = re.compile(r"://([^:/@\s]+):([^@\s]+)@")
RE_URL_QUERY_SECRET = re.compile(
    r"(?i)([?&](?:api_key|apikey|token|access_token|secret|password|passwd|client_secret|auth_token)=)([^&\s'\"<>]+)"
)

# Matches key/value assignments including prefixed env vars such as ALEXIA_SECRET_KEY,
# AWS_SECRET_ACCESS_KEY, VAPID_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, DB_PASS, etc.
RE_GENERIC_SECRET_KV = re.compile(
    r"(?i)"
    r"(\b(?:[a-z0-9_]*_(?:secret|secret_key|api_key|apikey|password|passwd|pwd|private_key|signing_key|encryption_key|webhook_secret|access_key|auth_token|client_secret)"
    r"|(?:api_key|apikey|secret|secret_key|password|passwd|pwd|token|access_token|refresh_token|client_secret|private_key|webhook_secret))"
    r"\s*[:=]\s*(['\"]?))"
    r"([a-zA-Z0-9!@#$%^&*()_+=\-`~\[\]{}|;:,./?]{6,})"
    r"(\2)"
)

# PII patterns
RE_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
RE_INTL_PHONE = re.compile(r"(?<!\w)\+\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}\b")
RE_12DIGIT_ID = re.compile(r"(?<!\d)\d{4}[-\s]?\d{4}[-\s]?\d{4}(?!\d)")
RE_PHONE = re.compile(r"(?<!\d)(?:\(\d{3}\)[-.\s]?|\d{3}[-.])\d{3}[-.\s]\d{4}\b")
RE_IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")

# Credit card candidate numbers (13-19 digits with optional separators)
RE_CARD_CANDIDATE = re.compile(r"\b(?:\d[ -]?){13,19}\b")

_SAFE_LITERAL_VALUES = frozenset({"true", "false", "none", "null", "undefined", "redacted"})


class Redactor:
    """Scans and masks sensitive patterns in strings, dicts, and lists."""

    @classmethod
    def redact_text(cls, text: str, mask_ips: bool = False) -> str:
        """Redact all sensitive information from a raw string."""
        if not text:
            return ""

        # 1. Private keys & JWTs
        redacted = RE_PRIVATE_KEY.sub("[REDACTED_PRIVATE_KEY]", text)
        redacted = RE_JWT.sub("[REDACTED_JWT]", redacted)

        # 2. Known provider API keys & tokens
        redacted = RE_STRIPE_KEY.sub("[REDACTED_STRIPE_KEY]", redacted)
        redacted = RE_TAVILY_KEY.sub("[REDACTED_TAVILY_KEY]", redacted)
        redacted = RE_OPENAI_KEY.sub("[REDACTED_OPENAI_KEY]", redacted)
        redacted = RE_GITHUB_TOKEN.sub("[REDACTED_GITHUB_TOKEN]", redacted)
        redacted = RE_AWS_KEY.sub("[REDACTED_AWS_KEY]", redacted)
        redacted = RE_SLACK_TOKEN.sub("[REDACTED_SLACK_TOKEN]", redacted)
        redacted = RE_GOOGLE_KEY.sub("[REDACTED_GOOGLE_KEY]", redacted)

        # 3. Authorization headers & URL credentials
        redacted = RE_BEARER.sub("Bearer [REDACTED_TOKEN]", redacted)
        redacted = RE_BASIC_AUTH.sub("Basic [REDACTED_CREDENTIALS]", redacted)
        redacted = RE_PASSWORD_URL.sub(r"://\1:[REDACTED_PASSWORD]@", redacted)
        redacted = RE_URL_QUERY_SECRET.sub(r"\1[REDACTED_SECRET]", redacted)

        # 4. Generic key=value / key: value secrets (reconstructed via groups, never .replace)
        def _mask_kv(m: re.Match) -> str:
            prefix = m.group(1)
            val = m.group(3)
            closing = m.group(4)
            if val.startswith("[REDACTED_") or val.lower() in _SAFE_LITERAL_VALUES or val.isdigit():
                return m.group(0)
            return f"{prefix}[REDACTED_SECRET]{closing}"

        redacted = RE_GENERIC_SECRET_KV.sub(_mask_kv, redacted)

        # 5. Credit cards (validated via Luhn algorithm)
        def _mask_card(m: re.Match) -> str:
            candidate = m.group(0)
            cleaned = "".join(filter(str.isdigit, candidate))
            if 13 <= len(cleaned) <= 19 and _luhn_checksum_valid(cleaned):
                return "[REDACTED_CARD_NUMBER]"
            return candidate

        redacted = RE_CARD_CANDIDATE.sub(_mask_card, redacted)

        # 6. International phone numbers (+CC ...) BEFORE 12-digit IDs so +91 phones aren't split
        redacted = RE_INTL_PHONE.sub("[REDACTED_PHONE]", redacted)

        # 7. 12-digit National ID (Aadhaar / Gov ID)
        redacted = RE_12DIGIT_ID.sub("[REDACTED_12DIGIT_ID]", redacted)

        # 8. Email addresses & local formatted phone numbers
        redacted = RE_EMAIL.sub("[REDACTED_EMAIL]", redacted)
        redacted = RE_PHONE.sub("[REDACTED_PHONE]", redacted)

        if mask_ips:
            redacted = RE_IPV4.sub("[REDACTED_IP]", redacted)

        return redacted

    @classmethod
    def redact_object(cls, obj: Any, mask_ips: bool = False) -> Any:
        """Recursively redact strings in dictionaries, lists, and primitives."""
        if isinstance(obj, str):
            return cls.redact_text(obj, mask_ips=mask_ips)
        if isinstance(obj, dict):
            out: Dict[Any, Any] = {}
            safe_key_names = {"primary_key", "foreign_key", "sort_key", "cache_key", "public_key", "vapid_public_key"}
            for k, v in obj.items():
                key_str = str(k).lower()
                is_sensitive_key = key_str not in safe_key_names and (
                    any(
                        s in key_str
                        for s in (
                            "password",
                            "secret",
                            "api_key",
                            "apikey",
                            "private_key",
                            "access_token",
                            "session_token",
                            "step_up_token",
                            "auth_token",
                            "cookie",
                        )
                    )
                    or key_str.endswith(("_secret", "_password", "_token", "_key"))
                )
                if isinstance(v, str) and v and is_sensitive_key and not v.startswith("[REDACTED"):
                    out[k] = "[REDACTED_SECRET]"
                else:
                    out[k] = cls.redact_object(v, mask_ips=mask_ips)
            return out
        if isinstance(obj, list):
            return [cls.redact_object(item, mask_ips=mask_ips) for item in obj]
        if isinstance(obj, tuple):
            return tuple(cls.redact_object(item, mask_ips=mask_ips) for item in obj)
        return obj


def redact(content: Union[str, Dict[str, Any], List[Any]], mask_ips: bool = False) -> Union[str, Dict[str, Any], List[Any]]:
    """Convenience helper to redact strings or complex data structures."""
    if isinstance(content, str):
        return Redactor.redact_text(content, mask_ips=mask_ips)
    return Redactor.redact_object(content, mask_ips=mask_ips)


def wrap_untrusted(text: str, tag: str = "untrusted_log") -> str:
    """Redact untrusted external log/diff input and neutralize tag-closing prompt injection."""
    safe = Redactor.redact_text(text or "")
    safe = re.sub(rf"(?i)</\s*{re.escape(tag)}\s*>", f"[escaped-close-{tag}]", safe)
    return f"<{tag}>\n{safe}\n</{tag}>"
