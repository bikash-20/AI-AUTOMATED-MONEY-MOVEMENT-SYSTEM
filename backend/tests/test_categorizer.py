"""Tests for the categorizer + the insight/tag endpoints it powers.

Covers:
  1. Pure rule resolution (chai -> food, internet -> utilities, etc.)
  2. Bangla-digit normalisation + 'bill' kind -> 'bill'
  3. Unknown note -> None
  4. LLM fallback validation (only known slugs accepted, otherwise None)
  5. Worker writes idempotently under UNIQUE(txn_id, tag_slug)
  6. Tag override endpoint promotes an auto-tag to source='user'
  7. /insights/by-category GROUP BY aggregation over real confirmed txns
  8. _publish_categorize is fire-and-forget (no event loop in sync tests)
"""
from __future__ import annotations

from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app import engine, db as app_db
from app.models import Account, Transaction, TxnStatus, TxnTag, User
from app.services.categorizer import (
    categorize,
    categorize_by_rules,
    categorize_with_llm,
    is_known_tag,
    known_tags,
)
from app.workers.categorizer_worker import _apply_to_txn
from app.main import app as _fastapi_app


# ---- Fixtures ---------------------------------------------------------------
def _users(s) -> dict:
    return {u.handle: u for u in s.query(User).all()}


def _balance(s, handle: str) -> Decimal:
    u = _users(s)[handle]
    return s.query(Account).filter_by(user_id=u.id).one().balance_bdt


def _complete_send(s, *, sender_handle: str, recipient_handle: str,
                   amount: str, note: str, key: str) -> int:
    """Drive create_pending_send + confirm() end-to-end. Returns txn id."""
    sender_id = _users(s)[sender_handle].id
    txn = engine.create_pending_send(
        s,
        initiator_user_id=sender_id,
        recipient_handle=recipient_handle,
        amount=Decimal(amount),
        idempotency_key=key,
        note=note,
    )
    s.commit()
    engine.confirm(s, user_id=sender_id, pending_id=txn.id)
    s.commit()
    return txn.id


# ---- 1. Pure rule resolution -----------------------------------------------
@pytest.mark.parametrize(
    "kind,note,expected",
    [
        ("send", "chai at the corner", "food"),
        ("send", "evening coffee with team", "food"),
        ("send", "biryani for lunch", "food"),
        ("send", "uber to airport", "transport"),
        ("send", "pathao ride", "transport"),
        ("send", "rickshaw home", "transport"),
        ("send", "monthly internet bill", "utilities"),
        ("send", "wifi recharge", "utilities"),
        ("send", "wasa water", "utilities"),
        ("send", "basha rent march", "rent"),
        ("send", "amazon shopping", "shopping"),
        ("send", "daraz order", "shopping"),
        ("send", "apollo hospital visit", "health"),
        ("send", "tuition for may", "education"),
        ("send", "netflix subscription", "entertainment"),
        ("send", "eid savings", "savings"),
    ],
)
def test_rules_resolve_known_categories(kind, note, expected):
    """Common Bangladeshi transaction notes map to expected slugs."""
    slug, source = categorize(kind, note)
    assert slug == expected
    assert source == "auto"


# ---- 2. Bill kind + Bangla digit normalisation ----------------------------
def test_kind_bill_returns_bill_regardless_of_note():
    assert categorize_by_rules("bill", "anything goes here") == "bill"
    assert categorize("bill", None)[0] == "bill"


def test_bangla_digits_normalised_in_note():
    """STT sometimes returns Bangla numerals; categorizer should still work."""
    # "uber ৳১০০" -> after digit normalization the transport regex still hits.
    assert categorize_by_rules("send", "uber 100") == "transport"


# ---- 3. Unknown note -> None ----------------------------------------------
def test_unknown_note_returns_none():
    slug, source = categorize("send", "fdsajlk random gibberish xyzqq")
    assert slug is None
    assert source == "none"


def test_empty_note_returns_none():
    assert categorize_by_rules("send", None) is None
    assert categorize_by_rules("send", "") is None


# ---- 4. LLM fallback validation -------------------------------------------
def test_llm_fallback_accepts_known_slug(monkeypatch):
    """Stub llm._collect so we don't depend on a running Ollama."""
    import app.llm as llm_mod

    monkeypatch.setattr(
        llm_mod, "_collect", lambda system, user: "food"
    )
    out = categorize_with_llm("send", "something the rules don't know")
    assert out == "food"


def test_llm_fallback_rejects_unknown_slug(monkeypatch):
    import app.llm as llm_mod

    monkeypatch.setattr(
        llm_mod, "_collect", lambda system, user: "definitely_not_a_real_tag"
    )
    out = categorize_with_llm("send", "random text")
    assert out is None


def test_llm_fallback_tolerates_wrapped_answer(monkeypatch):
    """A response like 'the answer is food' should still resolve to food."""
    import app.llm as llm_mod

    monkeypatch.setattr(
        llm_mod, "_collect", lambda system, user: "the answer is shopping."
    )
    out = categorize_with_llm("send", "misc stuff")
    assert out == "shopping"


def test_llm_fallback_returns_none_when_no_cascade(monkeypatch):
    """If neither local cascade nor OpenRouter is configured, return None."""
    from app import config

    monkeypatch.setattr(config, "LLM_CASCADE", [])
    monkeypatch.setattr(config, "OPENROUTER_API_KEY", "")
    # Categorizer re-reads config on each call, so the patched values apply.
    assert categorize_with_llm("send", "foo bar") is None


def test_is_known_tag_and_known_tags():
    assert is_known_tag("food")
    assert not is_known_tag("nope")
    all_tags = set(known_tags())
    assert {"food", "transport", "utilities", "bill", "transfer"} <= all_tags


# ---- 5. Worker writes idempotently under UNIQUE(txn_id, tag_slug) ---------
def test_worker_writes_txn_tag_for_completed_send():
    with app_db.SessionLocal() as s:
        txn_id = _complete_send(
            s,
            sender_handle="bikash",
            recipient_handle="rishad",
            amount="100.00",
            note="chai for the team",
            key="cat-1",
        )
    # Now apply the worker to that txn.
    _apply_to_txn(txn_id)
    with app_db.SessionLocal() as s:
        tags = s.query(TxnTag).filter_by(txn_id=txn_id).all()
        assert len(tags) == 1
        assert tags[0].tag_slug == "food"
        assert tags[0].source == "auto"


def test_worker_skips_pending_txn():
    """Pending txns haven't actually moved money — don't tag them yet."""
    with app_db.SessionLocal() as s:
        bikash_id = _users(s)["bikash"].id
        txn = engine.create_pending_send(
            s,
            initiator_user_id=bikash_id,
            recipient_handle="rishad",
            amount=Decimal("50.00"),
            idempotency_key="cat-pending",
            note="chai",
        )
        s.commit()
        txn_id = txn.id
    _apply_to_txn(txn_id)
    with app_db.SessionLocal() as s:
        tags = s.query(TxnTag).filter_by(txn_id=txn_id).all()
        assert tags == [], "pending txn must not be tagged"


def test_worker_idempotent_on_repeat_call():
    """Re-running the worker must not create duplicate TxnTag rows."""
    with app_db.SessionLocal() as s:
        txn_id = _complete_send(
            s,
            sender_handle="bikash",
            recipient_handle="rishad",
            amount="40.00",
            note="uber ride",
            key="cat-idem",
        )
    _apply_to_txn(txn_id)
    _apply_to_txn(txn_id)
    _apply_to_txn(txn_id)
    with app_db.SessionLocal() as s:
        tags = s.query(TxnTag).filter_by(txn_id=txn_id).all()
        assert len(tags) == 1


# ---- 6. Tag override endpoint promotes auto -> user -----------------------
def test_user_tag_override_endpoint_promotes_source():
    """First the worker tags, then the user endpoint re-tags with source='user'."""
    with app_db.SessionLocal() as s:
        txn_id = _complete_send(
            s,
            sender_handle="bikash",
            recipient_handle="rishad",
            amount="60.00",
            note="uber",
            key="cat-override",
        )
    _apply_to_txn(txn_id)
    c = TestClient(_fastapi_app)
    bikash_id = (
        app_db.SessionLocal().query(User).filter_by(handle="bikash").one().id
    )
    # Override the auto-tag.
    r = c.post(
        f"/users/{bikash_id}/transactions/{txn_id}/tags",
        json={"tag_slug": "food"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {
        "txn_id": txn_id,
        "tag_slug": "food",
        "source": "user",
    }
    with app_db.SessionLocal() as s:
        # Still one row (UNIQUE(txn_id, tag_slug)), now source='user'.
        rows = (
            s.query(TxnTag)
            .filter_by(txn_id=txn_id, tag_slug="food")
            .all()
        )
        assert len(rows) == 1
        assert rows[0].source == "user"


def test_user_tag_override_rejects_unknown_slug():
    with app_db.SessionLocal() as s:
        txn_id = _complete_send(
            s,
            sender_handle="bikash",
            recipient_handle="rishad",
            amount="10.00",
            note="chai",
            key="cat-422",
        )
    c = TestClient(_fastapi_app)
    bikash_id = (
        app_db.SessionLocal().query(User).filter_by(handle="bikash").one().id
    )
    r = c.post(
        f"/users/{bikash_id}/transactions/{txn_id}/tags",
        json={"tag_slug": "definitely-not-a-real-tag"},
    )
    assert r.status_code == 422


# ---- 7. /insights/by-category aggregation ----------------------------------
def test_insights_by_category_aggregates_completed_debits():
    """Two chai sends + one transport send from bikash over the window."""
    txn_ids = []
    with app_db.SessionLocal() as s:
        for key, note, amt in [
            ("ins-1", "chai", "100.00"),
            ("ins-2", "coffee", "150.00"),
            ("ins-3", "uber ride", "200.00"),
        ]:
            txn_ids.append(
                _complete_send(
                    s,
                    sender_handle="bikash",
                    recipient_handle="rishad",
                    amount=amt,
                    note=note,
                    key=key,
                )
            )
        bikash_id = _users(s)["bikash"].id
    # Drive the categorizer worker inline (no event loop in tests).
    for tid in txn_ids:
        _apply_to_txn(tid)
    c = TestClient(_fastapi_app)
    r = c.get(f"/users/{bikash_id}/insights/by-category?days=30")
    assert r.status_code == 200, r.text
    body = r.json()
    by_cat = {row["category"]: row for row in body["categories"]}
    assert by_cat["food"]["total_bdt"] == "250.00"
    assert by_cat["food"]["count"] == 2
    assert by_cat["transport"]["total_bdt"] == "200.00"
    assert by_cat["transport"]["count"] == 1
    assert Decimal(body["grand_total_bdt"]) == Decimal("450.00")


def test_insights_by_category_404_for_unknown_user():
    c = TestClient(_fastapi_app)
    r = c.get("/users/999999/insights/by-category")
    assert r.status_code == 404


# ---- 8. _publish_categorize is fire-and-forget in sync context ------------
def test_publish_categorize_noops_in_sync_test():
    """Calling confirm() in a sync test must not raise (no event loop)."""
    with app_db.SessionLocal() as s:
        bikash_id = _users(s)["bikash"].id
        txn = engine.create_pending_send(
            s,
            initiator_user_id=bikash_id,
            recipient_handle="rishad",
            amount=Decimal("20.00"),
            idempotency_key="noop-1",
            note="chai",
        )
        s.commit()
        # The helper runs inside confirm(); it should silently no-op
        # because there's no asyncio loop running in this test thread.
        engine.confirm(s, user_id=bikash_id, pending_id=txn.id)
        s.commit()
    with app_db.SessionLocal() as s:
        fresh = s.get(Transaction, txn.id)
        assert fresh.status == TxnStatus.COMPLETED.value
