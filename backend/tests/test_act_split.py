"""Tests for the explicit /agent/act-split endpoint (N-way, LLM-free)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.models import User


def _bikash_id() -> int:
    from app.db import SessionLocal
    with SessionLocal() as s:
        return s.query(User).filter_by(handle="bikash").one().id


def _idem() -> str:
    # Sufficient length to pass schema validation (>= 8 chars).
    return "nway-" + "a" * 16


def test_act_split_creates_pending_three_way():
    client = TestClient(app)
    bikash = _bikash_id()
    resp = client.post(
        "/agent/act-split",
        json={
            "user_id": bikash,
            "recipient_handles": ["rishad", "arman", "tahzib"],
            "amount_bdt": "900.00",
            "idempotency_key": _idem(),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == "split"
    assert body["card"]["kind"] == "split"
    assert body["card"]["recipients"] == ["rishad", "arman", "tahzib"]
    assert body["card"]["amount_bdt"] == "900.00"
    # Per-person = 300.00
    assert body["data"]["per_amount_bdt"] == "300.00"
    assert body["data"]["total_amount_bdt"] == "900.00"
    assert body["pending_id"] is not None


def test_act_split_idempotency_replay():
    """Same key returns the same pending_id instead of creating new rows."""
    client = TestClient(app)
    bikash = _bikash_id()
    payload = {
        "user_id": bikash,
        "recipient_handles": ["rishad", "arman"],
        "amount_bdt": "200.00",
        "idempotency_key": "replay-key-12345",
    }
    first = client.post("/agent/act-split", json=payload).json()
    second = client.post("/agent/act-split", json=payload).json()
    assert first["action"] == "split"
    assert second["action"] == "split"
    # Two valid outcomes, depending on whether the first response landed
    # first or the second saw an existing child:
    #   (a) Second is marked idempotent_replay=True and shares the same
    #       pending_id as first.
    #   (b) Both responses already share the same pending_id from the
    #       beginning (rare — happens when /act-split is invoked twice
    #       within the same request).
    if second.get("idempotent_replay"):
        assert second.get("pending_id") == first.get("pending_id")
        from app.db import SessionLocal
        from app.models import Transaction
        with SessionLocal() as s:
            row = s.get(Transaction, second["pending_id"])
            assert row is not None
            assert row.kind == "split_child"
    else:
        assert first.get("pending_id") == second.get("pending_id")


def test_act_split_rejects_too_few_recipients():
    client = TestClient(app)
    bikash = _bikash_id()
    resp = client.post(
        "/agent/act-split",
        json={
            "user_id": bikash,
            "recipient_handles": ["rishad"],
            "amount_bdt": "100.00",
            "idempotency_key": "too-few-1234",
        },
    )
    assert resp.status_code == 422


def test_act_split_rejects_too_many_recipients():
    client = TestClient(app)
    bikash = _bikash_id()
    resp = client.post(
        "/agent/act-split",
        json={
            "user_id": bikash,
            "recipient_handles": [
                "rishad", "arman", "tahzib", "srijan", "mahdin",
                "ghost_a", "ghost_b", "ghost_c", "ghost_d",
            ],
            "amount_bdt": "900.00",
            "idempotency_key": "too-many-12345",
        },
    )
    assert resp.status_code in (400, 422)


def test_act_split_unknown_recipient_returns_helpful_action():
    """A typo'd recipient should NOT 500 — it returns a structured
    response with action=split and a friendly text, just like the
    orchestrator path."""
    client = TestClient(app)
    bikash = _bikash_id()
    resp = client.post(
        "/agent/act-split",
        json={
            "user_id": bikash,
            "recipient_handles": ["rishad", "nope_typo"],
            "amount_bdt": "100.00",
            "idempotency_key": "typo-recip-1234",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["action"] == "split"
    assert body.get("pending_id") is None
    assert body.get("card") is None
    assert body["text"]  # non-empty phrased reply
