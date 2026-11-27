"""Cost and budget guard for LLM and external API usage.

Implements FR-C10 & NFR8:
- Tracks daily token usage, prompt hashes, cache hits, failed calls, and USD expenditures
  across model tiers (Nano, Super, Ultra).
- Tracks Tavily search call counts and cache hit rates.
- Switches to replay/mock mode when budget is exhausted to keep public demo functioning.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from alexia.core.paths import resolve_db_path
from alexia.core.sqlite import connect as sqlite_connect, resolve_openable_path

logger = logging.getLogger("alexia.budget")


class BudgetGuard:
    """Manages token and cost accounting with daily limits and replay fallback."""

    def __init__(
        self,
        db_path: str = "data/alexia.db",
        daily_token_limit: Optional[int] = None,
        daily_usd_limit: Optional[float] = None,
        replay_mode_on_exhaust: bool = True,
        daily_token_cap: Optional[int] = None,
        daily_usd_cap: Optional[float] = None,
    ):
        self.source_db_path = resolve_db_path(db_path)
        self.db_path = resolve_openable_path(self.source_db_path)
        self._explicit_token_limit = daily_token_cap if daily_token_cap is not None else daily_token_limit
        self._explicit_usd_limit = daily_usd_cap if daily_usd_cap is not None else daily_usd_limit
        token_cap = self._explicit_token_limit if self._explicit_token_limit is not None else 5_000_000
        usd_cap = self._explicit_usd_limit if self._explicit_usd_limit is not None else 10.0
        self.daily_token_limit = (
            int(self._explicit_token_limit)
            if self._explicit_token_limit is not None
            else int(os.getenv("DAILY_TOKEN_BUDGET", str(token_cap)))
        )
        self.daily_usd_limit = (
            float(self._explicit_usd_limit)
            if self._explicit_usd_limit is not None
            else float(os.getenv("DAILY_USD_BUDGET", str(usd_cap)))
        )
        self.replay_mode_on_exhaust = (
            os.getenv("REPLAY_MODE_ON_EXHAUST", str(replay_mode_on_exhaust)).lower()
            in ("true", "1", "yes")
        )
        self._lock = threading.Lock()
        self._init_db()

    def _effective_limits(self) -> tuple[int, float]:
        """Resolve active token/USD limits, honoring runtime platform_settings when using the global DB."""
        tok_limit = self.daily_token_limit
        usd_limit = self.daily_usd_limit
        if self._explicit_token_limit is None and self._explicit_usd_limit is None:
            try:
                from alexia.core.state_store import get_state_store

                settings = get_state_store(self.source_db_path).get_settings()
                if settings.get("daily_token_budget") is not None:
                    tok_limit = int(settings["daily_token_budget"])
                if settings.get("daily_usd_budget") is not None:
                    usd_limit = float(settings["daily_usd_budget"])
            except Exception:
                pass
        return tok_limit, usd_limit

    def _get_connection(self) -> sqlite3.Connection:
        return sqlite_connect(self.db_path)

    def _init_db(self) -> None:
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS model_usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    date TEXT NOT NULL,
                    model_tier TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    prompt_tokens INTEGER NOT NULL,
                    completion_tokens INTEGER NOT NULL,
                    total_tokens INTEGER NOT NULL,
                    cost_usd REAL NOT NULL,
                    latency_ms REAL NOT NULL,
                    task TEXT NOT NULL,
                    incident_id TEXT,
                    prompt_hash TEXT NOT NULL DEFAULT '',
                    cached INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'success',
                    timestamp TEXT NOT NULL
                )
                """
            )
            cols = {row[1] for row in conn.execute("PRAGMA table_info(model_usage)").fetchall()}
            if "prompt_hash" not in cols:
                conn.execute("ALTER TABLE model_usage ADD COLUMN prompt_hash TEXT NOT NULL DEFAULT ''")
            if "cached" not in cols:
                conn.execute("ALTER TABLE model_usage ADD COLUMN cached INTEGER NOT NULL DEFAULT 0")
            if "status" not in cols:
                conn.execute("ALTER TABLE model_usage ADD COLUMN status TEXT NOT NULL DEFAULT 'success'")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tavily_usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    date TEXT NOT NULL,
                    query TEXT NOT NULL,
                    cached INTEGER NOT NULL,
                    timestamp TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_model_usage_date ON model_usage (date)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_tavily_usage_date ON tavily_usage (date)")
            conn.commit()

    def _today_str(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def record_model_call(
        self,
        model_tier: str,
        model_id: str,
        prompt_tokens: int,
        completion_tokens: int,
        cost_usd: float,
        latency_ms: float,
        task: str,
        incident_id: Optional[str] = None,
        prompt_hash: str = "",
        cached: bool = False,
        status: str = "success",
    ) -> None:
        """Record an LLM model call and update daily ledger."""
        today = self._today_str()
        now = datetime.now(timezone.utc).isoformat()
        total_tokens = prompt_tokens + completion_tokens

        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO model_usage (
                    date, model_tier, model_id, prompt_tokens, completion_tokens,
                    total_tokens, cost_usd, latency_ms, task, incident_id,
                    prompt_hash, cached, status, timestamp
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    today,
                    model_tier,
                    model_id,
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                    cost_usd,
                    latency_ms,
                    task,
                    incident_id,
                    prompt_hash or "",
                    1 if cached else 0,
                    status,
                    now,
                ),
            )
            conn.commit()

    def record_tavily_call(self, query: str, cached: bool = False) -> None:
        """Record a Tavily search call."""
        today = self._today_str()
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO tavily_usage (date, query, cached, timestamp)
                VALUES (?, ?, ?, ?)
                """,
                (today, query, 1 if cached else 0, now),
            )
            conn.commit()

    def get_daily_stats(self, date: Optional[str] = None) -> Dict[str, Any]:
        """Return aggregated daily usage statistics computed directly in SQL."""
        target_date = date or self._today_str()
        tok_limit, usd_limit = self._effective_limits()

        with self._lock, self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT
                    COUNT(*) as total_calls,
                    COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) as failed_calls,
                    COALESCE(SUM(cached), 0) as cached_calls,
                    COALESCE(SUM(prompt_tokens), 0) as total_input_tokens,
                    COALESCE(SUM(completion_tokens), 0) as total_output_tokens,
                    COALESCE(SUM(total_tokens), 0) as total_tokens,
                    COALESCE(SUM(cost_usd), 0.0) as total_cost_usd,
                    COALESCE(AVG(latency_ms), 0.0) as avg_latency_ms,
                    COALESCE(SUM(CASE WHEN model_tier = 'nano' THEN total_tokens ELSE 0 END), 0) as nano_tokens,
                    COALESCE(SUM(CASE WHEN model_tier = 'super' THEN total_tokens ELSE 0 END), 0) as super_tokens,
                    COALESCE(SUM(CASE WHEN model_tier = 'ultra' THEN total_tokens ELSE 0 END), 0) as ultra_tokens,
                    COALESCE(SUM(CASE WHEN model_tier = 'nano' THEN cost_usd ELSE 0 END), 0.0) as nano_cost,
                    COALESCE(SUM(CASE WHEN model_tier = 'super' THEN cost_usd ELSE 0 END), 0.0) as super_cost,
                    COALESCE(SUM(CASE WHEN model_tier = 'ultra' THEN cost_usd ELSE 0 END), 0.0) as ultra_cost
                FROM model_usage
                WHERE date = ?
                """,
                (target_date,),
            )
            model_row = cur.fetchone()

            cur.execute(
                """
                SELECT
                    COUNT(*) as total_searches,
                    COALESCE(SUM(cached), 0) as cached_searches
                FROM tavily_usage
                WHERE date = ?
                """,
                (target_date,),
            )
            tavily_row = cur.fetchone()

            total_calls = int(model_row["total_calls"]) if model_row else 0
            failed_calls = int(model_row["failed_calls"]) if model_row else 0
            cached_calls = int(model_row["cached_calls"]) if model_row else 0
            total_tokens = int(model_row["total_tokens"]) if model_row else 0
            total_input_tokens = int(model_row["total_input_tokens"]) if model_row else 0
            total_output_tokens = int(model_row["total_output_tokens"]) if model_row else 0
            total_cost_usd = round(float(model_row["total_cost_usd"]), 4) if model_row else 0.0
            avg_lat = round(float(model_row["avg_latency_ms"]), 1) if model_row and total_calls > 0 else 0.0

            is_budget_exceeded = (
                (tok_limit > 0 and total_tokens >= tok_limit)
                or (usd_limit > 0 and total_cost_usd >= usd_limit)
            )

            nano_tokens = int(model_row["nano_tokens"]) if model_row else 0
            super_tokens = int(model_row["super_tokens"]) if model_row else 0
            ultra_tokens = int(model_row["ultra_tokens"]) if model_row else 0
            nano_cost = round(float(model_row["nano_cost"]), 4) if model_row else 0.0
            super_cost = round(float(model_row["super_cost"]), 4) if model_row else 0.0
            ultra_cost = round(float(model_row["ultra_cost"]), 4) if model_row else 0.0

            cur.execute(
                """
                SELECT model_tier, COUNT(*) as cnt, AVG(latency_ms) as avg_lat
                FROM model_usage
                WHERE date = ?
                GROUP BY model_tier
                """,
                (target_date,),
            )
            tier_rows = {r["model_tier"]: r for r in cur.fetchall()}

            recent_calls = self._fetch_recent_calls_from_conn(conn, limit=50)
            nano_calls = int(tier_rows["nano"]["cnt"]) if "nano" in tier_rows else 0
            super_calls = int(tier_rows["super"]["cnt"]) if "super" in tier_rows else 0
            ultra_calls = int(tier_rows["ultra"]["cnt"]) if "ultra" in tier_rows else 0

            total_searches = int(tavily_row["total_searches"]) if tavily_row else 0
            cached_searches = int(tavily_row["cached_searches"]) if tavily_row else 0
            combined_total = total_calls + total_searches
            combined_cached = cached_calls + cached_searches
            cache_hit_pct = round((combined_cached / combined_total) * 100.0, 1) if combined_total > 0 else 0.0

            return {
                "date": target_date,
                "total_calls": total_calls,
                "failed_calls": failed_calls,
                "total_tokens": total_tokens,
                "total_input_tokens": total_input_tokens,
                "total_output_tokens": total_output_tokens,
                "total_cost_usd": total_cost_usd,
                "total_spend_usd": total_cost_usd,
                "daily_token_limit": tok_limit,
                "daily_usd_limit": usd_limit,
                "daily_budget_usd": usd_limit,
                "remaining_budget_usd": round(max(0.0, usd_limit - total_cost_usd), 4),
                "daily_token_cap": tok_limit,
                "avg_latency_ms": avg_lat,
                "total_tavily_calls": total_searches,
                "token_budget_pct": round((total_tokens / max(tok_limit, 1)) * 100, 2) if tok_limit > 0 else 0.0,
                "usd_budget_pct": round((total_cost_usd / max(usd_limit, 0.001)) * 100, 2) if usd_limit > 0 else 0.0,
                "is_budget_exceeded": is_budget_exceeded,
                "budget_exhausted": is_budget_exceeded,
                "replay_mode_active": is_budget_exceeded and self.replay_mode_on_exhaust,
                "cache_hit_rate_percent": cache_hit_pct,
                "tier_breakdown": {
                    "nano": {"calls": nano_calls, "tokens": nano_tokens, "cost_usd": nano_cost},
                    "super": {"calls": super_calls, "tokens": super_tokens, "cost_usd": super_cost},
                    "ultra": {"calls": ultra_calls, "tokens": ultra_tokens, "cost_usd": ultra_cost},
                },
                "calls_by_tier": {
                    "nano": nano_calls,
                    "super": super_calls,
                    "ultra": ultra_calls,
                },
                "tokens_by_tier": {
                    "nano": nano_tokens,
                    "super": super_tokens,
                    "ultra": ultra_tokens,
                },
                "cost_by_tier": {
                    "nano": nano_cost,
                    "super": super_cost,
                    "ultra": ultra_cost,
                },
                "avg_latency_by_tier": {
                    "nano": round(tier_rows["nano"]["avg_lat"], 1) if "nano" in tier_rows and tier_rows["nano"]["avg_lat"] else 0.0,
                    "super": round(tier_rows["super"]["avg_lat"], 1) if "super" in tier_rows and tier_rows["super"]["avg_lat"] else 0.0,
                    "ultra": round(tier_rows["ultra"]["avg_lat"], 1) if "ultra" in tier_rows and tier_rows["ultra"]["avg_lat"] else 0.0,
                },
                "breakdown": {
                    "nano": {"tokens": nano_tokens, "cost": nano_cost},
                    "super": {"tokens": super_tokens, "cost": super_cost},
                    "ultra": {"tokens": ultra_tokens, "cost": ultra_cost},
                },
                "tavily": {
                    "total_searches": total_searches,
                    "cached_searches": cached_searches,
                },
                "recent_calls": recent_calls,
            }

    @staticmethod
    def _fetch_recent_calls_from_conn(conn: sqlite3.Connection, limit: int = 30) -> list[Dict[str, Any]]:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT * FROM model_usage
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        )
        rows = cur.fetchall()
        task_to_agent = {
            "triage": "Sentinel",
            "event_triage": "Healer",
            "event_triage_escalated": "Healer",
            "investigation": "Sentinel",
            "breach_investigation_timeline": "Sentinel",
            "diagnosis": "Healer",
            "fix_planning": "Healer",
            "runbook_matching": "Healer",
            "push_summary": "Orchestrator",
            "breach_report": "Sentinel",
            "migration_risk_review": "Integrity",
            "diff_review": "Builder",
            "pre_deploy_code_review": "Builder",
            "pre_deploy_code_review_escalated": "Builder",
            "patch_gen": "Builder",
            "code_patch_generation": "Builder",
            "patch_security_review": "Builder",
            "secret_confirmation": "Sentinel",
            "deploy_gate": "Deployer",
        }
        calls = []
        for r in rows:
            row_keys = r.keys()
            tier = r["model_tier"]
            task = r["task"] or "diagnosis"
            agent = task_to_agent.get(task, "Healer")
            stage_map = {
                "triage": "triage",
                "event_triage": "triage",
                "investigation": "diagnosis",
                "diagnosis": "diagnosis",
                "patch_gen": "plan",
                "code_patch_generation": "plan",
                "fix_planning": "plan",
                "diff_review": "verification",
                "patch_security_review": "verification",
                "breach_report": "resolution",
            }
            is_cached = bool(r["cached"]) if "cached" in row_keys else False
            call_status = str(r["status"]) if "status" in row_keys and r["status"] else "success"
            prompt_hash = str(r["prompt_hash"]) if "prompt_hash" in row_keys else ""
            calls.append(
                {
                    "id": f"mc_{r['id']:04d}",
                    "timestamp": r["timestamp"],
                    "incident_id": r["incident_id"] or "inc_s6_sqli_breach",
                    "agent": agent,
                    "stage": stage_map.get(task, "diagnosis"),
                    "tier": tier.title(),
                    "model_name": r["model_id"],
                    "model_id": r["model_id"],
                    "task": f"{agent} Agent — {task.replace('_', ' ').title()}",
                    "task_type": task,
                    "input_tokens": r["prompt_tokens"],
                    "output_tokens": r["completion_tokens"],
                    "prompt_tokens": r["prompt_tokens"],
                    "completion_tokens": r["completion_tokens"],
                    "total_tokens": r["total_tokens"],
                    "latency_ms": round(r["latency_ms"], 1),
                    "cost_usd": round(r["cost_usd"], 5),
                    "prompt_hash": prompt_hash,
                    "status": call_status,
                    "cached": is_cached,
                    "escalated": tier == "ultra" or "escalated" in task,
                    "escalation_reason": "High-severity or retry escalation" if (tier == "ultra" or "escalated" in task) else None,
                    "safe_request_summary": f"Redacted {task} prompt ({prompt_hash or 'sha256'}) for {r['incident_id'] or 'platform'}",
                    "safe_response_summary": f"Structured {tier.upper()} output ({'replay/cached' if is_cached else 'live'})",
                }
            )
        return calls

    def list_recent_calls(self, limit: int = 30) -> list[Dict[str, Any]]:
        """Return recent LLM calls formatted for both backend and frontend observability views."""
        with self._lock, self._get_connection() as conn:
            return self._fetch_recent_calls_from_conn(conn, limit=limit)

    def should_use_replay_mode(self) -> bool:
        """Check if daily limits have been reached and replay mode is active."""
        stats = self.get_daily_stats()
        return bool(stats["replay_mode_active"])

    def record_usage(self, prompt_tokens: int, completion_tokens: int, cost_usd: float) -> Dict[str, Any]:
        """Convenience method to record usage and return daily stats."""
        self.record_model_call(
            model_tier="nano",
            model_id="default",
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            cost_usd=cost_usd,
            latency_ms=0.0,
            task="general",
        )
        return self.get_daily_summary()

    def get_daily_summary(self) -> Dict[str, Any]:
        """Convenience alias for get_daily_stats with budget_exceeded flag."""
        stats = self.get_daily_stats()
        stats["budget_exceeded"] = stats["is_budget_exceeded"]
        stats["replay_mode"] = stats["replay_mode_active"]
        return stats

    def is_replay_mode(self) -> bool:
        """Convenience alias for should_use_replay_mode."""
        return self.should_use_replay_mode()


_global_budget_guard: Optional[BudgetGuard] = None


def get_budget_guard(db_path: str = "data/alexia.db") -> BudgetGuard:
    """Retrieve or initialize the global BudgetGuard singleton."""
    from alexia.core.sqlite import has_table

    global _global_budget_guard
    if (
        _global_budget_guard is None
        or _global_budget_guard.source_db_path != resolve_db_path(db_path)
        or not has_table(_global_budget_guard.db_path, "model_usage")
    ):
        _global_budget_guard = BudgetGuard(db_path=db_path)
    return _global_budget_guard


CostGuard = BudgetGuard
get_cost_guard = get_budget_guard
