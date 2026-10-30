"""Unit tests for the 5 Specialized Agents and the Orchestrator."""

import os
import pytest
from alexia.agents.builder import get_builder_agent
from alexia.agents.deployer import get_deployer_agent
from alexia.agents.healer import get_healer_agent
from alexia.agents.integrity import get_integrity_agent
from alexia.agents.sentinel import get_sentinel_agent
from alexia.core.bus import get_event_bus
from alexia.core.orchestrator import get_orchestrator
from alexia.core.schemas import Event, Incident, generate_id

TEST_DB_PATH = "data/test_agents.db"


@pytest.fixture(autouse=True)
def clean_test_db():
    if os.path.exists(TEST_DB_PATH):
        try:
            os.remove(TEST_DB_PATH)
        except Exception:
            pass
    yield
    if os.path.exists(TEST_DB_PATH):
        try:
            os.remove(TEST_DB_PATH)
        except Exception:
            pass


@pytest.mark.asyncio
async def test_builder_agent_pre_deploy_review_and_fix():
    builder = get_builder_agent()

    # Pre-deploy review
    diff_with_secret = (
        "--- a/app/config.py\n+++ b/app/config.py\n@@ -1,2 +1,2 @@\n"
        "+STRIPE_SECRET_KEY = 'sk_" "live_abcdef123456789012345678'\n"
    )
    review = builder.review_diff(diff_with_secret)
    assert review.has_critical_issue is True

    # Remediation loop on the code as deployed by S1's buggy commit (empty-cart guard removed)
    from alexia.api.demo import build_s1_bad_commit

    incident = Incident(
        id=generate_id("inc"),
        category="code_bug",
        severity="high",
        metadata={"service": "shoplite-api", "deploy_diff": build_s1_bad_commit()},
    )
    remediated = await builder.handle_incident(
        incident, error_text="HTTP 500 ZeroDivisionError on /orders/total: float division by zero"
    )
    assert remediated.status == "acting", remediated.metadata.get("code_fix")
    assert "proof_of_fix" in remediated.metadata
    assert remediated.metadata["proof_of_fix"]["failed_before"] is True
    assert remediated.metadata["proof_of_fix"]["passed_after"] is True
    assert any(a.action == "open_pull_request" for a in remediated.plan)


@pytest.mark.asyncio
async def test_deployer_agent_gates_and_rollback():
    deployer = get_deployer_agent()

    # Gate 1: Leaked secret blocked
    res_secret = await deployer.deploy_commit(
        commit_sha="a1b2c3d4",
        diff_text="+STRIPE_KEY='sk_" "live_123456789012345678901234'\n",
    )
    assert res_secret["status"] == "blocked"
    assert res_secret["gate"] == "sentinel_secrets"

    # Gate 2: Destructive migration blocked
    res_mig = await deployer.deploy_commit(
        commit_sha="b2c3d4e5",
        diff_text="-- add migration\n",
        migration_sql="ALTER TABLE users DROP COLUMN phone;\n",
    )
    assert res_mig["status"] == "blocked"
    assert res_mig["gate"] == "integrity_migration"

    # Gate 3: Bad deploy triggers immediate rollback (forced deploy per Scenario S1)
    from alexia.api.demo import build_s1_bad_commit

    res_rollback = await deployer.deploy_commit(
        commit_sha="c3d4e5f6",
        diff_text=build_s1_bad_commit(),  # real diff: removes ShopLite's empty-cart guard
        force_deploy=True,
    )
    assert res_rollback["status"] == "rolled_back"
    assert "ZeroDivisionError" in res_rollback["reason"]



@pytest.mark.asyncio
async def test_healer_agent_crash_resolution():
    healer = get_healer_agent()
    incident = Incident(
        id=generate_id("inc"),
        category="crash",
        severity="high",
        metadata={"service": "shoplite-api", "kind": "container_exit"},
    )
    resolved = await healer.handle_incident(incident, error_text="Container exited with code 137 (OOMKilled)")
    assert resolved.status == "resolved"
    assert resolved.diagnosis.root_cause != ""
    assert any(a.action == "restart_container" for a in resolved.plan)


@pytest.mark.asyncio
async def test_sentinel_and_integrity_sqli_breach_loop():
    sentinel = get_sentinel_agent()
    integrity = get_integrity_agent()

    # Integrity assessment
    payload = "' UNION SELECT email,phone,password FROM users --"
    exposure = integrity.assess_exposure(payload)
    assert "users" in exposure["affected_tables"]
    assert exposure["estimated_rows_exposed"] > 0

    # Sentinel breach loop
    incident = Incident(
        id=generate_id("inc"),
        category="security",
        severity="critical",
        metadata={"service": "shoplite-api", "kind": "sqli_pattern"},
    )
    contained = await sentinel.handle_security_incident(
        incident=incident,
        attacker_ip="203.0.113.195",
        raw_payload=payload,
    )
    assert contained.status in ("resolved", "acting")
    assert "evidence_hash" in contained.metadata
    assert any(a.action == "block_ip_temporarily" for a in contained.plan)
    assert "reports" in contained.metadata
    assert "CERT-In" in contained.metadata["reports"]["cert_in"]
    assert "DPDP" in contained.metadata["reports"]["dpdp"] or "Digital Personal Data" in contained.metadata["reports"]["dpdp"]
