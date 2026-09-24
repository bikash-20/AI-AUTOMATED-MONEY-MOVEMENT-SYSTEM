"""Transaction engine — the only place that touches balances.

State machine for `Transaction.status`:
    pending  --(confirm)-->  completed
    pending  --(decline)-->  cancelled
    pending  --(TTL)------->  cancelled  (sweeper)

Every money-moving path is wrapped in a single DB transaction so a crash
mid-debit can never leave inconsistent balances. Idempotency is enforced via
UNIQUE(initiator_user_id, idempotency_key) on transactions.
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional


def _utcnow() -> datetime:
    """Naive UTC now. SQLite stores naive datetimes; we keep naive everywhere
    so comparisons work without tzinfo dance."""
    return datetime.now(timezone.utc).replace(tzinfo=None)

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import config
from .models import Account, Biller, Request, RequestStatus, Split, Transaction, TxnKind, TxnStatus, User


# ---- Errors -----------------------------------------------------------------
# Cap on N-way split recipients. Keeps the UI sane (chip-array fits in a
# modal) and prevents runaway Transaction fanout from a single pending split.
_MAX_SPLIT_RECIPIENTS = 8


def _publish_categorize(txn_id: int) -> None:
    """Best-effort fan-out of a categorize.requested event after a confirm.

    The categoriser is a background concern — if the EventBus is missing
    (tests), the loop is not running, or the publish itself fails, we
    MUST NOT raise into the engine. The txn is already committed; the
    user has already been told it succeeded.
    """
    try:
        import asyncio

        from .services.event_bus import get_bus

        bus = get_bus()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is None or not loop.is_running():
            return  # no live event loop — categoriser will catch up via DB
        loop.create_task(bus.publish("categorize.requested", {"txn_id": txn_id}))
    except Exception:
        # Categoriser must NEVER crash the engine.
        pass


class EngineError(Exception):
    code = "engine_error"


class InsufficientFunds(EngineError):
    code = "insufficient_funds"

    def __init__(self, balance: Decimal, amount: Decimal):
        super().__init__(
            f"Balance ৳{balance} is short of ৳{amount}."
        )
        self.balance = balance
        self.amount = amount


class UnknownUser(EngineError):
    code = "unknown_user"


class SelfTransfer(EngineError):
    code = "self_transfer"


class PendingExpired(EngineError):
    code = "pending_expired"


class PendingAlreadyResolved(EngineError):
    code = "pending_resolved"


class UnknownPending(EngineError):
    code = "unknown_pending"


class IdempotencyReplay(Exception):
    """Internal signal: caller wants to return the *original* outcome of an
    act() call instead of creating a new pending."""

    def __init__(self, txn: Transaction):
        self.txn = txn


# ---- Helpers ----------------------------------------------------------------
def _known_handles(session: Session) -> list[str]:
    return [h for (h,) in session.execute(select(User.handle)).all()]


def _known_billers(session: Session) -> list[str]:
    return [n for (n,) in session.execute(select(Biller.name)).all()]


def _get_user(session: Session, user_id: int) -> User:
    u = session.get(User, user_id)
    if u is None:
        raise UnknownUser(f"user_id={user_id}")
    return u


def _get_account(session: Session, user: User) -> Account:
    a = session.query(Account).filter_by(user_id=user.id).one()
    return a


# ---- Read-side helpers (no writes) -----------------------------------------
@dataclass(frozen=True)
class UserSnapshot:
    user_id: int
    handle: str
    display_name: str
    phone: str
    balance_bdt: Decimal


def snapshot(session: Session, user_id: int) -> UserSnapshot:
    u = _get_user(session, user_id)
    a = _get_account(session, u)
    return UserSnapshot(
        user_id=u.id,
        handle=u.handle,
        display_name=u.display_name,
        phone=u.phone,
        balance_bdt=a.balance_bdt,
    )


# ---- act() — create pending from resolved intent ----------------------------
def create_pending_send(
    session: Session,
    *,
    initiator_user_id: int,
    recipient_handle: str,
    amount: Decimal,
    idempotency_key: str,
    note: Optional[str] = None,
) -> Transaction:
    """Send money: initiator -> recipient."""
    return _create_pending(
        session,
        kind="send",
        initiator_user_id=initiator_user_id,
        recipient_handle=recipient_handle,
        amount=amount,
        idempotency_key=idempotency_key,
        note=note,
    )


def create_pending_request(
    session: Session,
    *,
    initiator_user_id: int,
    payer_handle: str,
    amount: Decimal,
    idempotency_key: str,
    note: Optional[str] = None,
) -> Request:
    """Request money: ask initiator_user_id asks payer_handle to send amount."""
    if idempotency_key:
        existing = _find_idempotent_request(session, initiator_user_id, idempotency_key)
        if existing:
            raise IdempotencyReplay_for_request(existing)
    payer = session.query(User).filter_by(handle=payer_handle).one_or_none()
    if payer is None:
        raise EngineError(f"unknown payer handle: {payer_handle}")
    if payer.id == initiator_user_id:
        raise SelfTransfer("can't request from yourself")
    req = Request(
        asker_user_id=initiator_user_id,
        payer_user_id=payer.id,
        idempotency_key=idempotency_key,
        amount_bdt=amount,
        note=note,
        status=RequestStatus.PENDING.value,
    )
    session.add(req)
    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        raise
    return req


class IdempotencyReplay_for_request(Exception):
    def __init__(self, req: Request):
        self.req = req


def _find_idempotent_request(
    session: Session, user_id: int, key: str
) -> Optional[Request]:
    return session.query(Request).filter_by(
        asker_user_id=user_id, idempotency_key=key
    ).one_or_none()


def create_pending_split(
    session: Session,
    *,
    initiator_user_id: int,
    recipient_handles: list[str],
    total_amount: Decimal,
    idempotency_key: str,
    note: Optional[str] = None,
) -> Split:
    """Equal split. Per-recipient = total / N (rounded to paisa)."""
    if len(recipient_handles) < 2:
        raise EngineError("split needs at least 2 recipients")
    if len(recipient_handles) > _MAX_SPLIT_RECIPIENTS:
        raise EngineError(
            f"split supports at most {_MAX_SPLIT_RECIPIENTS} recipients "
            f"(got {len(recipient_handles)})"
        )
    # Resolve all recipients first so we fail fast with a clear error.
    recipients = []
    for h in recipient_handles:
        u = session.query(User).filter_by(handle=h).one_or_none()
        if u is None:
            raise EngineError(f"unknown recipient: {h}")
        if u.id == initiator_user_id:
            raise SelfTransfer("split cannot include yourself")
        recipients.append(u)
    if total_amount <= 0:
        raise EngineError("split total must be positive")
    per = (total_amount / Decimal(len(recipients))).quantize(Decimal("0.01"))
    # Round-off accounting: push remainder to first recipient.
    diff = total_amount - per * len(recipients)
    # Balance check BEFORE writing any rows so we never create an orphaned
    # Split record when the initiator can't cover the amount.
    init_acct = (
        session.query(Account).filter_by(user_id=initiator_user_id).one()
    )
    if init_acct.balance_bdt < total_amount:
        raise InsufficientFunds(init_acct.balance_bdt, total_amount)
    sp = Split(
        initiator_account_id=init_acct.id,
        total_amount_bdt=total_amount,
        per_amount_bdt=per,
        recipients_json=json.dumps([u.id for u in recipients]),
        note=note,
    )
    session.add(sp)
    session.flush()
    # Create pending child transactions tied to the split.
    first = True
    for u in recipients:
        amt = per + (diff if first else Decimal("0.00"))
        first = False
        # Each child uses a derived idempotency key so re-running create_pending_split
        # for the same parent key still no-ops.
        child_key = f"{idempotency_key}:{u.id}"
        if _find_idempotent_txn(session, initiator_user_id, child_key):
            continue
        session.add(
            Transaction(
                idempotency_key=child_key,
                initiator_user_id=initiator_user_id,
                from_account_id=init_acct.id,
                to_account_id=u.account.id if u.account else None,
                amount_bdt=amt,
                kind="split_child",
                status=TxnStatus.PENDING.value,
                note=note,
                parent_split_id=sp.id,
                expires_at=_utcnow() + timedelta(seconds=config.PENDING_TTL_SECONDS),
            )
        )
    session.flush()
    return sp


def create_pending_bill(
    session: Session,
    *,
    initiator_user_id: int,
    biller_name: str,
    amount: Decimal,
    idempotency_key: str,
    note: Optional[str] = None,
) -> Transaction:
    biller = session.query(Biller).filter_by(name=biller_name).one_or_none()
    if biller is None:
        raise EngineError(f"unknown biller: {biller_name}")
    init_acct = _get_account(session, _get_user(session, initiator_user_id))
    if init_acct.balance_bdt < amount:
        raise InsufficientFunds(init_acct.balance_bdt, amount)
    existing = _find_idempotent_txn(session, initiator_user_id, idempotency_key)
    if existing:
        raise IdempotencyReplay(existing)
    txn = Transaction(
        idempotency_key=idempotency_key,
        initiator_user_id=initiator_user_id,
        from_account_id=init_acct.id,
        to_account_id=None,
        biller_id=biller.id,
        amount_bdt=amount,
        kind="bill",
        status=TxnStatus.PENDING.value,
        note=note,
        expires_at=_utcnow() + timedelta(seconds=config.PENDING_TTL_SECONDS),
    )
    session.add(txn)
    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        existing = _find_idempotent_txn(session, initiator_user_id, idempotency_key)
        if existing:
            raise IdempotencyReplay(existing)
        raise
    return txn


def _create_pending(
    session: Session,
    *,
    kind: str,
    initiator_user_id: int,
    recipient_handle: str,
    amount: Decimal,
    idempotency_key: str,
    note: Optional[str],
) -> Transaction:
    recipient = session.query(User).filter_by(handle=recipient_handle).one_or_none()
    if recipient is None:
        raise EngineError(f"unknown recipient: {recipient_handle}")
    if recipient.id == initiator_user_id:
        raise SelfTransfer("can't send to yourself")
    init_acct = _get_account(session, _get_user(session, initiator_user_id))
    if init_acct.balance_bdt < amount:
        raise InsufficientFunds(init_acct.balance_bdt, amount)
    existing = _find_idempotent_txn(session, initiator_user_id, idempotency_key)
    if existing:
        raise IdempotencyReplay(existing)
    txn = Transaction(
        idempotency_key=idempotency_key,
        initiator_user_id=initiator_user_id,
        from_account_id=init_acct.id,
        to_account_id=recipient.account.id if recipient.account else None,
        amount_bdt=amount,
        kind=kind,
        status=TxnStatus.PENDING.value,
        note=note,
        expires_at=_utcnow() + timedelta(seconds=config.PENDING_TTL_SECONDS),
    )
    session.add(txn)
    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        existing = _find_idempotent_txn(session, initiator_user_id, idempotency_key)
        if existing:
            raise IdempotencyReplay(existing)
        raise
    return txn


def _find_idempotent_txn(
    session: Session, user_id: int, key: str
) -> Optional[Transaction]:
    return (
        session.query(Transaction)
        .filter_by(initiator_user_id=user_id, idempotency_key=key)
        .one_or_none()
    )


# ---- confirm / cancel -------------------------------------------------------
def confirm(session: Session, *, user_id: int, pending_id: int) -> Transaction:
    """Execute a pending transaction. Atomic debit/credit.

    Caller MUST hold an active transaction (we add begin_nested)."""
    txn = session.get(Transaction, pending_id)
    if txn is None:
        raise UnknownPending(f"pending_id={pending_id}")
    if txn.initiator_user_id != user_id:
        raise UnknownPending("not your transaction")
    if txn.status != TxnStatus.PENDING.value:
        raise PendingAlreadyResolved(f"status={txn.status}")
    if txn.expires_at and txn.expires_at < _utcnow():
        txn.status = TxnStatus.CANCELLED.value
        session.flush()
        raise PendingExpired("expired before confirm")
    _execute(session, txn)
    return txn


def confirm_split(session: Session, *, user_id: int, pending_id: int) -> Transaction:
    """Confirm every pending child of a split as one database operation."""
    first = session.get(Transaction, pending_id)
    if first is None or first.parent_split_id is None:
        return confirm(session, user_id=user_id, pending_id=pending_id)
    if first.initiator_user_id != user_id:
        raise UnknownPending("not your split")
    children = (
        session.query(Transaction)
        .filter_by(parent_split_id=first.parent_split_id)
        .order_by(Transaction.id.asc())
        .with_for_update()
        .all()
    )
    for child in children:
        if child.status == TxnStatus.PENDING.value:
            if child.expires_at and child.expires_at < _utcnow():
                child.status = TxnStatus.CANCELLED.value
                session.flush()
                raise PendingExpired("split expired before confirm")
            _execute(session, child)
        elif child.status != TxnStatus.COMPLETED.value:
            raise PendingAlreadyResolved(f"status={child.status}")
    return first


def decline(session: Session, *, user_id: int, pending_id: int) -> Transaction:
    """Cancel a single pending transaction or all children of a split.

    No cross-call to decline_split: we detect parent_split_id here and
    delegate directly to avoid the mutual recursion that caused stack
    overflows in the original code.
    """
    txn = session.get(Transaction, pending_id)
    if txn is None:
        raise UnknownPending(f"pending_id={pending_id}")
    if txn.initiator_user_id != user_id:
        raise UnknownPending("not your transaction")
    if txn.status != TxnStatus.PENDING.value:
        raise PendingAlreadyResolved(f"status={txn.status}")
    if txn.parent_split_id is not None:
        # Inline the split-cancellation logic here instead of calling
        # decline_split() to prevent mutual recursion.
        children = (
            session.query(Transaction)
            .filter_by(parent_split_id=txn.parent_split_id)
            .order_by(Transaction.id.asc())
            .all()
        )
        for child in children:
            if child.status == TxnStatus.PENDING.value:
                child.status = TxnStatus.CANCELLED.value
            elif child.status != TxnStatus.CANCELLED.value:
                raise PendingAlreadyResolved(f"status={child.status}")
        session.flush()
        return txn
    txn.status = TxnStatus.CANCELLED.value
    session.flush()
    return txn


def decline_split(session: Session, *, user_id: int, pending_id: int) -> Transaction:
    """Cancel all pending children of a split transaction.

    If `pending_id` turns out to not be a split child, cancels it as a plain
    transaction. Does NOT call decline() to avoid mutual recursion.
    """
    first = session.get(Transaction, pending_id)
    if first is None:
        raise UnknownPending(f"pending_id={pending_id}")
    if first.initiator_user_id != user_id:
        raise UnknownPending("not your split")
    if first.parent_split_id is None:
        # Not a split child — cancel it as a plain transaction inline.
        if first.status != TxnStatus.PENDING.value:
            raise PendingAlreadyResolved(f"status={first.status}")
        first.status = TxnStatus.CANCELLED.value
        session.flush()
        return first
    children = (
        session.query(Transaction)
        .filter_by(parent_split_id=first.parent_split_id)
        .order_by(Transaction.id.asc())
        .all()
    )
    for child in children:
        if child.status == TxnStatus.PENDING.value:
            child.status = TxnStatus.CANCELLED.value
        elif child.status != TxnStatus.CANCELLED.value:
            raise PendingAlreadyResolved(f"status={child.status}")
    session.flush()
    return first


def _execute(session: Session, txn: Transaction) -> None:
    """Apply a pending transaction. Must be called inside an open txn."""
    if txn.kind in (TxnKind.SEND.value, TxnKind.SPLIT_CHILD.value):
        if txn.from_account_id is None or txn.to_account_id is None:
            raise EngineError("malformed txn: missing accounts")
        src = session.get(Account, txn.from_account_id)
        dst = session.get(Account, txn.to_account_id)
        if src is None or dst is None:
            raise EngineError("account vanished mid-transaction")
        if src.balance_bdt < txn.amount_bdt:
            # Shouldn't happen (balance was checked at create_pending) but
            # defensive: another path may have drained the account in between.
            raise InsufficientFunds(src.balance_bdt, txn.amount_bdt)
        src.balance_bdt = src.balance_bdt - txn.amount_bdt
        dst.balance_bdt = dst.balance_bdt + txn.amount_bdt
    elif txn.kind == TxnKind.BILL.value:
        src = session.get(Account, txn.from_account_id)
        if src is None:
            raise EngineError("account vanished mid-transaction")
        if src.balance_bdt < txn.amount_bdt:
            raise InsufficientFunds(src.balance_bdt, txn.amount_bdt)
        src.balance_bdt = src.balance_bdt - txn.amount_bdt
    elif txn.kind == TxnKind.SAVINGS.value:
        # Savings contributions bypass _execute() (balances updated inline in
        # the accounts router). If _execute() is ever called on a savings txn
        # it means it was incorrectly put into the pending flow — raise clearly
        # rather than silently applying a double-debit.
        raise EngineError(
            f"savings transactions are not executed via confirm(); "
            f"txn_id={txn.id} was never pending"
        )
    else:
        raise EngineError(f"unknown kind: {txn.kind}")
    txn.status = TxnStatus.COMPLETED.value
    txn.completed_at = _utcnow()
    session.flush()
    # Fan-out a categorize.requested event so the background worker can
    # write a TxnTag row. Fire-and-forget — categoriser is not on the
    # money-move critical path.
    _publish_categorize(txn.id)


# ---- Pay a request ---------------------------------------------------------
def pay_request(
    session: Session,
    *,
    payer_user_id: int,
    request_id: int,
    idempotency_key: str,
) -> Transaction:
    """Payer honors a request. Creates a send transaction and links it.

    The transaction is created with status=COMPLETED and balances are updated
    inline. It must NEVER be passed to confirm() — it was never pending.
    Guard: if a linked transaction already exists we return it idempotently
    rather than charging twice.
    """
    req = session.get(Request, request_id)
    if req is None:
        raise EngineError(f"request_id={request_id}")
    if req.payer_user_id != payer_user_id:
        raise EngineError("not your request to pay")
    if req.status == RequestStatus.PAID.value:
        # Idempotent replay: return the already-created transaction.
        if req.linked_txn_id is not None:
            existing_txn = session.get(Transaction, req.linked_txn_id)
            if existing_txn is not None:
                return existing_txn
        raise EngineError("request already paid")
    if req.status != RequestStatus.PENDING.value:
        raise EngineError(f"request status={req.status}")
    payer = _get_user(session, payer_user_id)
    asker = _get_user(session, req.asker_user_id)
    payer_acct = _get_account(session, payer)
    asker_acct = _get_account(session, asker)
    if payer_acct.balance_bdt < req.amount_bdt:
        raise InsufficientFunds(payer_acct.balance_bdt, req.amount_bdt)
    # Check for an existing transaction with this idempotency key before
    # creating a new one to prevent duplicate charges on retried requests.
    full_key = f"reqpay:{idempotency_key}"
    existing = _find_idempotent_txn(session, payer_user_id, full_key)
    if existing is not None:
        return existing
    txn = Transaction(
        idempotency_key=full_key,
        initiator_user_id=payer_user_id,
        from_account_id=payer_acct.id,
        to_account_id=asker_acct.id,
        amount_bdt=req.amount_bdt,
        kind=TxnKind.SEND.value,
        status=TxnStatus.COMPLETED.value,
        note=req.note,
        completed_at=_utcnow(),
    )
    session.add(txn)
    session.flush()  # populate txn.id
    payer_acct.balance_bdt -= req.amount_bdt
    asker_acct.balance_bdt += req.amount_bdt
    req.status = RequestStatus.PAID.value
    req.linked_txn_id = txn.id
    req.resolved_at = _utcnow()
    session.flush()
    # The pay_request path does NOT go through _execute (the txn was never
    # pending), so we publish here explicitly for categorization.
    _publish_categorize(txn.id)
    return txn


def decline_request(session: Session, *, user_id: int, request_id: int) -> Request:
    req = session.get(Request, request_id)
    if req is None:
        raise EngineError(f"request_id={request_id}")
    if req.payer_user_id != user_id:
        raise EngineError("not your request to decline")
    if req.status != RequestStatus.PENDING.value:
        raise EngineError(f"request status={req.status}")
    req.status = RequestStatus.DECLINED.value
    req.resolved_at = _utcnow()
    session.flush()
    return req


# ---- TTL sweeper (background) ----------------------------------------------
class Sweeper:
    """Periodically mark expired pending transactions as cancelled."""

    def __init__(self, session_factory, interval_seconds: int):
        self._session_factory = session_factory
        self._interval = interval_seconds
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="txn-sweeper")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception as e:  # noqa: BLE001
                # Sweeper must never crash the process.
                print(f"[sweeper] tick error: {e!r}")
            self._stop.wait(self._interval)

    def _tick(self) -> None:
        with self._session_factory() as s:
            now = _utcnow()
            expired = (
                s.query(Transaction)
                .filter(
                    Transaction.status == TxnStatus.PENDING.value,
                    Transaction.expires_at.isnot(None),
                    Transaction.expires_at < now,
                )
                .all()
            )
            for t in expired:
                t.status = TxnStatus.CANCELLED.value
            s.commit()
            if expired:
                print(f"[sweeper] cancelled {len(expired)} expired pending txns")


# Singleton (started by app lifespan).
_sweeper: Optional[Sweeper] = None


def start_sweeper(session_factory) -> Sweeper:
    global _sweeper
    if _sweeper is None:
        _sweeper = Sweeper(session_factory, config.SWEEPER_INTERVAL_SECONDS)
        _sweeper.start()
    return _sweeper


def stop_sweeper() -> None:
    global _sweeper
    if _sweeper is not None:
        _sweeper.stop()
        _sweeper = None


# ---- Convenience re-exports -------------------------------------------------
known_handles = _known_handles
known_billers = _known_billers