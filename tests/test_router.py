"""Tests for Model Router, Token Factory client, and tier escalation."""

import pytest
from pydantic import BaseModel
from alexia.core.llm import TokenFactoryClient, get_token_factory_client
from alexia.core.router import ModelRouter, get_model_router
from alexia.core.schemas import ModelCall


class SampleResponse(BaseModel):
    category: str
    severity: str
    confidence: float
    summary: str


@pytest.mark.asyncio
async def test_llm_client_simulated_inference():
    client = TokenFactoryClient()
    info = client.get_model_info("nano")
    assert "nvidia" in info["id"].lower() or "nemotron" in info["id"].lower()

    cost = client.compute_cost("nano", prompt_tokens=1000, completion_tokens=500)
    assert cost > 0.0

    parsed, call = await client.generate_structured(
        tier="nano",
        task="event_triage",
        system_prompt="You are a triage agent.",
        user_prompt="Container exited with status 137 OOM killer.",
        response_model=SampleResponse,
    )
    assert parsed.category in ("crash", "oom")

    assert parsed.confidence >= 0.7
    assert call.prompt_tokens > 0
    assert call.total_tokens > 0


@pytest.mark.asyncio
async def test_model_router_task_mapping():
    router = get_model_router()

    # Nano tasks
    assert router.get_initial_tier_for_task("event_triage") == "nano"
    assert router.get_initial_tier_for_task("push_summary") == "nano"

    # Super tasks
    assert router.get_initial_tier_for_task("diagnosis") == "super"
    assert router.get_initial_tier_for_task("code_patch_generation") == "super"

    # Ultra tasks
    assert router.get_initial_tier_for_task("fix_planning") == "ultra"
    assert router.get_initial_tier_for_task("multi_agent_orchestration") == "ultra"
