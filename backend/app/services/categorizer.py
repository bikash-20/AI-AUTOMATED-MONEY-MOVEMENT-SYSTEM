"""Transaction categorizer.

Pure-deterministic rules first; LLM fallback only when reachable;
returns None on ambiguity. NEVER used for user-facing phrased text —
factual replies must continue to flow through the templated
`_deterministic_phrase` path so the AI cannot fabricate numbers.

The categorizer is invoked by the categorizer worker via the EventBus
after a successful `_execute()`. It writes a `TxnTag` row tagged
source='auto' (rules) or 'llm' (model).

Tag slugs are short, machine-friendly identifiers from a controlled
list. We do NOT save free-form LLM text into the tag column — only
slugs from `_KNOWN_TAGS`.
"""
from __future__ import annotations

import re
from typing import Optional

# Short, machine-friendly. Lower-case, kebab-friendly, ASCII only.
# Anything here is safe to insert into a UNIQUE constraint and to
# accumulate in /insights/by-category GROUP BY.
_KNOWN_TAGS: set[str] = {
    "food",
    "transport",
    "utilities",
    "shopping",
    "rent",
    "health",
    "education",
    "entertainment",
    "savings",
    "transfer",
    "request",
    "bill",
    "other",
}


# Maps (regex on lowercased note) -> tag slug. First match wins.
# Order matters: more specific patterns first.
_RULES: list[tuple[re.Pattern[str], str]] = [
    # food (Bangla + English slang)
    (re.compile(r"\b(chai|cha|tea|coffee|khaddo|khawa|biryani|burger|pizza|lunch|dinner|breakfast|restaurant|hotel|cafe)\b"), "food"),
    # transport
    (re.compile(r"\b(uber|pathao|ola|taxi|cng|rickshaw|bus|train|flight|air|metro|fuel|petrol|gas|rickshaw)\b"), "transport"),
    # utilities
    (re.compile(r"\b(internet|broadband|wifi|electricity|power|gas\b|water|utility|desco|dpdc|isp|wasa)\b"), "utilities"),
    # rent
    (re.compile(r"\b(rent|basha|house|flat|apartment|বাড়ি|বাসা)\b"), "rent"),
    # shopping
    (re.compile(r"\b(shopping|amazon|dhaka|daraz|clothes|shoe|shirt|store|mart)\b"), "shopping"),
    # health
    (re.compile(r"\b(doctor|hospital|medicine|pharmacy|clinic|apollo|square|health)\b"), "health"),
    # education
    (re.compile(r"\b(school|college|university|tuition|book|course|exam|class)\b"), "education"),
    # entertainment
    (re.compile(r"\b(movie|cinema|netflix|spotify|game|concert|show)\b"), "entertainment"),
    # bill payment (when the txn is a 'bill' kind, regardless of note)
    (re.compile(r".*"), "bill"),  # sentinel — never reached; handled outside rules
    # savings
    (re.compile(r"\b(saving|goal|festival|eid|puja|pohela|valentine)\b"), "savings"),
    # explicit transfers / requests
    (re.compile(r"\b(send|transfer|request)\b"), "transfer"),
]


_BANGLA_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")


def _normalize_note(note: Optional[str]) -> str:
    """Lowercase, collapse spaces, strip Bangla digits. Defensive against
    STT artifacts in the note text."""
    if not note:
        return ""
    s = note.strip().lower()
    s = s.translate(_BANGLA_DIGITS)
    s = re.sub(r"\s+", " ", s)
    return s


def categorize_by_rules(kind: str, note: Optional[str]) -> Optional[str]:
    """Return a tag slug for a transaction, or None if rules can't decide.

    The `kind` field (send, bill, split_child, savings) is informational:
    - `kind=bill` → always returns 'bill'
    - otherwise → match `note` against the rules table
    """
    if kind == "bill":
        return "bill"
    if not note:
        return None
    norm = _normalize_note(note)
    if not norm:
        return None
    for pattern, tag in _RULES:
        # Last entry is the bill sentinel — it always matches; we don't
        # want it to shadow real matches, so skip it during the loop and
        # only fall back to it after the iteration completes without hits.
        if tag == "bill":
            continue
        if pattern.search(norm):
            return tag
    return None


def is_known_tag(slug: str) -> bool:
    return slug in _KNOWN_TAGS


def known_tags() -> list[str]:
    return sorted(_KNOWN_TAGS)


# ---- Optional LLM fallback --------------------------------------------------
def categorize_with_llm(kind: str, note: Optional[str]) -> Optional[str]:
    """Best-effort LLM fallback. Returns a slug from `_KNOWN_TAGS` or None.

    This is intentionally minimal:
      - 2.0s timeout (categorization is a background job, not user-facing)
      - No retry
      - Always validates the slug against `_KNOWN_TAGS` before returning;
        anything else is rejected as None. We never persist model
        free-form text into a tag.

    If the local cascade is unreachable AND no OpenRouter key is set,
    we silently return None — the rules path is good enough that we'll
    just mark the txn as untagged for human review later.
    """
    if not note:
        return None
    try:
        from .. import config, llm  # local import to avoid circular at import
    except Exception:
        return None
    if not (config.LLM_CASCADE or (config.OPENROUTER_API_KEY or "").strip()):
        return None

    system = (
        "You are a strict transaction categorizer. "
        "Reply with ONLY one of these slug words, nothing else: "
        + ", ".join(sorted(_KNOWN_TAGS)) +
        ". If unsure, reply 'unknown'."
    )
    user = (
        f"Transaction kind: {kind}\n"
        f"Note: {note!r}\n"
        f"Pick exactly one slug."
    )
    try:
        raw = llm._collect(system, user).strip().strip('"').strip("`").strip().lower()
    except Exception:
        return None
    if raw in _KNOWN_TAGS:
        return raw
    # Tolerate slight wrapping: e.g. "the answer is food" -> take last word.
    for word in reversed(raw.split()):
        word = word.strip(".,:;!?`'\"")
        if word in _KNOWN_TAGS:
            return word
    return None


def categorize(kind: str, note: Optional[str]) -> tuple[Optional[str], str]:
    """Decide the tag and its source. Returns (slug, source) or (None, 'none').

    `source` is one of: 'auto' (rules), 'llm' (model fallback), 'none'.
    """
    tag = categorize_by_rules(kind, note)
    if tag is not None:
        return tag, "auto"
    tag = categorize_with_llm(kind, note)
    if tag is not None:
        return tag, "llm"
    return None, "none"
