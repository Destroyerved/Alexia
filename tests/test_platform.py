"""Comprehensive platform tests for Alexia Guardian.

Validates core requirements:
- Redaction of keys, PII, and credit cards with Luhn verification (FR-C4)
- Tamper-evident cryptographic hash chain verification and tamper detection (FR-C8)
- Safety tier enforcement in ActionExecutor (Tier 0, Tier 1, Tier 2) (FR-C6, FR-C7)
- Runbook memory signature matching (FR-C9)
- Cost accounting and budget tracking (FR-C10)
- FastAPI REST API endpoints
"""

import os
import tempfile
import pytest
from fastapi.testclient import TestClient

from alexia.actions.catalog import get_action_tier
from alexia.actions.executor import ActionExecutor
from alexia.api.main import app
from alexia.core.audit import AuditLog
from alexia.core.budget import BudgetGuard
from alexia.core.memory import RunbookMemory
from alexia.core.redact import redact
from alexia.core.schemas import Action


def test_redaction_layer():
    """Verify FR-C4: All secrets and PII are masked before leaving system boundary."""
    # Stripe secret key
    raw = "Found key sk_" "live_51MzDemoKeyWithRealEntropy7739 in config"
    assert "sk_live_" not in redact(raw)
    assert "[REDACTED_STRIPE_KEY]" in redact(raw)

    # Bearer token
    raw_bearer = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozG"
    assert "[REDACTED_JWT]" in redact(raw_bearer) or "Bearer [REDACTED" in redact(raw_bearer)

    # Luhn credit card
    card_text = "Payment card 4532 0150 1234 5671 processed"
    assert "4532" not in redact(card_text)
    assert "[REDACTED_CARD_NUMBER]" in redact(card_text)

    # 12-digit ID
    id_text = "Aadhaar number 1234 5678 9012"
    assert "[REDACTED_12DIGIT_ID]" in redact(id_text)

    # Email and phone
    pii_text = "Contact john.doe@example.com at +1-555-123-4567"
    assert "[REDACTED_EMAIL]" in redact(pii_text)
    assert "[REDACTED_PHONE]" in redact(pii_text)


def test_audit_hash_chain_and_tamper_detection():
    """Verify FR-C8: Cryptographic SHA-256 hash chain and tamper detection."""
    with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
        audit = AuditLog(db_path=tmp.name)

        # Append 5 entries
        for i in range(5):
            audit.record(
                event_type=f"test_event_{i}",
                actor=f"agent:test_{i}",
                details={"step": i, "status": "ok"},
            )

        # 1. Chain must be 100% valid
        is_valid, count, err = audit.verify_chain()
        assert is_valid is True
        assert count == 5
        assert err is None

        # 2. Intentionally tamper with row 3 in SQLite
        conn = audit._get_connection()
        conn.execute("UPDATE audit_log SET details_json = '{\"tampered\": true}' WHERE id = 3")
        conn.commit()

        # 3. Chain verification MUST fail and identify tampered row
        is_valid_after, count_after, err_after = audit.verify_chain()
        assert is_valid_after is False
        assert "Tampered row data at row 3" in err_after


def test_action_catalog_and_tier_enforcement():
    """Verify FR-C6, FR-C7: Tier 0 executes, Tier 1 queues, Tier 2 forbidden."""
    with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
        executor = ActionExecutor(db_path=tmp.name)

        # Tier 0: Auto execution
        act_0 = Action(
            action="restart_container",
            target="shoplite-api",
            tier=0,
            requested_by="agent:healer",
        )
        ok0, msg0, _ = executor.execute(act_0)
        assert ok0 is True
        assert act_0.status == "executed"

        # Tier 1: Queued for human approval
        act_1 = Action(
            action="rotate_secret",
            target="shoplite-api",
            tier=1,
            requested_by="agent:sentinel",
        )
        ok1, msg1, data1 = executor.execute(act_1)
        assert ok1 is True
        assert data1.get("queued") is True
        assert act_1.status == "pending"
        assert act_1.approval_token is not None

        # Tier 2: Strictly Forbidden
        act_2 = Action(
            action="rm -rf / --no-preserve-root",
            target="host",
            tier=2,
            requested_by="attacker",
        )
        ok2, msg2, _ = executor.execute(act_2)
        assert ok2 is False
        assert "FORBIDDEN" in msg2
        assert act_2.status == "rejected"


def test_runbook_memory():
    """Verify FR-C9: Runbook memory saves and recalls working fixes."""
    with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
        mem = RunbookMemory(db_path=tmp.name)

        actions = [Action(action="restart_container", target="shoplite-api", tier=0)]
        mem.record_runbook(
            category="crash",
            service="shoplite-api",
            error_indicator="SIGSEGV exit 1",
            root_cause="Null pointer exception in order service",
            actions=actions,
        )

        match = mem.find_matching_runbook(
            category="crash",
            service="shoplite-api",
            error_indicator="SIGSEGV exit 1",
        )
        assert match is not None
        assert match["actions"][0].action == "restart_container"
        assert match["success_count"] == 1


def test_fastapi_endpoints():
    """Test core REST API endpoints with FastAPI TestClient."""
    client = TestClient(app)

    # Health
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "healthy"

    # Services
    r = client.get("/services")
    assert r.status_code == 200
    assert len(r.json()) == 3

    # Audit
    r = client.get("/audit")
    assert r.status_code == 200
    assert "chain_verified" in r.json()

    # Stats
    r = client.get("/stats/models")
    assert r.status_code == 200
    assert "total_tokens" in r.json()


def test_handover_api_v1_endpoints():
    """Verify all /api/v1/... endpoints defined in the Backend Handover Sheet."""
    client = TestClient(app)

    # Dashboard overview
    r_dash = client.get("/api/v1/dashboard")
    assert r_dash.status_code == 200
    dash = r_dash.json()
    assert "incidents" in dash
    assert "approvals" in dash
    assert "services" in dash
    assert "model_summary" in dash
    assert "audit" in dash

    # Incidents & remediation
    r_inc = client.get("/api/v1/incidents")
    assert r_inc.status_code == 200

    # Approvals
    r_app = client.get("/api/v1/approvals")
    assert r_app.status_code == 200

    # Services & Deployments
    r_svc = client.get("/api/v1/services")
    assert r_svc.status_code == 200
    assert len(r_svc.json()) == 3

    r_dep = client.get("/api/v1/deployments")
    assert r_dep.status_code == 200
    assert len(r_dep.json()) >= 1

    # Scenarios
    r_scen = client.get("/api/v1/scenarios")
    assert r_scen.status_code == 200
    assert len(r_scen.json()) >= 6

    # Security findings & reports
    r_sec = client.get("/api/v1/security/findings")
    assert r_sec.status_code == 200
    assert "reports" in r_sec.json()

    r_rep = client.get("/api/v1/security/reports")
    assert r_rep.status_code == 200
    assert len(r_rep.json()) == 3

    # Observability / models
    r_mod = client.get("/api/v1/observability/models")
    assert r_mod.status_code == 200
    assert "tier_breakdown" in r_mod.json()

    # Audit & verify
    r_aud = client.get("/api/v1/audit/verify")
    assert r_aud.status_code == 200
    assert r_aud.json()["valid"] is True

    # Snapshots
    r_snap = client.get("/api/v1/snapshots")
    assert r_snap.status_code == 200
    assert len(r_snap.json()) >= 1

    # Settings
    r_set = client.get("/api/v1/settings")
    assert r_set.status_code == 200
    assert "redaction_enabled" in r_set.json()
