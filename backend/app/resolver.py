"""Recipient resolution + amount parsing.

Deterministic. No LLM. Failure modes return structured errors that the agent
turns into a phrased response.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Optional


@dataclass(frozen=True)
class AmbiguousMatch:
    candidates: list[str]
    score: int  # smaller = closer


# ---- Levenshtein distance ---------------------------------------------------
def levenshtein(a: str, b: str) -> int:
    """Standard DP. O(len(a) * len(b)). Fine for ~6 handles."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(
                cur[-1] + 1,        # insert
                prev[j] + 1,        # delete
                prev[j - 1] + (ca != cb),  # substitute
            ))
        prev = cur
    return prev[-1]


def _normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


# ---- Recipient resolution ---------------------------------------------------
class ResolutionError(Exception):
    """Base for all resolver failures."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class UnknownRecipient(ResolutionError):
    pass


class AmbiguousRecipient(ResolutionError):
    def __init__(self, candidates: list[str]):
        super().__init__(
            "ambiguous_recipient",
            f"Did you mean one of: {', '.join(candidates)}?",
        )
        self.candidates = candidates


def resolve_recipient(
    raw: str,
    known_handles: list[str],
    threshold: int = 2,
) -> str:
    """Match `raw` to one of `known_handles`. Lowercases + collapses spaces.

    Algorithm:
      1. Exact (case-insensitive) match -> return.
      2. Compute Levenshtein distance to each handle.
      3. If the single closest is within `threshold` -> return it.
      4. If two candidates tie within 1 of each other -> AmbiguousRecipient.
      5. Otherwise -> UnknownRecipient.

    The threshold is intentionally tight (2) so "bikash" can never match
    "rishad" — they're distance 5 apart.
    """
    if not raw:
        raise UnknownRecipient("missing_recipient", "No recipient named.")
    needle = _normalize(raw)
    haystack = [(h, _normalize(h)) for h in known_handles]

    # Exact
    for orig, norm in haystack:
        if norm == needle:
            return orig

    # Fuzzy
    distances = sorted(
        ((levenshtein(needle, norm), orig) for orig, norm in haystack)
    )
    best_dist, best = distances[0]
    if best_dist <= threshold:
        return best

    # Within threshold but two close = ambiguous.
    if len(distances) >= 2 and distances[1][0] <= threshold and distances[1][0] <= best_dist + 1:
        candidates = [d[1] for d in distances if d[0] <= threshold]
        if candidates:
            raise AmbiguousRecipient(candidates[:3])

    raise UnknownRecipient(
        "unknown_recipient",
        f"I don't know anyone called '{raw}'. Try one of: {', '.join(known_handles)}.",
    )


def resolve_amount(raw: Optional[float | int | str]) -> Decimal:
    """Validate and convert. Rejects negative, zero, non-finite."""
    if raw is None:
        raise ResolutionError("missing_amount", "How much?")
    try:
        v = Decimal(str(raw))
    except (InvalidOperation, ValueError):
        raise ResolutionError("bad_amount", f"'{raw}' isn't a number.")
    if not v.is_finite():
        raise ResolutionError("bad_amount", "Amount must be finite.")
    if v <= 0:
        raise ResolutionError("bad_amount", "Amount must be positive.")
    # Round to 2dp (BDT subdivision).
    return v.quantize(Decimal("0.01"))


def resolve_biller(raw: str, known: list[str]) -> str:
    if not raw:
        raise ResolutionError("missing_biller", "Which biller?")
    needle = _normalize(raw)
    # Exact first
    for k in known:
        if _normalize(k) == needle:
            return k
    # Fuzzy with looser threshold (billers are short words).
    distances = sorted((levenshtein(needle, _normalize(k)), k) for k in known)
    best, _ = distances[0]
    if best <= 3:
        return distances[0][1]
    raise ResolutionError(
        "unknown_biller",
        f"No biller called '{raw}'. Try one of: {', '.join(known)}.",
    )
