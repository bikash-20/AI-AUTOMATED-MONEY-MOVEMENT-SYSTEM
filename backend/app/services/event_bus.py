"""In-process async pub/sub.

Tiny bounded-queue pub/sub. Used by the categorizer worker (today) and
the SSE stream (later). Single-instance only — no cross-process
distribution. Per-topic subscribers each get their own `asyncio.Queue`.

Backpressure: when a subscriber's queue hits `maxsize`, the oldest
pending event is dropped and a `dropped_count` is bumped so tests can
assert no silent loss.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any, AsyncIterator


class EventBus:
    def __init__(self, *, default_maxsize: int = 1024) -> None:
        self._default_maxsize = default_maxsize
        self._subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._lock = asyncio.Lock()
        self.dropped_total: int = 0

    async def publish(self, topic: str, payload: Any) -> None:
        """Fan-out a payload to every subscriber of `topic`.

        Subscribers are addressed by *exact* topic match — there is no
        wildcard support by design (cheap to add when SSE lands).
        """
        async with self._lock:
            queues = list(self._subscribers.get(topic, ()))
        for q in queues:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                # Drop oldest, keep newest (live signal beats stale backlog).
                try:
                    q.get_nowait()
                    q.put_nowait(payload)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass
                self.dropped_total += 1

    async def subscribe(self, topic: str) -> AsyncIterator[Any]:
        """Async-iterate events on `topic` until the consumer cancels.

        Each `subscribe()` call gets a private queue — independent
        backpressure per consumer (the SSE stream and the categorizer
        worker can both listen without one starving the other).
        """
        q: asyncio.Queue = asyncio.Queue(maxsize=self._default_maxsize)
        async with self._lock:
            self._subscribers[topic].append(q)
        try:
            while True:
                yield await q.get()
        finally:
            async with self._lock:
                subs = self._subscribers.get(topic, [])
                if q in subs:
                    subs.remove(q)
                    if not subs:
                        self._subscribers.pop(topic, None)

    def subscriber_count(self, topic: str) -> int:
        return len(self._subscribers.get(topic, ()))


# Module singleton — started by the app lifespan. Tests build their own
# instance via `EventBus()` and inject it.
_bus: EventBus | None = None


def get_bus() -> EventBus:
    global _bus
    if _bus is None:
        _bus = EventBus()
    return _bus


def set_bus(bus: EventBus | None) -> None:
    """Replace or clear the global bus (test fixtures)."""
    global _bus
    _bus = bus
