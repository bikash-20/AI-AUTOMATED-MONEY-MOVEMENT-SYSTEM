"""Tests for the explicit /agent/act-send endpoint (Quick-send, LLM-free)."""
from __future__ import annotations

from decimal import Decimal

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Account, User


def _bikash_id() -> int:
    with SessionLocal() as s:
        return s.query(User).filter_by(handle="bikash").one().id


def _bikash_balance() -> Decimal:
    with SessionLocal() as s:
        bikash = s.query(User).filter_by(handle="bikash").one()
        return s.query(Account).filter_by(user_id=bikash.id).one().balance_bdt


def _idem(suffix: str) -> str:
    # Sufficient length to pass schema validation (>= 8 chars).
    return f"send-{suffix}-" + "a" * 16


def test_act_send_creates_pending_with_review_card():
    """Happy path: Quick-send 500 to rishad. Returns a review card."""
    client = TestClient(app)
    bikash = _bikash_id()
    pre_balance = _bikash_balance()
    resp = client.post(
        "/agent/act-send",
        json={
            "user_id": bikash,
            "recipient_handle": "rishad",
            "amount_bdt": "500.00",
            "idempotency_key": _idem("happy"),
            "note": "chai",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == "send"
    assert body["idempotent_replay"] is False
    assert body["pending_id"] is not None
    card = body["card"]
    assert card["kind"] == "send"
    assert card["recipient_label"] == "rishad"
    assert card["amount_bdt"] == "500.00"
    # Pending rows do NOT debit yet — current balance is unchanged.
    assert _bikash_balance() == pre_balance
    # The card shows the post-debit projection.
    assert Decimal(card["resulting_balance_bdt"]) == pre_balance - Decimal("500.00")


def test_act_send_idempotency_replay_returns_same_pending():
    """Re-firing the same idempotency_key returns the same pending_id."""
    client = TestClient(app)
    bikash = _bikash_id()
    payload = {
        "user_id": bikash,
        "recipient_handle": "rishad",
        "amount_bdt": "100.00",
        "idempotency_key": "send-replay-key-1234",
    }
    first = client.post("/agent/act-send", json=payload).json()
    second = client.post("/agent/act-send", json=payload).json()
    # Both responses describe the same pending row.
    assert first["pending_id"] == second["pending_id"]
    # Second response is marked as a replay.
    assert second.get("idempotent_replay") is True
    # DB has exactly one pending transaction with this key.
    from app.models import Transaction
    with SessionLocal() as s:
        rows = (
            s.query(Transaction)
            .filter_by(initiator_user_id=bikash, idempotency_key="send-replay-key-1234")
            .all()
        )
        assert len(rows) == 1


def test_act_send_unknown_recipient_returns_helpful_action():
    """Typo'd handle returns 200 with action=send and a friendly text."""
    client = TestClient(app)
    bikash = _bikash_id()
    resp = client.post(
        "/agent/act-send",
        json={
            "user_id": bikash,
            "recipient_handle": "ghost_typo",
            "amount_bdt": "100.00",
            "idempotency_key": _idem("typo"),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == "send"
    assert body.get("pending_id") is None
    assert body.get("card") is None
    assert body["text"]  # non-empty phrased reply
    assert "ghost" in body["text"].lower()


def test_act_send_insufficient_funds_does_not_create_pending():
    """An over-balance amount returns the insufficient_funds phrase and
    does NOT leak a pending row."""
    client = TestClient(app)
    bikash = _bikash_id()
    pre_balance = _bikash_balance()
    resp = client.post(
        "/agent/act-send",
        json={
            "user_id": bikash,
            "recipient_handle": "rishad",
            "amount_bdt": str(pre_balance + Decimal("1.00")),
            "idempotency_key": _idem("poor"),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == "send"
    assert body.get("pending_id") is None
    assert body.get("card") is None
    assert "৳" in body["text"] or "balance" in body["text"].lower()
    # Balance unchanged.
    assert _bikash_balance() == pre_balance


def test_act_send_validates_amount_positive():
    """Schema rejects zero / negative amounts at the request boundary."""
    client = TestClient(app)
    bikash = _bikash_id()
    resp = client.post(
        "/agent/act-send",
        json={
            "user_id": bikash,
            "recipient_handle": "rishad",
            "amount_bdt": "0.00",
            "idempotency_key": _idem("zero"),
        },
    )
    assert resp.status_code == 422


def test_act_send_idempotency_key_length_validated():
    """Schema rejects too-short idempotency keys."""
    client = TestClient(app)
    bikash = _bikash_id()
    resp = client.post(
        "/agent/act-send",
        json={
            "user_id": bikash,
            "recipient_handle": "rishad",
            "amount_bdt": "10.00",
            "idempotency_key": "short",
        },
    )
    assert resp.status_code == 422
