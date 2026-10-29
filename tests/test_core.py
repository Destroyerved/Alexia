"""Unit tests for Alexia Core Foundation.

Tests schemas, redaction, audit hash-chain, event bus, budget guard, and runbook memory.
"""

import asyncio
import os
import shutil
import pytest
from alexia.core.audit import AuditLog, GENESIS_HASH
from alexia.core.budget import CostGuard
from alexia.core.bus import EventBus
from alexia.core.llm import TokenFactoryClient
from alexia.core.memory import RunbookMemory
from alexia.core.redact import Redactor, redact
from alexia.core.router import ModelRouter
from alexia.core.schemas import Action, Event, Incident, generate_id

TEST_DB_PATH = "data/test_alexia.db"


@pytest.fixture(autouse=True)
def cleanup_test_db():
    if os.path.exists("data"):
        for f in os.listdir("data"):
            if f.startswith("test_"):
                try:
                    os.remove(os.path.join("data", f))
                except Exception:
                    pass
    yield
    if os.path.exists(TEST_DB_PATH):
        try:
            os.remove(TEST_DB_PATH)
        except Exception:
            pass


def test_redaction_secrets_and_pii():
    raw = (
        "Leaked secret: sk_" "live_abcdef123456789012345678 and token ghp_123456789012345678901234567890123456. "
        "User email is john.doe@example.com, phone +1-555-019-2834, ID 1234-5678-9012. "
        "Postgres conn: postgres://admin:superSecret123@db.internal:5432/shoplite."
    )
    redacted = redact(raw)

    assert "sk_live_" not in redacted
    assert "[REDACTED_STRIPE_KEY]" in redacted
    assert "[REDACTED_GITHUB_TOKEN]" in redacted
    assert "john.doe@example.com" not in redacted
    assert "[REDACTED_EMAIL]" in redacted
    assert "[REDACTED_PHONE]" in redacted
    assert "[REDACTED_12DIGIT_ID]" in redacted
    assert "superSecret123" not in redacted
    assert "[REDACTED_PASSWORD]" in redacted


def test_redaction_card_luhn():
    # Valid Visa card number test pattern (4111 1111 1111 1111 passes Luhn)
    valid_card = "Card number: 4111 1111 1111 1111"
    assert "[REDACTED_CARD_NUMBER]" in redact(valid_card)

    # Invalid card number (does not pass Luhn)
    invalid_card = "Random digits: 4111 1111 1111 1112"
    assert "[REDACTED_CARD_NUMBER]" not in redact(invalid_card)


def test_audit_hash_chain():
    audit = AuditLog(db_path=TEST_DB_PATH)

    # Empty chain is valid
    is_valid, count, err = audit.verify_chain()
    assert is_valid is True
    assert count == 0

    # Record 3 events
    e1 = audit.record("incident_opened", "collector.docker", {"incident": "inc_01"})
    assert e1.prev_hash == GENESIS_HASH

    e2 = audit.record("action_executed", "agent:healer", {"action": "restart_container"})
    assert e2.prev_hash == e1.hash

    e3 = audit.record("incident_resolved", "agent:healer", {"incident": "inc_01"})
    assert e3.prev_hash == e2.hash

    # Verify intact chain
    is_valid, count, err = audit.verify_chain()
    assert is_valid is True
    assert count == 3
    assert err is None

    # Tamper with row 2 in database directly
    import sqlite3

    conn = sqlite3.connect(TEST_DB_PATH)
    conn.execute("UPDATE audit_log SET details_json = '{\"tampered\": true}' WHERE id = 2")
    conn.commit()
    conn.close()

    # Verification must catch tampering
    is_valid, bad_idx, err = audit.verify_chain()
    assert is_valid is False
    assert "Tampered" in err or "Chain broken" in err


@pytest.mark.asyncio
async def test_event_bus_and_incident_lifecycle():
    bus = EventBus(db_path=TEST_DB_PATH)
    await bus.start()

    received_events = []

    async def on_container_exit(evt: Event):
        received_events.append(evt)

    bus.subscribe("container_exit", on_container_exit)

    # Publish an event
    event = Event(
        source="collector.docker",
        kind="container_exit",
        service="shoplite-api",
        severity="high",
        data={"exit_code": 137},
    )
    await bus.publish(event)
    await asyncio.sleep(0.1)

    assert len(received_events) == 1
    assert received_events[0].id == event.id

    # Create and update incident
    incident = Incident(
        category="crash",
        owner_agent="healer",
        severity="high",
        title="shoplite-api container exited",
    )
    bus.create_incident(incident)

    fetched = bus.get_incident(incident.id)
    assert fetched is not None
    assert fetched.status == "open"

    incident.status = "acting"
    bus.update_incident(incident, reason="Executing catalog fix")

    updated = bus.get_incident(incident.id)
    assert updated.status == "acting"

    incident.status = "resolved"
    bus.update_incident(incident, reason="Health check verified")

    resolved = bus.get_incident(incident.id)
    assert resolved.status == "resolved"
    assert resolved.resolved_at is not None

    await bus.stop()


def test_cost_guard_and_budget():
    guard = CostGuard(db_path=TEST_DB_PATH, daily_token_cap=1000, daily_usd_cap=0.05)

    summary = guard.get_daily_summary()
    assert summary["budget_exceeded"] is False
    assert guard.is_replay_mode() is False

    # Record small usage
    guard.record_usage(prompt_tokens=200, completion_tokens=50, cost_usd=0.01)
    assert guard.is_replay_mode() is False

    # Exceed limit
    guard.record_usage(prompt_tokens=1000, completion_tokens=200, cost_usd=0.06)
    assert guard.is_replay_mode() is True

    summary = guard.get_daily_summary()
    assert summary["budget_exceeded"] is True


def test_runbook_memory():
    mem = RunbookMemory(db_path=TEST_DB_PATH)

    action = Action(
        action="restart_container",
        target="shoplite-api",
        tier=0,
        status="executed",
    )
    incident = Incident(
        status="resolved",
        category="crash",
        owner_agent="healer",
        title="OOM exit code 137",
        plan=[action],
    )
    incident.diagnosis.root_cause = "Out of memory exit 137"

    entry = mem.record_solution(incident)
    assert entry is not None
    assert len(entry.actions) == 1

    # Match exact or similar signature
    match = mem.find_match(
        service="shoplite-api",
        category="crash",
        error_text="Out of memory exit 137",
    )
    assert match is not None
    assert match.actions[0].action == "restart_container"
