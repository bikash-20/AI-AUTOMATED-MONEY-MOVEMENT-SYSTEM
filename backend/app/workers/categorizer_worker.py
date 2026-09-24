"""Categorizer worker.

Consumes `categorize.requested` events from the EventBus, applies
`services.categorizer.categorize`, and writes a `TxnTag` row.

Runs as a single asyncio task started by the app lifespan and stopped
cleanly on shutdown. Idempotent via the `uq_txn_tag` UNIQUE constraint —
re-running the worker for the same txn is a no-op.

The worker writes its own short-lived session so categorisation is
independent of the originating request's transaction lifecycle. It
never raises back into the request path; any failure is logged.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy.exc import IntegrityError

from .. import config  # noqa: F401  (kept for future config-gated rate limits)
from ..db import session_scope
from ..models import Transaction, TxnStatus, TxnTag
from ..services.categorizer import categorize, is_known_tag
from ..services.event_bus import EventBus

log = logging.getLogger("wallet.categorizer")

CATEGORIZE_TOPIC = "categorize.requested"


async def _run_worker(bus: EventBus, stop_event: asyncio.Event) -> None:
    """Background consumer. Exits when `stop_event` is set."""
    log.info("categorizer worker: started")
    try:
        async for payload in bus.subscribe(CATEGORIZE_TOPIC):
            if stop_event.is_set():
                break
            try:
                await _handle(payload)
            except Exception as exc:  # noqa: BLE001
                # Categoriser must NEVER crash the worker.
                log.exception("categorizer worker: failed %r", exc)
    finally:
        log.info("categorizer worker: stopped")


async def _handle(payload: dict[str, Any]) -> None:
    """Process one categorize.requested event. Synchronous DB work is
    offloaded via `asyncio.to_thread` so the worker doesn't block the
    event loop."""
    txn_id = payload.get("txn_id")
    if not isinstance(txn_id, int):
        return
    await asyncio.to_thread(_apply_to_txn, txn_id)


def _apply_to_txn(txn_id: int) -> None:
    """Read the txn, decide a tag, write it. Idempotent."""
    with session_scope() as s:
        txn = s.get(Transaction, txn_id)
        if txn is None:
            log.debug("categorizer: txn %s gone (race)", txn_id)
            return
        # Only categorise completed send/bill/savings txns. Pending
        # rows haven't actually moved money — wait until they're
        # confirmed. (This also avoids tagging cancelled rows.)
        if txn.status != TxnStatus.COMPLETED.value:
            return
        # Resolve the relevant user_id for "by_user_id" attribution.
        # For sends/splits the initiator is the spender; for bills the
        # initiator is the payer. We just use initiator_user_id since
        # the tag is "this was a spend by user X" — accurate in all
        # current kinds.
        by_user_id = txn.initiator_user_id
        tag, source = categorize(txn.kind, txn.note)
        if tag is None or not is_known_tag(tag):
            return
        # UNIQUE(txn_id, tag_slug) makes this safe to retry.
        s.add(
            TxnTag(
                txn_id=txn_id,
                tag_slug=tag,
                source=source,
                by_user_id=by_user_id,
            )
        )
        try:
            s.flush()
        except IntegrityError:
            # Already tagged by a previous worker run — fine.
            s.rollback()


# ---- Public lifecycle --------------------------------------------------------
class CategorizerWorker:
    """Owns the asyncio task + stop event. Singleton per process."""

    def __init__(self, bus: EventBus) -> None:
        self._bus = bus
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(_run_worker(self._bus, self._stop), name="categorizer-worker")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=2.0)
            except asyncio.TimeoutError:
                self._task.cancel()
            finally:
                self._task = None


_worker: CategorizerWorker | None = None


def start_categorizer(bus: EventBus | None = None) -> CategorizerWorker:
    global _worker
    if _worker is not None:
        return _worker
    from ..services.event_bus import get_bus

    _worker = CategorizerWorker(bus or get_bus())
    _worker.start()
    return _worker


async def stop_categorizer() -> None:
    global _worker
    if _worker is not None:
        await _worker.stop()
        _worker = None
