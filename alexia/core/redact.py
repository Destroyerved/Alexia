"""Redaction layer for sensitive data protection.

Implements FR-C4: Masks secrets, tokens, credentials, PII (emails, phone numbers,
12-digit national IDs), and payment card numbers with Luhn verification before
any prompt, log, or push payload leaves the system boundary.
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


# Compiled regex patterns for high performance
RE_PRIVATE_KEY = re.compile(
    r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
    re.MULTILINE,
)
RE_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")

# Well-known API keys & secrets
RE_STRIPE_KEY = re.compile(r"\b(?:sk|pk)_(?:live|test)_[0-9a-zA-Z]{24,}\b")
RE_OPENAI_KEY = re.compile(r"\bsk-[a-zA-Z0-9T3BlbkFJ]{20,}\b")
RE_GITHUB_TOKEN = re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{36,}\b")
RE_AWS_KEY = re.compile(r"\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b")
RE_BEARER = re.compile(r"(?i)bearer\s+[a-zA-Z0-9_\-\.]{20,}")
RE_PASSWORD_URL = re.compile(r"://([^:]+):([^@\s]+)@")
RE_GENERIC_SECRET_KV = re.compile(
    r"(?i)(?:api_key|apikey|secret|password|passwd|token|access_token|client_secret)\s*[:=]\s*['\"]?([a-zA-Z0-9!@#$%^&*()_+=\-`~\[\]{}|;:,.<>?/]{8,})['\"]?"
)

# PII patterns
RE_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b")
RE_PHONE = re.compile(r"(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")
RE_12DIGIT_ID = re.compile(r"(?<!\d)\d{4}[-\s]?\d{4}[-\s]?\d{4}(?!\d)")

# Credit card candidate numbers (13-19 digits with optional separators)
RE_CARD_CANDIDATE = re.compile(r"\b(?:\d[ -]?){13,19}\b")


class Redactor:
    """Scans and masks sensitive patterns in strings, dicts, and lists."""

    @classmethod
    def redact_text(cls, text: str) -> str:
        """Redact all sensitive information from a raw string."""
        if not text:
            return ""

        # 1. Private keys
        redacted = RE_PRIVATE_KEY.sub("[REDACTED_PRIVATE_KEY]", text)

        # 2. JWTs
        redacted = RE_JWT.sub("[REDACTED_JWT]", redacted)

        # 3. Known API keys
        redacted = RE_STRIPE_KEY.sub("[REDACTED_STRIPE_KEY]", redacted)
        redacted = RE_OPENAI_KEY.sub("[REDACTED_OPENAI_KEY]", redacted)
        redacted = RE_GITHUB_TOKEN.sub("[REDACTED_GITHUB_TOKEN]", redacted)
        redacted = RE_AWS_KEY.sub("[REDACTED_AWS_KEY]", redacted)

        # 4. Bearer tokens
        redacted = RE_BEARER.sub("Bearer [REDACTED_TOKEN]", redacted)

        # 5. Passwords in URLs (e.g. postgres://user:pass@host:5432/db)
        redacted = RE_PASSWORD_URL.sub(r"://\1:[REDACTED_PASSWORD]@", redacted)

        # 6. Generic secret assignments (e.g. SECRET_KEY = "xyz...")
        def _mask_kv(m: re.Match) -> str:
            full = m.group(0)
            val = m.group(1)
            if val.startswith("[REDACTED_"):
                return full
            return full.replace(val, "[REDACTED_SECRET]")

        redacted = RE_GENERIC_SECRET_KV.sub(_mask_kv, redacted)


        # 7. Credit cards (validated via Luhn algorithm)
        def _mask_card(m: re.Match) -> str:
            candidate = m.group(0)
            cleaned = "".join(filter(str.isdigit, candidate))
            if 13 <= len(cleaned) <= 19 and _luhn_checksum_valid(cleaned):
                return "[REDACTED_CARD_NUMBER]"
            return candidate

        redacted = RE_CARD_CANDIDATE.sub(_mask_card, redacted)

        # 8. 12-digit National ID (Aadhaar / Gov ID)
        redacted = RE_12DIGIT_ID.sub("[REDACTED_12DIGIT_ID]", redacted)

        # 9. Email addresses
        redacted = RE_EMAIL.sub("[REDACTED_EMAIL]", redacted)

        # 10. Phone numbers
        redacted = RE_PHONE.sub("[REDACTED_PHONE]", redacted)

        return redacted

    @classmethod
    def redact_object(cls, obj: Any) -> Any:
        """Recursively redact strings in dictionaries, lists, and primitives."""
        if isinstance(obj, str):
            return cls.redact_text(obj)
        elif isinstance(obj, dict):
            return {k: cls.redact_object(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [cls.redact_object(item) for item in obj]
        elif isinstance(obj, tuple):
            return tuple(cls.redact_object(item) for item in obj)
        return obj


def redact(content: Union[str, Dict[str, Any], List[Any]]) -> Union[str, Dict[str, Any], List[Any]]:
    """Convenience helper to redact strings or complex data structures."""
    if isinstance(content, str):
        return Redactor.redact_text(content)
    return Redactor.redact_object(content)
