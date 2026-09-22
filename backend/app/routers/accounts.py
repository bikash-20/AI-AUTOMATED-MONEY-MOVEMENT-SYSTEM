"""Accounts, history, pending requests, billers, session switching."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from .. import engine
from ..db import session_scope
from ..models import Account, Biller, Request, RequestStatus, SavingsGoal, Transaction, TxnStatus, User
from ..schemas import (
    BalanceOut,
    BillerOut,
    HistoryResponse,
    PendingRequestOut,
    SavingsContribution,
    SavingsGoalCreate,
    SavingsGoalOut,
    TxnOut,
    UserOut,
)

router = APIRouter(tags=["accounts"])


@router.get("/users", response_model=list[UserOut])
def list_users() -> list[UserOut]:
    with session_scope() as s:
        rows = s.execute(select(User).order_by(User.id)).scalars().all()
        return [UserOut(id=u.id, handle=u.handle, display_name=u.display_name, phone=u.phone) for u in rows]


@router.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: int) -> UserOut:
    with session_scope() as s:
        u = s.get(User, user_id)
        if u is None:
            raise HTTPException(404, "user not found")
        return UserOut(id=u.id, handle=u.handle, display_name=u.display_name, phone=u.phone)


@router.get("/users/handle/{handle}", response_model=UserOut)
def get_user_by_handle(handle: str) -> UserOut:
    with session_scope() as s:
        u = s.query(User).filter_by(handle=handle).one_or_none()
        if u is None:
            raise HTTPException(404, "user not found")
        return UserOut(id=u.id, handle=u.handle, display_name=u.display_name, phone=u.phone)


@router.get("/users/{user_id}/balance", response_model=BalanceOut)
def get_balance(user_id: int) -> BalanceOut:
    with session_scope() as s:
        snap = engine.snapshot(s, user_id)
        return BalanceOut(
            user_id=snap.user_id,
            handle=snap.handle,
            balance_bdt=snap.balance_bdt,
            as_of=_utcnow(),
        )


def _format_txn_for_user(txn: Transaction, user_id: int, session: Session) -> TxnOut:
    direction: str
    counterparty: Optional[str] = None
    counterparty_phone: Optional[str] = None
    if txn.from_account_id and txn.to_account_id:
        # Use account->user to figure out direction.
        from_user = (
            session.query(User).join(Account).filter(Account.id == txn.from_account_id).one_or_none()
        )
        to_user = (
            session.query(User).join(Account).filter(Account.id == txn.to_account_id).one_or_none()
        )
        if from_user and from_user.id == user_id:
            direction = "out"
            if to_user:
                counterparty = to_user.handle
                counterparty_phone = to_user.phone
        elif to_user and to_user.id == user_id:
            direction = "in"
            if from_user:
                counterparty = from_user.handle
                counterparty_phone = from_user.phone
        else:
            direction = "out"
    elif txn.from_account_id:
        direction = "out"
        if txn.biller_id:
            b = session.get(Biller, txn.biller_id)
            if b:
                counterparty = b.name
    else:
        direction = "in"

    return TxnOut(
        id=txn.id,
        kind=txn.kind,
        status=txn.status,
        amount_bdt=txn.amount_bdt,
        direction=direction,
        counterparty=counterparty,
        counterparty_phone=counterparty_phone,
        note=txn.note,
        created_at=txn.created_at,
        completed_at=txn.completed_at,
    )


@router.get("/users/{user_id}/history", response_model=HistoryResponse)
def get_history(user_id: int, limit: int = 50) -> HistoryResponse:
    """Return recent txns + a 14-day balance timeline."""
    with session_scope() as s:
        u = s.get(User, user_id)
        if u is None:
            raise HTTPException(404, "user not found")
        acct = s.query(Account).filter_by(user_id=u.id).one()

        # Pull txns involving this user's account, sorted desc.
        rows = (
            s.query(Transaction)
            .filter(
                (Transaction.from_account_id == acct.id)
                | (Transaction.to_account_id == acct.id)
            )
            .order_by(Transaction.created_at.desc())
            .limit(limit)
            .all()
        )
        txns = [_format_txn_for_user(t, u.id, s) for t in rows]

        # 14-day timeline: compute by walking transactions chronologically.
        # We'll start from current balance and subtract/apply deltas going back.
        timeline = _build_timeline(s, acct.id, acct.balance_bdt, days=2)

        return HistoryResponse(
            user_id=u.id,
            handle=u.handle,
            balance_bdt=acct.balance_bdt,
            txns=txns,
            timeline=timeline,
        )


def _build_timeline(
    s: Session, account_id: int, current_balance: Decimal, days: int = 14
) -> list[dict]:
    """Reverse-walk the last N days of transactions to compute end-of-day balance."""
    cutoff = _utcnow() - timedelta(days=days)
    txns = (
        s.query(Transaction)
        .filter(
            (Transaction.from_account_id == account_id)
            | (Transaction.to_account_id == account_id),
            Transaction.completed_at.isnot(None),
            Transaction.completed_at >= cutoff,
        )
        .order_by(Transaction.completed_at.asc())
        .all()
    )
    # Walk backward from current_balance, applying the inverse of each
    # completed transaction as we move to earlier days.
    running = current_balance
    today = _utcnow().date()
    by_day: dict = {}
    idx = len(txns) - 1
    for d_offset in range(0, days + 1):
        day = today - timedelta(days=d_offset)
        by_day[day.isoformat()] = float(running)
        while idx >= 0 and txns[idx].completed_at.date() == day:
            txn = txns[idx]
            if txn.from_account_id == account_id:
                running += txn.amount_bdt
            elif txn.to_account_id == account_id:
                running -= txn.amount_bdt
            idx -= 1
    by_day = dict(reversed(list(by_day.items())))
    return [{"date": d, "balance": round(b, 2)} for d, b in by_day.items()]


@router.get("/users/{user_id}/savings-goals", response_model=list[SavingsGoalOut])
def get_savings_goals(user_id: int) -> list[SavingsGoalOut]:
    with session_scope() as s:
        if s.get(User, user_id) is None:
            raise HTTPException(404, "user not found")
        return [SavingsGoalOut.model_validate(g, from_attributes=True) for g in s.query(SavingsGoal).filter_by(user_id=user_id).order_by(SavingsGoal.created_at.desc()).all()]


@router.post("/users/{user_id}/savings-goals", response_model=SavingsGoalOut)
def create_savings_goal(user_id: int, payload: SavingsGoalCreate) -> SavingsGoalOut:
    with session_scope() as s:
        if s.get(User, user_id) is None:
            raise HTTPException(404, "user not found")
        goal = SavingsGoal(user_id=user_id, festival=payload.festival.strip(), target_amount_bdt=payload.target_amount_bdt, target_date=payload.target_date)
        s.add(goal)
        try:
            s.flush()
        except Exception as exc:
            raise HTTPException(409, "a savings goal for this festival already exists") from exc
        return SavingsGoalOut.model_validate(goal, from_attributes=True)


@router.post("/users/{user_id}/savings-goals/{goal_id}/contribute", response_model=SavingsGoalOut)
def contribute_savings(user_id: int, goal_id: int, payload: SavingsContribution) -> SavingsGoalOut:
    """Move money into a festival goal atomically; no silent overdrafts."""
    with session_scope() as s:
        goal = s.get(SavingsGoal, goal_id)
        if goal is None or goal.user_id != user_id:
            raise HTTPException(404, "savings goal not found")
        account = s.query(Account).filter_by(user_id=user_id).one()
        transaction_key = f"saving:{goal_id}:{payload.idempotency_key}"
        existing = s.query(Transaction).filter_by(
            initiator_user_id=user_id, idempotency_key=transaction_key
        ).one_or_none()
        if existing is not None:
            return SavingsGoalOut.model_validate(goal, from_attributes=True)
        if account.balance_bdt < payload.amount_bdt:
            raise HTTPException(422, "insufficient balance for this saving")
        account.balance_bdt -= payload.amount_bdt
        s.add(Transaction(
            idempotency_key=transaction_key,
            initiator_user_id=user_id,
            from_account_id=account.id,
            amount_bdt=payload.amount_bdt,
            kind="savings",
            status=TxnStatus.COMPLETED.value,
            note=f"Saving for {goal.festival}",
            completed_at=_utcnow(),
        ))
        goal.saved_amount_bdt += payload.amount_bdt
        s.flush()
        return SavingsGoalOut.model_validate(goal, from_attributes=True)


@router.get("/users/{user_id}/requests", response_model=list[PendingRequestOut])
def get_pending_requests(user_id: int) -> list[PendingRequestOut]:
    """Requests where THIS user is the payer (i.e. owes someone)."""
    with session_scope() as s:
        rows = (
            s.query(Request)
            .filter_by(payer_user_id=user_id, status=RequestStatus.PENDING.value)
            .order_by(Request.created_at.desc())
            .all()
        )
        out: list[PendingRequestOut] = []
        for r in rows:
            asker = s.get(User, r.asker_user_id)
            out.append(
                PendingRequestOut(
                    id=r.id,
                    asker_handle=asker.handle if asker else "?",
                    asker_phone=asker.phone if asker else "",
                    amount_bdt=r.amount_bdt,
                    note=r.note,
                    created_at=r.created_at,
                )
            )
        return out


@router.post("/requests/{request_id}/pay")
def pay_request_endpoint(request_id: int, idempotency_key: str) -> dict:
    """Mark a request as paid (pays the asker)."""
    from .. import engine as eng

    with session_scope() as s:
        try:
            txn = eng.pay_request(
                s,
                payer_user_id=(
                    s.query(Request).filter_by(id=request_id).one().payer_user_id
                ),
                request_id=request_id,
                idempotency_key=idempotency_key,
            )
        except eng.InsufficientFunds as e:
            raise HTTPException(422, str(e))
        except eng.EngineError as e:
            raise HTTPException(400, str(e))
        new_balance = s.query(Account).filter_by(user_id=txn.initiator_user_id).one().balance_bdt
        return {"success": True, "new_balance_bdt": str(new_balance)}


@router.post("/requests/{request_id}/decline")
def decline_request_endpoint(request_id: int) -> dict:
    from .. import engine as eng

    with session_scope() as s:
        r = s.get(Request, request_id)
        if r is None:
            raise HTTPException(404, "request not found")
        try:
            eng.decline_request(s, user_id=r.payer_user_id, request_id=request_id)
        except eng.EngineError as e:
            raise HTTPException(400, str(e))
        return {"success": True}


@router.get("/billers", response_model=list[BillerOut])
def list_billers() -> list[BillerOut]:
    with session_scope() as s:
        rows = s.execute(select(Biller).order_by(Biller.id)).scalars().all()
        return [
            BillerOut(id=b.id, name=b.name, category=b.category, account_number=b.account_number)
            for b in rows
        ]
