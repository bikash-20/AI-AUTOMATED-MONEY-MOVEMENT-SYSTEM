"""Engine safety tests — covers the non-negotiable invariants."""
from __future__ import annotations

from decimal import Decimal

import pytest

from app import engine, db as app_db
from app.models import Account, Request, RequestStatus, Transaction, TxnStatus, User


@pytest.fixture
def session():
    # Lazy-resolve SessionLocal each test so it picks up the engine rebuild.
    s = app_db.SessionLocal()
    yield s
    s.close()


def _users(session) -> dict:
    return {u.handle: u for u in session.query(User).all()}


def _balance(session, handle: str) -> Decimal:
    u = _users(session)[handle]
    return session.query(Account).filter_by(user_id=u.id).one().balance_bdt


# ---- Insufficient funds ----------------------------------------------------
def test_send_rejects_insufficient_funds(session):
    users = _users(session)
    bikash = users["bikash"]
    rishad = users["rishad"]
    with pytest.raises(engine.InsufficientFunds):
        engine.create_pending_send(
            session,
            initiator_user_id=bikash.id,
            recipient_handle="rishad",
            amount=Decimal("99999999.00"),
            idempotency_key="k1",
        )


# ---- Atomic debit/credit ----------------------------------------------------
def test_confirm_atomic_debit_credit(session):
    bikash_id = _users(session)["bikash"].id
    rishad = _users(session)["rishad"]
    pre_bikash = _balance(session, "bikash")
    pre_rishad = _balance(session, "rishad")
    txn = engine.create_pending_send(
        session,
        initiator_user_id=bikash_id,
        recipient_handle="rishad",
        amount=Decimal("500.00"),
        idempotency_key="k2",
    )
    session.commit()
    # While pending, balances unchanged.
    assert _balance(session, "bikash") == pre_bikash
    assert _balance(session, "rishad") == pre_rishad
    # Confirm.
    engine.confirm(session, user_id=bikash_id, pending_id=txn.id)
    session.commit()
    assert _balance(session, "bikash") == pre_bikash - Decimal("500.00")
    assert _balance(session, "rishad") == pre_rishad + Decimal("500.00")
    # Reload.
    fresh = session.get(Transaction, txn.id)
    assert fresh.status == TxnStatus.COMPLETED.value
    assert fresh.completed_at is not None


# ---- Self-transfer rejected ------------------------------------------------
def test_self_transfer_rejected(session):
    bikash_id = _users(session)["bikash"].id
    with pytest.raises(engine.SelfTransfer):
        engine.create_pending_send(
            session,
            initiator_user_id=bikash_id,
            recipient_handle="bikash",
            amount=Decimal("10.00"),
            idempotency_key="k3",
        )


# ---- Idempotency replay -----------------------------------------------------
def test_idempotency_replay(session):
    bikash_id = _users(session)["bikash"].id
    txn = engine.create_pending_send(
        session,
        initiator_user_id=bikash_id,
        recipient_handle="rishad",
        amount=Decimal("100.00"),
        idempotency_key="dup-key",
    )
    session.commit()
    pre_bikash = _balance(session, "bikash")
    with pytest.raises(engine.IdempotencyReplay):
        engine.create_pending_send(
            session,
            initiator_user_id=bikash_id,
            recipient_handle="rishad",
            amount=Decimal("100.00"),
            idempotency_key="dup-key",
        )
    session.commit()
    # Balances unchanged by the second call.
    assert _balance(session, "bikash") == pre_bikash


# ---- Pending TTL expiry -----------------------------------------------------
def test_pending_ttl_expiry(session, monkeypatch):
    bikash_id = _users(session)["bikash"].id
    txn = engine.create_pending_send(
        session,
        initiator_user_id=bikash_id,
        recipient_handle="rishad",
        amount=Decimal("50.00"),
        idempotency_key="ttl-k",
    )
    session.commit()
    # Force expiry.
    from datetime import datetime, timedelta, timezone
    txn.expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=1)
    session.commit()
    with pytest.raises(engine.PendingExpired):
        engine.confirm(session, user_id=bikash_id, pending_id=txn.id)


# ---- Sweeper cancels expired ------------------------------------------------
def test_sweeper_cancels_expired(session):
    from datetime import datetime, timedelta, timezone
    bikash_id = _users(session)["bikash"].id
    t1 = engine.create_pending_send(
        session,
        initiator_user_id=bikash_id,
        recipient_handle="rishad",
        amount=Decimal("5.00"),
        idempotency_key="sw1",
    )
    t2 = engine.create_pending_send(
        session,
        initiator_user_id=bikash_id,
        recipient_handle="arman",
        amount=Decimal("7.00"),
        idempotency_key="sw2",
    )
    session.commit()
    t1.expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=1)
    t2.expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=1)
    session.commit()
    # Manually invoke the sweeper's tick logic.
    from app.engine import Sweeper

    Sweeper(lambda: app_db.SessionLocal(), interval_seconds=999)._tick()
    s2 = app_db.SessionLocal()
    fresh1 = s2.get(Transaction, t1.id)
    fresh2 = s2.get(Transaction, t2.id)
    assert fresh1.status == TxnStatus.CANCELLED.value
    assert fresh2.status == TxnStatus.CANCELLED.value
    s2.close()


# ---- Split creates N children under parent --------------------------------
def test_split_creates_n_children(session):
    bikash_id = _users(session)["bikash"].id
    pre_bikash = _balance(session, "bikash")
    sp = engine.create_pending_split(
        session,
        initiator_user_id=bikash_id,
        recipient_handles=["rishad", "arman", "tahzib"],
        total_amount=Decimal("900.00"),
        idempotency_key="split1",
    )
    session.commit()
    children = (
        session.query(Transaction)
        .filter_by(parent_split_id=sp.id, kind="split_child")
        .all()
    )
    assert len(children) == 3
    total = sum((c.amount_bdt for c in children), Decimal("0"))
    assert total == Decimal("900.00")  # accounting conserved
    # Confirm all three -> balance drops by exactly 900.
    for c in children:
        engine.confirm(session, user_id=bikash_id, pending_id=c.id)
    session.commit()
    assert _balance(session, "bikash") == pre_bikash - Decimal("900.00")


def test_split_confirm_and_decline_are_grouped(session):
    bikash_id = _users(session)["bikash"].id
    pre_bikash = _balance(session, "bikash")
    sp = engine.create_pending_split(
        session,
        initiator_user_id=bikash_id,
        recipient_handles=["rishad", "arman"],
        total_amount=Decimal("100.00"),
        idempotency_key="split-group-confirm",
    )
    session.commit()
    first = session.query(Transaction).filter_by(parent_split_id=sp.id).order_by(Transaction.id).first()
    engine.confirm_split(session, user_id=bikash_id, pending_id=first.id)
    session.commit()
    children = session.query(Transaction).filter_by(parent_split_id=sp.id).all()
    assert all(child.status == TxnStatus.COMPLETED.value for child in children)
    assert _balance(session, "bikash") == pre_bikash - Decimal("100.00")

    sp2 = engine.create_pending_split(
        session,
        initiator_user_id=bikash_id,
        recipient_handles=["rishad", "arman"],
        total_amount=Decimal("80.00"),
        idempotency_key="split-group-decline",
    )
    session.commit()
    first2 = session.query(Transaction).filter_by(parent_split_id=sp2.id).order_by(Transaction.id).first()
    engine.decline(session, user_id=bikash_id, pending_id=first2.id)
    session.commit()
    assert all(child.status == TxnStatus.CANCELLED.value for child in session.query(Transaction).filter_by(parent_split_id=sp2.id).all())


# ---- Bill payment ----------------------------------------------------------
def test_bill_payment(session):
    bikash_id = _users(session)["bikash"].id
    pre_bikash = _balance(session, "bikash")
    txn = engine.create_pending_bill(
        session,
        initiator_user_id=bikash_id,
        biller_name="Internet",
        amount=Decimal("1200.00"),
        idempotency_key="bill1",
    )
    session.commit()
    engine.confirm(session, user_id=bikash_id, pending_id=txn.id)
    session.commit()
    assert _balance(session, "bikash") == pre_bikash - Decimal("1200.00")


# ---- Request flow ----------------------------------------------------------
def test_request_pay_flow(session):
    bikash_id = _users(session)["bikash"].id
    rishad_id = _users(session)["rishad"].id
    pre_bikash = _balance(session, "bikash")
    pre_rishad = _balance(session, "rishad")
    # rishad requests 300 from bikash.
    req = engine.create_pending_request(
        session,
        initiator_user_id=rishad_id,
        payer_handle="bikash",
        amount=Decimal("300.00"),
        idempotency_key="req1",
    )
    session.commit()
    # bikash pays.
    engine.pay_request(
        session,
        payer_user_id=bikash_id,
        request_id=req.id,
        idempotency_key="payreq1",
    )
    session.commit()
    assert _balance(session, "bikash") == pre_bikash - Decimal("300.00")
    assert _balance(session, "rishad") == pre_rishad + Decimal("300.00")
    s2 = app_db.SessionLocal()
    fresh = s2.get(Request, req.id)
    assert fresh.status == RequestStatus.PAID.value
    s2.close()


def test_request_idempotency_replay(session):
    rishad_id = _users(session)["rishad"].id
    engine.create_pending_request(
        session,
        initiator_user_id=rishad_id,
        payer_handle="bikash",
        amount=Decimal("25.00"),
        idempotency_key="request-duplicate",
    )
    session.commit()
    with pytest.raises(engine.IdempotencyReplay_for_request):
        engine.create_pending_request(
            session,
            initiator_user_id=rishad_id,
            payer_handle="bikash",
            amount=Decimal("25.00"),
            idempotency_key="request-duplicate",
        )


# ---- Decline ----------------------------------------------------------------
def test_decline_does_not_move_money(session):
    bikash_id = _users(session)["bikash"].id
    pre_bikash = _balance(session, "bikash")
    pre_rishad = _balance(session, "rishad")
    txn = engine.create_pending_send(
        session,
        initiator_user_id=bikash_id,
        recipient_handle="rishad",
        amount=Decimal("200.00"),
        idempotency_key="dec1",
    )
    session.commit()
    engine.decline(session, user_id=bikash_id, pending_id=txn.id)
    session.commit()
    assert _balance(session, "bikash") == pre_bikash
    assert _balance(session, "rishad") == pre_rishad
    s2 = app_db.SessionLocal()
    fresh = s2.get(Transaction, txn.id)
    assert fresh.status == TxnStatus.CANCELLED.value
    s2.close()


# ---- Resolver --------------------------------------------------------------
def test_resolver_fuzzy_match():
    from app.resolver import resolve_recipient, AmbiguousRecipient, UnknownRecipient

    handles = ["bikash", "rishad", "arman", "tahzib", "srijan", "mahdin"]
    # Exact.
    assert resolve_recipient("bikash", handles) == "bikash"
    assert resolve_recipient("Bikash", handles) == "bikash"
    # Single-edit typo.
    assert resolve_recipient("rishard", handles) == "rishad"
    assert resolve_recipient("biksh", handles) == "bikash"
    # Clearly different.
    with pytest.raises(UnknownRecipient):
        resolve_recipient("alice", handles)


def test_resolver_rejects_zero_amount():
    from app.resolver import resolve_amount, ResolutionError

    with pytest.raises(ResolutionError):
        resolve_amount(0)
    with pytest.raises(ResolutionError):
        resolve_amount(-5)
    assert resolve_amount("500") == Decimal("500.00")
    assert resolve_amount(500.50) == Decimal("500.50")
