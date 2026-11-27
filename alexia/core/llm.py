"""Nebius Token Factory LLM client with routing, redaction, cost accounting and replay fallback.

Implements FR-C3, FR-C4, FR-C5, FR-C10:
- Single client interfacing with Token Factory (OpenAI-compatible endpoint).
- Pre-call redaction of prompts (secrets, PII, keys).
- Strict Pydantic structured output validation with retry & escalation.
- Token and USD cost accounting per call according to models.yaml.
- Replay/Mock mode when offline or daily budget is exceeded.
"""

from __future__ import annotations
import hashlib
import json
import re
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple, Type, TypeVar
import yaml
from pydantic import BaseModel, ValidationError

from alexia.core.budget import get_budget_guard
from alexia.core.redact import redact
from alexia.core.schemas import ModelCall, ModelTier, generate_id

logger = logging.getLogger("alexia.llm")

T = TypeVar("T", bound=BaseModel)


class LLMClient:
    """Client for Nebius Token Factory inference with safety, routing, and cost tracking."""

    def __init__(self, config_path: str = "config/models.yaml"):
        self.config_path = config_path
        self.config = self._load_config()
        self.base_url = os.getenv("NEBIUS_BASE_URL", self.config.get("base_url", "https://api.tokenfactory.nebius.com/v1/"))
        self.api_key = os.getenv("NEBIUS_API_KEY", "")
        self.budget_guard = get_budget_guard()

        # Initialize real OpenAI client if key is present
        self._openai_client = None
        self._consecutive_failures = 0
        self._circuit_open_until = 0.0
        if self.api_key and self.api_key not in ("your_nebius_api_key_here", "changeme"):
            try:
                from openai import OpenAI
                self._openai_client = OpenAI(base_url=self.base_url, api_key=self.api_key)
            except Exception as e:
                logger.warning(f"Could not initialize OpenAI client for Token Factory: {e}")

    def _load_config(self) -> Dict[str, Any]:
        import sys as _sys
        candidates = [
            self.config_path,
            os.path.join(getattr(_sys, "_MEIPASS", ""), self.config_path),
        ]
        for path in candidates:
            if path and os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    return yaml.safe_load(f) or {}
        return {}

    def get_model_info(self, tier: ModelTier) -> Dict[str, Any]:
        """Fetch model parameters and pricing for a tier from config."""
        models = self.config.get("models", {})
        return models.get(tier, {
            "id": f"nvidia/nemotron-3-{tier}",
            "pricing": {"input_per_million": 0.1, "output_per_million": 0.3},
            "temperature": 0.2,
            "timeout_seconds": 60,
        })

    def _compute_cost(self, tier: ModelTier, prompt_tokens: int, completion_tokens: int) -> float:
        info = self.get_model_info(tier)
        pricing = info.get("pricing", {})
        input_rate = pricing.get("input_per_million", 0.10) / 1_000_000.0
        output_rate = pricing.get("output_per_million", 0.30) / 1_000_000.0
        cost = (prompt_tokens * input_rate) + (completion_tokens * output_rate)
        return round(cost, 6)

    def compute_cost(self, tier: ModelTier, prompt_tokens: int, completion_tokens: int) -> float:
        """Public method to compute cost in USD for a given tier and token counts."""
        return self._compute_cost(tier, prompt_tokens, completion_tokens)

    def is_live(self) -> bool:
        """Return True if live Token Factory inference is configured, healthy, and within budget."""
        budget_guard = get_budget_guard()
        return (
            self._openai_client is not None
            and time.time() >= self._circuit_open_until
            and not budget_guard.should_use_replay_mode()
        )

    @staticmethod
    def _extract_json_object(raw_text: str) -> str:
        """Strip <think> reasoning traces, markdown code fences, and extract the JSON object."""
        cleaned = re.sub(r"<think>[\s\S]*?</think>", "", raw_text or "", flags=re.IGNORECASE).strip()
        fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", cleaned, flags=re.IGNORECASE)
        if fence_match:
            cleaned = fence_match.group(1).strip()
        # Find outermost balanced {...} if extra prose surrounds the JSON object
        start = cleaned.find("{")
        if start != -1:
            depth = 0
            in_str = False
            esc = False
            for idx in range(start, len(cleaned)):
                ch = cleaned[idx]
                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_str = False
                else:
                    if ch == '"':
                        in_str = True
                    elif ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                        if depth == 0:
                            return cleaned[start : idx + 1]
        return cleaned

    def complete(
        self,
        tier: ModelTier,
        prompt: str,
        system_prompt: str = "You are Alexia, an autonomous DevSecOps guardian.",
        task: str = "general",
        incident_id: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: int = 2048,
    ) -> Tuple[str, ModelCall]:
        """Execute a text completion with redaction, retries, circuit-breaker, and accounting."""
        start_time = time.perf_counter()
        budget_guard = get_budget_guard()

        # 1. Redact both prompt and system_prompt before leaving system boundary (FR-C4)
        redacted_prompt = str(redact(prompt))
        redacted_system = str(redact(system_prompt))
        prompt_hash = hashlib.sha256(f"{redacted_system}\n{redacted_prompt}".encode("utf-8")).hexdigest()[:16]

        model_info = self.get_model_info(tier)
        model_id = model_info.get("id", f"nvidia/nemotron-3-{tier}")
        temp = temperature if temperature is not None else model_info.get("temperature", 0.2)
        timeout = model_info.get("timeout_seconds", 60)

        call_status = "success"
        # 2. Live Token Factory call with retry + circuit breaker
        if self.is_live():
            last_exc: Optional[Exception] = None
            content = ""
            p_tokens = 0
            c_tokens = 0
            is_cached = False
            for retry_idx in range(2):
                try:
                    response = self._openai_client.chat.completions.create(
                        model=model_id,
                        messages=[
                            {"role": "system", "content": redacted_system},
                            {"role": "user", "content": redacted_prompt},
                        ],
                        temperature=temp,
                        max_tokens=max_tokens,
                        timeout=timeout,
                    )
                    content = response.choices[0].message.content or ""
                    usage = response.usage
                    p_tokens = usage.prompt_tokens if usage else len(redacted_prompt) // 4
                    c_tokens = usage.completion_tokens if usage else len(content) // 4
                    is_cached = False
                    self._consecutive_failures = 0
                    last_exc = None
                    break
                except Exception as exc:
                    last_exc = exc
                    if retry_idx == 0:
                        time.sleep(0.35)
            if last_exc is not None:
                self._consecutive_failures += 1
                if self._consecutive_failures >= 3:
                    self._circuit_open_until = time.time() + 30.0
                logger.error(
                    f"Token Factory call failed for tier {tier} ({model_id}): {last_exc}. Recording failure and using replay fallback."
                )
                budget_guard.record_model_call(
                    model_tier=tier,
                    model_id=model_id,
                    prompt_tokens=0,
                    completion_tokens=0,
                    cost_usd=0.0,
                    latency_ms=round((time.perf_counter() - start_time) * 1000, 2),
                    task=task,
                    incident_id=incident_id,
                    prompt_hash=prompt_hash,
                    cached=False,
                    status="failed",
                )
                content, p_tokens, c_tokens, is_cached = self._replay_completion(tier, task, redacted_prompt)
        else:
            content, p_tokens, c_tokens, is_cached = self._replay_completion(tier, task, redacted_prompt)

        latency_ms = round((time.perf_counter() - start_time) * 1000, 2)
        # Replay/cached calls incur $0.00 live API spend (NFR8 / PRD §10)
        cost_usd = 0.0 if is_cached else self._compute_cost(tier, p_tokens, c_tokens)

        # 3. Record accounting (FR-C3, FR-C10, NFR8)
        budget_guard.record_model_call(
            model_tier=tier,
            model_id=model_id,
            prompt_tokens=p_tokens,
            completion_tokens=c_tokens,
            cost_usd=cost_usd,
            latency_ms=latency_ms,
            task=task,
            incident_id=incident_id,
            prompt_hash=prompt_hash,
            cached=is_cached,
            status=call_status,
        )

        model_call = ModelCall(
            id=generate_id("call"),
            incident_id=incident_id,
            model_tier=tier,
            model_id=model_id,
            prompt_tokens=p_tokens,
            completion_tokens=c_tokens,
            total_tokens=p_tokens + c_tokens,
            cost_usd=cost_usd,
            latency_ms=latency_ms,
            prompt_hash=prompt_hash,
            task=task,
            cached=is_cached,
        )

        return content, model_call

    async def generate_structured(
        self,
        tier: ModelTier,
        task: str,
        system_prompt: str,
        user_prompt: str,
        response_model: Type[T],
        incident_id: Optional[str] = None,
    ) -> Tuple[T, ModelCall]:
        """Async compatibility method for structured JSON outputs."""
        return self.structured_complete(
            tier=tier,
            prompt=user_prompt,
            schema=response_model,
            system_prompt=system_prompt,
            task=task,
            incident_id=incident_id,
        )

    def structured_complete(
        self,
        tier: ModelTier,
        prompt: str,
        schema: Type[T],
        system_prompt: str = "You are Alexia. Always output valid JSON conforming exactly to the requested schema.",
        task: str = "structured_completion",
        incident_id: Optional[str] = None,
    ) -> Tuple[T, ModelCall]:
        """Execute a completion and validate against a Pydantic schema (FR-C5).

        On failure, retries once at temperature 0.0; if validation still fails,
        raises ValueError so ModelRouter can escalate tier (Nano -> Super -> Ultra).
        """
        schema_json = json.dumps(schema.model_json_schema(), indent=2)
        augmented_prompt = (
            f"{prompt}\n\nYou MUST reply with a single JSON object matching this schema:\n"
            f"```json\n{schema_json}\n```\n"
            "Do not include any explanation or markdown tags outside the JSON."
        )

        last_error: Optional[Exception] = None
        for attempt in range(2):
            raw_text, call = self.complete(
                tier=tier,
                prompt=augmented_prompt,
                system_prompt=system_prompt,
                task=task,
                incident_id=incident_id,
                temperature=0.1 if attempt == 0 else 0.0,
            )

            parsed_dict: Optional[Dict[str, Any]] = None
            try:
                cleaned = self._extract_json_object(raw_text)
                parsed_dict = json.loads(cleaned)
                validated = schema.model_validate(parsed_dict)
                return validated, call
            except (json.JSONDecodeError, ValidationError, TypeError) as err:
                last_error = err
                logger.warning(f"Structured validation attempt {attempt + 1} failed for {schema.__name__}: {err}")
                # Only in offline replay mode when a custom ad-hoc schema isn't covered by _replay_completion
                if attempt == 1 and call.cached and isinstance(parsed_dict, dict):
                    try:
                        synth: Dict[str, Any] = {}
                        for f_name, f_info in schema.model_fields.items():
                            if f_name in parsed_dict:
                                synth[f_name] = parsed_dict[f_name]
                            elif not f_info.is_required():
                                continue
                            elif f_info.annotation is bool:
                                synth[f_name] = False
                            elif f_info.annotation in (int, float, Optional[float]):
                                synth[f_name] = 0.85
                            elif getattr(f_info.annotation, "__origin__", None) is list or f_info.annotation is list:
                                synth[f_name] = []
                            else:
                                synth[f_name] = f"Replay {f_name}"
                        return schema.model_validate(synth), call
                    except Exception:
                        pass

        raise ValueError(f"Failed to generate valid {schema.__name__} after 2 attempts: {last_error}")

    # -----------------------------------------------------------------------
    # Replay / Mock Engine
    # -----------------------------------------------------------------------
    def _replay_completion(
        self,
        tier: ModelTier,
        task: str,
        prompt: str,
    ) -> Tuple[str, int, int, bool]:
        """Provides realistic deterministic responses conforming to schemas."""
        lower_prompt = prompt.lower()

        # Task: Pre-deploy Code Review (FR-B1)
        if "pre_deploy_code_review" in task or "review on the following git diff" in lower_prompt or "code_review" in task:
            diff_content = lower_prompt
            if "```diff" in lower_prompt:
                try:
                    diff_content = lower_prompt.split("```diff")[1].split("```")[0]
                except Exception:
                    diff_content = lower_prompt

            is_secret = (
                "sk_live" in diff_content
                or "redacted_stripe" in diff_content
                or "ghp_" in diff_content
                or "redacted_github" in diff_content
                or "aws_key" in diff_content
                or "secret_key = " in diff_content
                or "api_key = " in diff_content
            )
            is_bug = (
                "/ item_count" in diff_content
                or "/ 0" in diff_content
                or "zerodivision" in diff_content
                or "division by zero" in diff_content
            )
            has_crit = is_secret or is_bug
            finding_msg = "Leaked credentials detected in commit diff" if is_secret else "ZeroDivisionError hazard in calculation" if is_bug else "Potential logic risk in diff calculation"
            res = json.dumps({
                "has_critical_issue": has_crit,
                "findings": [finding_msg] if has_crit else ["No critical issues found"],
                "suggested_action": "block_deployment" if has_crit else "proceed_with_health_monitoring",
                "confidence": 0.95,
            })
            return res, 280, 80, True



        # Task: Event Triage
        if "triage" in task or "classify" in lower_prompt:
            # Classify on the telemetry only: the instruction text itself lists every category name
            telemetry = lower_prompt.split("classify into category")[0]
            if "disk_high" in telemetry or "disk" in telemetry or "capacity" in telemetry:
                category = "disk_full"
            elif "137" in telemetry or "oom" in telemetry or "killed" in telemetry:
                category = "oom"
            elif "exit" in telemetry or "crash" in telemetry or "die" in telemetry or "502" in telemetry:
                category = "crash"
            elif "secret" in telemetry or "stripe" in telemetry or "sqli" in telemetry or "union select" in telemetry or "login" in telemetry:
                category = "security"
            elif "zero" in telemetry or "division" in telemetry or "500" in telemetry:
                category = "code_bug"
            else:
                category = "unknown"

            res = json.dumps({
                "category": category,
                "severity": "critical" if category in ("security", "data_integrity") else "high" if category in ("oom", "crash") else "medium",
                "confidence": 0.94,
                "summary": f"Identified {category} condition requiring automated handling.",
            })
            return res, 180, 75, True

        # Task: Push Summary (FR-M3)
        if "push_summary" in task or "one sentence" in lower_prompt:
            if "sqli" in lower_prompt or "injection" in lower_prompt:
                return "SQL injection blocked on shoplite-api · 1 IP blocked · fix PR ready · approval needed", 210, 35, True
            elif "secret" in lower_prompt:
                return "Leaked Stripe API key blocked in commit · deployment paused · rotation required", 195, 30, True
            elif "crash" in lower_prompt:
                return "Container shoplite-api crashed unexpectedly · auto-restarting and health gating", 180, 25, True
            elif "disk" in lower_prompt:
                return "Log volume exceeded 95% threshold · automated snapshot and cleanup triggered", 175, 25, True
            return "Alexia DevSecOps event detected on target service · automated guardian active", 150, 20, True

        # Task: Breach Investigation Timeline (FR-S7)
        if "breach_investigation" in task or "investigation" in lower_prompt or "timeline" in lower_prompt:
            res = json.dumps({
                "entry_point": "/search?q= HTTP GET parameter",
                "attack_vector": "SQL Injection (UNION SELECT query extraction)",
                "timeline": [
                    "2026-10-29T00:15:02Z - Probe attempt from IP 198.51.100.88",
                    "2026-10-29T00:15:04Z - Malicious UNION SELECT payload executed against products table",
                    "2026-10-29T00:15:05Z - Reverse proxy temporary IP block enacted by Sentinel",
                    "2026-10-29T00:15:06Z - Forensic log snapshot hashed into audit chain",
                ],
                "compromised_data_summary": "Users table queried; potential read access to synthetic email and phone rows.",
                "confidence": 0.98,
            })
            return res, 350, 190, True

        # Task: Migration Risk Review (FR-I3)
        if "migration" in task or "alter table" in lower_prompt:
            sql_block = lower_prompt
            if "```sql" in lower_prompt:
                try:
                    sql_block = lower_prompt.split("```sql", 1)[1].split("```", 1)[0]
                except Exception:
                    sql_block = lower_prompt

            drops_col = bool(re.search(r"\bdrop\s+column\b", sql_block))
            drops_tbl = bool(re.search(r"\b(?:drop|truncate)\s+table\b", sql_block))
            deletes_all = bool(re.search(r"\bdelete\s+from\s+[a-z0-9_]+\s*(?:;|$)", sql_block))
            destructive = drops_col or drops_tbl or deletes_all

            dropped_cols = re.findall(r"\bdrop\s+column\s+(?:if\s+exists\s+)?([a-z0-9_]+)", sql_block)
            dropped_tbls = re.findall(r"\b(?:drop|truncate)\s+table\s+(?:if\s+exists\s+)?([a-z0-9_]+)", sql_block)

            if destructive:
                col_label = dropped_cols[0] if dropped_cols else "phone"
                tbl_label = dropped_tbls[0] if dropped_tbls else "records"
                summary_msg = (
                    f"Migration script drops column '{col_label}' containing active records; human Tier-1 approval required."
                    if drops_col
                    else f"Migration script drops table '{tbl_label}' containing active records; human Tier-1 approval required."
                )
                res = json.dumps({
                    "is_destructive": True,
                    "dropped_columns": dropped_cols or (["phone"] if drops_col else []),
                    "dropped_tables": dropped_tbls,
                    "estimated_data_loss_records": 150,
                    "risk_summary": summary_msg,
                })
            else:
                res = json.dumps({
                    "is_destructive": False,
                    "dropped_columns": [],
                    "dropped_tables": [],
                    "estimated_data_loss_records": 0,
                    "risk_summary": "Additive schema migration verified safe; zero tables, columns, or records at risk.",
                })
            return res, 290, 110, True

        # Task: Diagnosis
        if "diagnose" in task or "diagnosis" in lower_prompt:
            if "category 'disk_full'" in lower_prompt:
                root_cause = "Unrotated access logs filled the /var/log/shoplite volume."
                evidence = ["Log volume above 95% capacity", "No logrotate policy applied to access.log"]
            elif "category 'oom'" in lower_prompt:
                root_cause = "Worker exceeded its memory limit and was killed (exit code 137)."
                evidence = ["Container exited with code 137 (SIGKILL)", "HTTP 502 while the container was down"]
            else:
                root_cause = "Process termination or unhandled exception in target service."
                evidence = ["Container exited with non-zero exit code", "HTTP 502/500 connection refused"]
            res = json.dumps({
                "root_cause": root_cause,
                "evidence": evidence,
                "confidence": 0.92,
            })
            return res, 260, 95, True

        # Task: Fix Planning (Ultra)
        if "fix_planning" in task or "plan safe remediation" in lower_prompt:
            if "category: disk_full" in lower_prompt:
                actions = [{"action": "clear_tmp_and_rotate_logs", "target": "shoplite-api", "tier": 0}]
                outcome = "Logs archived and rotated; volume usage back under 70% with no data files touched."
            elif "category: config_error" in lower_prompt:
                actions = [{"action": "rollback_to_last_good_image", "target": "shoplite-api", "tier": 0}]
                outcome = "Last known-good image restored."
            else:
                actions = [{"action": "restart_container", "target": "shoplite-api", "tier": 0}]
                outcome = "Target service restored to healthy 200 OK operational state."
            res = json.dumps({
                "actions": actions,
                "expected_outcome": outcome,
                "rollback_plan": "rollback_to_last_good_image",
                "confidence": 0.95,
            })
            return res, 310, 110, True

        # Task: Ultra Patch Security Self-Review (FR-B6)
        if task == "patch_security_review" or "security review of this generated patch" in lower_prompt:
            if any(bad in lower_prompt for bad in ("subprocess", "os.system", "eval(", "drop table")):
                return "REJECT: patch introduces forbidden execution or destructive SQL primitive", 190, 18, True
            return "APPROVED", 180, 10, True

        # Task: Secret Confirmation (FR-S1 Nano confirmation)
        if task == "secret_confirmation":
            return "CONFIRMED", 120, 8, True

        # Task: Code Patch Generation (Builder)
        if "patch" in task or "regression test" in lower_prompt:
            grounded = _replay_patch_from_source(prompt)
            if grounded:
                return json.dumps(grounded), 420, 260, True
            if "sqli" in lower_prompt or "search" in lower_prompt or "union" in lower_prompt:
                res = json.dumps({
                    "root_cause": "Unsanitized user search input formatted directly into raw SQL query in search endpoint.",
                    "patch": "--- a/app/main.py\n+++ b/app/main.py\n@@ -45,3 +45,3 @@\n-    query = f\"SELECT id, name, price FROM products WHERE name LIKE '%{q}%'\"\n-    rows = db.execute(query).fetchall()\n+    query = \"SELECT id, name, price FROM products WHERE name LIKE :query\"\n+    rows = db.execute(query, {\"query\": f\"%{q}%\"}).fetchall()\n",
                    "failing_test": "def test_search_sqli_exploit_payload(client):\n    payload = \"' UNION SELECT email, password FROM users --\"\n    resp = client.get(f'/search?q={payload}')\n    assert resp.status_code == 200\n    assert 'email' not in resp.text\n",
                    "explanation": "Replaced string interpolation in SQL query with parameterized query binding `:query`.",
                })
                return res, 420, 260, True
            elif "division" in lower_prompt or "order" in lower_prompt or "zero" in lower_prompt:
                res = json.dumps({
                    "root_cause": "Division by zero in calculate_order_total when cart items count is 0.",
                    "patch": "--- a/app/orders.py\n+++ b/app/orders.py\n@@ -22,2 +22,4 @@\n+    if item_count == 0:\n+        return 0.0\n     return round(subtotal / item_count, 2)\n",
                    "failing_test": "def test_order_total_empty_cart():\n    total = calculate_order_total(subtotal=100.0, item_count=0)\n    assert total == 0.0\n",
                    "explanation": "Guarded against division by zero by early-returning 0.0 when item_count is 0.",
                })
                return res, 380, 210, True

        # Default fallback
        res = json.dumps({
            "root_cause": "Operational anomaly managed by Alexia DevSecOps engine.",
            "evidence": ["Runtime telemetry threshold anomaly"],
            "actions": [{"action": "restart_container", "target": "shoplite-api", "tier": 0}],
            "expected_outcome": "Automated recovery",
            "rollback_plan": "rollback_to_last_good_image",
            "confidence": 0.90,
        })
        return res, 200, 80, True


# ---------------------------------------------------------------------------
# Replay patch generation grounded in the real source the Builder sends
# ---------------------------------------------------------------------------
_SOURCE_RE = re.compile(r"SOURCE (?P<path>\S+)[^\n]*\n```python\n(?P<src>.*?)\n```", re.S)

_SQLI_TEST = '''from fastapi.testclient import TestClient
from app.main import app


def test_search_does_not_leak_users_via_union_injection():
    client = TestClient(app)
    payload = "' UNION SELECT email, phone, 1 FROM users--"
    resp = client.get("/search", params={"q": payload})
    assert resp.status_code == 200
    leaked = [row for row in resp.json()["results"] if any("@" in str(v) for v in row.values())]
    assert leaked == [], f"SQL injection leaked user rows: {leaked}"


def test_search_still_finds_products():
    client = TestClient(app)
    resp = client.get("/search", params={"q": "Keyboard"})
    assert resp.status_code == 200
    assert any(r["name"] == "Wireless Keyboard" for r in resp.json()["results"])
'''

_DIVISION_TEST = '''from fastapi.testclient import TestClient
from app.main import app


def test_order_total_empty_cart_does_not_crash():
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/orders/total", params={"subtotal": 100.0, "item_count": 0})
    assert resp.status_code == 200, f"empty cart crashed the endpoint: HTTP {resp.status_code}"
    assert resp.json()["average_per_item"] == 0.0


def test_order_total_regular_cart():
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/orders/total", params={"subtotal": 100.0, "item_count": 4})
    assert resp.json()["average_per_item"] == 25.0
'''


def _replay_patch_from_source(prompt: str) -> Optional[Dict[str, Any]]:
    """Deterministic stand-in for Super: edit the source quoted in the prompt and diff it.

    Returns None when the prompt has no source or no known bug pattern, so callers fall back.
    """
    from alexia.tools.diffutil import make_diff

    match = _SOURCE_RE.search(prompt)
    if not match:
        return None
    path, src = match.group("path"), match.group("src") + "\n"
    # Classify on the incident description only; the quoted source mentions every demo bug in its docstring
    lower = prompt[: match.start()].lower()
    lines = src.splitlines(keepends=True)

    if "union" in lower or "sql injection" in lower or "sqli" in lower:
        for i, line in enumerate(lines):
            if "LIKE '%{q}%'" in line and "query = f" in line:
                indent = line[: len(line) - len(line.lstrip())]
                lines[i] = f'{indent}query = "SELECT id, name, price FROM products WHERE name LIKE ?"\n'
                for j in range(i + 1, min(i + 6, len(lines))):
                    if "cur.execute(query)" in lines[j]:
                        lines[j] = lines[j].replace("cur.execute(query)", 'cur.execute(query, (f"%{q}%",))')
                        break
                new_src = "".join(lines)
                return {
                    "root_cause": f"User input is interpolated into the SQL string in {path} (/search), allowing UNION-based extraction of the users table (CWE-89).",
                    "patch": make_diff(path, src, new_src),
                    "failing_test": _SQLI_TEST,
                    "explanation": "Bind the search term as a query parameter instead of formatting it into the SQL text.",
                }
        return None

    if "division" in lower or "zerodivision" in lower or "item_count" in lower:
        guarded = any("if item_count == 0" in l for l in lines)
        for i, line in enumerate(lines):
            if "round(subtotal / item_count" in line and not guarded:
                indent = line[: len(line) - len(line.lstrip())]
                guard = [
                    f"{indent}if item_count == 0:\n",
                    f'{indent}    return {{"subtotal": subtotal, "item_count": 0, "average_per_item": 0.0}}\n',
                ]
                new_src = "".join(lines[:i] + guard + lines[i:])
                return {
                    "root_cause": f"{path} divides the order subtotal by item_count without handling an empty cart, raising ZeroDivisionError (HTTP 500).",
                    "patch": make_diff(path, src, new_src),
                    "failing_test": _DIVISION_TEST,
                    "explanation": "Return a zero average for empty carts before dividing.",
                }
        return None
    return None


_global_llm_client: Optional[LLMClient] = None


def get_llm_client(config_path: str = "config/models.yaml") -> LLMClient:
    """Retrieve or initialize the global LLMClient singleton."""
    global _global_llm_client
    if _global_llm_client is None:
        _global_llm_client = LLMClient(config_path=config_path)
    return _global_llm_client


# Backward-compatible aliases for PRD naming
TokenFactoryClient = LLMClient
get_token_factory_client = get_llm_client
