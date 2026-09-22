"""LLM cascade for intent parsing and phrasing.

Mirrors the pattern from ~/python/AI ENGINEERING/llm.py — empty responses
trigger fallthrough. No write access here; this module only reads via the
phraser facts passed in by the router.

Resilience: when every local Ollama slot fails AND no OpenRouter key is
configured, `parse_intent` falls through to a deterministic regex parser so
the demo never dead-ends. The phraser also has a deterministic fallback.
"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Iterator, Optional

import httpx

from . import config


# ---- Local Ollama slot ------------------------------------------------------
def _stream_ollama(model: str, system: str, user: str) -> Iterator[str]:
    """Stream a single chat completion from local Ollama."""
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": True,
        "options": {"temperature": 0.0},
    }
    with httpx.stream(
        "POST",
        f"{config.OLLAMA_URL}/api/chat",
        json=payload,
        timeout=10.0,
    ) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line:
                continue
            try:
                j = json.loads(line)
            except json.JSONDecodeError:
                continue
            content = (j.get("message") or {}).get("content") or ""
            if content:
                yield content
            if j.get("done"):
                break


# ---- OpenRouter (cloud) slot ------------------------------------------------
def _stream_openrouter(model: str, system: str, user: str) -> Iterator[str]:
    """Stream a chat completion via OpenRouter (OpenAI-compatible)."""
    api_key = (config.OPENROUTER_API_KEY or "").strip()
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY not set")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": True,
        "temperature": 0.0,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://wallet.local",
        "X-Title": "Wallet Demo",
    }
    with httpx.stream(
        "POST",
        f"{config.OPENROUTER_URL}/chat/completions",
        json=payload,
        headers=headers,
        timeout=30.0,
    ) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line or not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                j = json.loads(data)
            except json.JSONDecodeError:
                continue
            delta = (j.get("choices") or [{}])[0].get("delta") or {}
            content = delta.get("content") or ""
            if content:
                yield content


# ---- Cascade orchestration --------------------------------------------------
def _local_slot_iter(model: str):
    """Yield (slot_label, iterator) tuples for local cascade."""
    return ("ollama:" + model, _stream_ollama(model, system="", user=""))


def _collect_with_fallback(
    system: str,
    user: str,
    *,
    primary: list[tuple[str, callable]],
) -> Optional[str]:
    """Try `primary` cascade; if all fail, try OpenRouter if configured.
    Returns the first non-empty response, or None."""
    last_err: Optional[Exception] = None

    for label, fn in primary:
        try:
            chunks = list(fn(label.split(":", 1)[1], system, user))
            text = "".join(chunks).strip()
            if text:
                return text
            sys.stderr.write(f"[llm] {label} returned empty — falling through\n")
            sys.stderr.flush()
        except Exception as e:
            last_err = e
            sys.stderr.write(f"[llm] {label} failed: {type(e).__name__}: {e}\n")
            sys.stderr.flush()

    # OpenRouter fallback (free models) — only if a key is configured.
    if (config.OPENROUTER_API_KEY or "").strip():
        for model in config.OPENROUTER_MODELS:
            try:
                chunks = list(_stream_openrouter(model, system, user))
                text = "".join(chunks).strip()
                if text:
                    return text
                sys.stderr.write(f"[llm] openrouter:{model} empty — falling through\n")
                sys.stderr.flush()
            except Exception as e:
                last_err = e
                sys.stderr.write(f"[llm] openrouter:{model} failed: {type(e).__name__}: {e}\n")
                sys.stderr.flush()

    if last_err is not None:
        sys.stderr.write(f"[llm] all slots failed: {last_err}\n")
    return None


def _ollama_cascade() -> list[tuple[str, callable]]:
    return [
        ("ollama:" + m, lambda model, sys_, usr, _m=m: _stream_ollama(_m, sys_, usr))
        for m in config.LLM_CASCADE
    ]


def _collect(system: str, user: str) -> str:
    """Backwards-compatible wrapper: returns empty string if cascade fails."""
    out = _collect_with_fallback(system, user, primary=_ollama_cascade())
    return out or ""


# ---- Intent parser ----------------------------------------------------------
def parse_intent(
    text: str,
    known_handles: list[str],
    known_billers: list[str],
) -> dict:
    """Run the cascade and parse the response as JSON.

    Falls through to a regex-based parser when the LLM cascade returns
    nothing — so the demo stays alive even if every LLM slot is down.
    """
    user = (
        f"User said: {text!r}\n\n"
        f"Known handles (recipient names): {known_handles}\n"
        f"Known billers: {known_billers}\n\n"
        "Respond with ONLY the JSON object, nothing else."
    )
    raw = _collect(config.INTENT_SYSTEM_PROMPT, user)
    if raw:
        parsed = _parse_json_lenient(raw)
        if parsed.get("action") not in (None, "unknown"):
            return parsed
    # LLM gave us nothing usable — try regex fallback.
    return _regex_intent(text, known_handles, known_billers)


# ---- Regex fallback ---------------------------------------------------------
_BANGLA_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")

# Match common money patterns: 500, 500 taka, ৳500, 1,200, 1k, 2.5k
_AMOUNT_RE = re.compile(
    r"(?P<sym>৳|bdt|tk)?\s*"
    r"(?P<num>\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s*[kK]?)",
    re.IGNORECASE,
)

_K_SUFFIX_RE = re.compile(r"(\d+(?:\.\d+)?)\s*[kK]\b")

_GREETINGS = {
    "hi", "hello", "hey", "yo", "sup", "howdy",
    "good morning", "good evening", "good afternoon",
    "salam", "assalamu alaikum", "asalam", "adaab",
    "নমস্কার",
}

_THANKS = {"thanks", "thank you", "thx", "ty", "জাজ"}
_BYE = {"bye", "goodbye", "see you", "see ya", "আসসালামু"}

_BALANCE_TOKENS = {
    "balance", "bal", "মিউ", "money left", "how much", "what's my balance",
    "how much money", "how much do i have", "amount", "funds",
}

_HISTORY_TOKENS = {
    "history", "transactions", "statement", "recent", "last", "past",
    "কী করেছি", "history list",
}

_REQUEST_TRIGGERS = {
    "ask", "request", "demand", "collect", "কর", "ধার", "চাই",
    "need", "want from",
}

_SEND_TRIGGERS = {
    "send", "transfer", "pay", "give", "transfer to",
    "পাঠাও", "পাঠাই", "পাঠাচ্ছি", "দাও", "দিই", "bhechhe", "pathao", "dao",
    "parbe", "পার্বে",
}

_SPLIT_TRIGGERS = {
    "split", "divide", "share", "ভাগ", "ভাগ কর", "ভাগাও",
}

_BILL_TRIGGERS = {
    "bill", "internet", "electricity", "wifi", "utility", "বিল",
}


def _normalize(text: str) -> str:
    s = text.strip().lower()
    s = s.translate(_BANGLA_DIGITS)
    # collapse multiple spaces
    s = re.sub(r"\s+", " ", s)
    return s


def _extract_amount(text: str) -> Optional[float]:
    """Find a money amount in the text. Handles 500, 1,200.50, 1k, ৳500."""
    t = _normalize(text)
    # k-suffix first (1k -> 1000)
    m = _K_SUFFIX_RE.search(t)
    if m:
        try:
            return float(m.group(1)) * 1000
        except ValueError:
            pass
    # Strip the ৳/bdt prefix when scanning for a number.
    candidates: list[float] = []
    for m in _AMOUNT_RE.finditer(t):
        num = m.group("num").replace(",", "").strip()
        if not num:
            continue
        try:
            candidates.append(float(num))
        except ValueError:
            continue
    if not candidates:
        return None
    # Prefer the largest candidate (in "send 500 to x" the 500 wins over
    # stray numbers).
    return max(candidates)


def _extract_recipient(text: str, known: list[str]) -> Optional[str]:
    """Find a known handle in the text. Tries longest-first."""
    t = _normalize(text)
    candidates = sorted(known, key=len, reverse=True)
    for h in candidates:
        if re.search(rf"\b{re.escape(h)}\b", t):
            return h
    return None


def _classify_action(text: str) -> str:
    t = _normalize(text)
    # greetings first (very short, no numbers)
    if len(t.split()) <= 6:
        for g in _GREETINGS:
            if t == g or t.startswith(g + " "):
                return "greeting"
    if any(t.startswith(k) or k in t for k in _THANKS):
        return "thanks"
    if any(k in t for k in _BYE):
        return "bye"
    if any(k in t for k in _BALANCE_TOKENS):
        return "balance"
    if any(k in t for k in _HISTORY_TOKENS):
        return "history"
    if any(k in t for k in _SPLIT_TRIGGERS):
        return "split"
    if any(k in t for k in _REQUEST_TRIGGERS):
        return "request"
    if any(k in t for k in _BILL_TRIGGERS):
        return "pay_bill"
    if any(k in t for k in _SEND_TRIGGERS):
        return "send"
    return "unknown"


def _regex_intent(text: str, known_handles: list[str], known_billers: list[str]) -> dict:
    """Deterministic fallback intent parser. Used when the LLM is unreachable."""
    action = _classify_action(text)
    amount = _extract_amount(text)
    recipient = _extract_recipient(text, known_handles) if known_handles else None

    if action == "send" or action == "request":
        return {
            "action": action,
            "amount": amount,
            "recipient": recipient,
            "biller": None,
            "split_recipients": [],
        }
    if action == "split":
        # For splits, look for all mentioned handles.
        t = _normalize(text)
        found = [h for h in known_handles if re.search(rf"\b{re.escape(h)}\b", t)]
        return {
            "action": "split",
            "amount": amount,
            "recipient": None,
            "biller": None,
            "split_recipients": found,
        }
    if action == "pay_bill":
        biller = None
        t = _normalize(text)
        for b in known_billers:
            if re.search(rf"\b{re.escape(b.lower())}\b", t):
                biller = b
                break
        return {
            "action": "pay_bill",
            "amount": amount,
            "recipient": None,
            "biller": biller,
            "split_recipients": [],
        }
    if action == "balance":
        return {"action": "balance", "amount": None, "recipient": None, "biller": None, "split_recipients": []}
    if action == "history":
        return {"action": "history", "amount": None, "recipient": None, "biller": None, "split_recipients": []}
    if action == "greeting":
        return {"action": "greeting", "amount": None, "recipient": None, "biller": None, "split_recipients": []}
    if action == "thanks":
        return {"action": "thanks", "amount": None, "recipient": None, "biller": None, "split_recipients": []}
    if action == "bye":
        return {"action": "bye", "amount": None, "recipient": None, "biller": None, "split_recipients": []}
    return {"action": "unknown", "amount": None, "recipient": None, "biller": None, "split_recipients": []}


def _parse_json_lenient(raw: str) -> dict:
    """Strip code fences, find the outermost {...}, parse it."""
    s = raw.strip()
    if s.startswith("```"):
        lines = s.split("\n")
        lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        s = "\n".join(lines).strip()
    start = s.find("{")
    end = s.rfind("}")
    if start != -1 and end != -1 and end > start:
        s = s[start:end + 1]
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        s2 = s.replace(",}", "}").replace(",]", "]")
        try:
            return json.loads(s2)
        except json.JSONDecodeError:
            return {"action": "unknown"}


# ---- Phraser ---------------------------------------------------------------
def phrase(text_kind: str, facts: dict) -> str:
    """Turn deterministic facts into a single natural sentence.

    Financial facts never go through the LLM: even a well-prompted model can
    round, omit, or invent a value. Casual text can still use the cascade.
    """
    if text_kind in _FACTUAL_PHRASE_KINDS:
        return _deterministic_phrase(text_kind, facts)
    system = config.PHRASER_SYSTEM_PROMPT
    user = json.dumps({"kind": text_kind, **facts})
    try:
        out = _collect(system, user).strip()
        out = out.strip().strip('"').strip("`")
        if out:
            return out
    except Exception as e:
        sys.stderr.write(f"[phrase] fallback: {e!r}\n")
    return _deterministic_phrase(text_kind, facts)


# ---- Chat (conversational) -------------------------------------------------
def chat_reply(text: str, user_handle: str) -> str:
    """Conversational reply for greetings / small talk.

    Uses the LLM cascade if available; falls back to deterministic templates
    so the system always replies.
    """
    system = (
        "You are Wallet Assistant — concise, friendly, BD-flavored. "
        "Address the user as 'Boss' when natural. Keep replies short (1-2 sentences). "
        "You can also answer simple questions about balances or transaction history. "
        "Reply with ONLY the sentence, no quotes, no markdown."
    )
    user = f"User ({user_handle}) said: {text}"
    try:
        out = _collect(system, user).strip()
        out = out.strip().strip('"').strip("`")
        if out:
            return out
    except Exception as e:
        sys.stderr.write(f"[chat] fallback: {e!r}\n")
    return _deterministic_chat(text, user_handle)


_FACTUAL_PHRASE_KINDS = {
    "review_send",
    "review_split",
    "review_bill",
    "executed_send",
    "executed_split",
    "executed_bill",
    "cancelled",
    "insufficient_funds",
    "ambiguous_recipient",
    "unknown_recipient",
    "balance",
    "history_summary",
    "request_created",
    "request_paid",
    "request_declined",
}


_GREETING_REPLIES = [
    "Hey Boss! Ready to move some money?",
    "Hi Boss — say the word and we'll send it.",
    "Hello Boss. Want to send, request, or check your balance?",
    "Hey! I'm here. Try 'send 500 to rishad' or 'what's my balance'.",
    "Salam Boss. What's the plan today?",
]

_THANKS_REPLIES = [
    "Anytime Boss.",
    "No problem. Just say the word.",
    "You're welcome, Boss.",
    "Glad to help.",
]

_BYE_REPLIES = [
    "Catch you later, Boss.",
    "Bye. I'll be here.",
    "Take care, Boss.",
]

_BALANCE_HINTS = [
    "Say 'what's my balance' and I'll pull it up.",
    "Want a balance check? Just ask.",
]


def _deterministic_chat(text: str, user_handle: str) -> str:
    t = _normalize(text)
    if any(k in t for k in ("how are you", "how's it going", "how is it going", "what's up")):
        return "Doing well, Boss. I'm ready whenever you are."
    if any(g in t for g in _GREETINGS):
        return _GREETING_REPLIES[0]
    if any(g in t for g in _THANKS):
        return _THANKS_REPLIES[0]
    if any(g in t for g in _BYE):
        return _BYE_REPLIES[0]
    if any(k in t for k in ("who are you", "what are you", "your name", "তুমি কে")):
        return (
            "I'm Wallet Assistant — a local demo that moves money between "
            "the 6 demo accounts. Talk to me or type what you want."
        )
    if any(k in t for k in ("help", "what can you do", "commands")):
        return (
            "I can send, request, split bills, pay utilities, and check "
            "your balance and history. Try 'send 500 to rishad'."
        )
    if any(k in t for k in _BALANCE_TOKENS):
        return _BALANCE_HINTS[0]
    # Generic fallback.
    return (
        "I heard you, Boss. Try a money command like 'send 500 to rishad' "
        "or ask 'what's my balance'."
    )


def _deterministic_phrase(text_kind: str, facts: dict) -> str:
    """Last-resort template so the demo never dead-ends."""
    if text_kind == "review_send":
        return (
            f"Send ৳{facts.get('amount_bdt')} to {facts.get('recipient')}? "
            f"New balance will be ৳{facts.get('resulting_balance_bdt')}."
        )
    if text_kind == "review_split":
        return (
            f"Split ৳{facts.get('total_amount_bdt')} across "
            f"{', '.join(facts.get('recipients', []))} "
            f"at ৳{facts.get('per_amount_bdt')} each? "
            f"New balance: ৳{facts.get('resulting_balance_bdt')}."
        )
    if text_kind == "review_bill":
        return (
            f"Pay ৳{facts.get('amount_bdt')} to {facts.get('biller')}? "
            f"New balance: ৳{facts.get('resulting_balance_bdt')}."
        )
    if text_kind == "executed_send":
        return (
            f"Done, Boss. Sent ৳{facts.get('amount_bdt')} to "
            f"{facts.get('recipient')}. "
            f"New balance: ৳{facts.get('new_balance_bdt')}."
        )
    if text_kind == "executed_split":
        return (
            f"Split done. ৳{facts.get('total_amount_bdt')} across "
            f"{len(facts.get('recipients', []))} people. "
            f"New balance: ৳{facts.get('new_balance_bdt')}."
        )
    if text_kind == "executed_bill":
        return (
            f"Bill paid: ৳{facts.get('amount_bdt')} to {facts.get('biller')}. "
            f"New balance: ৳{facts.get('new_balance_bdt')}."
        )
    if text_kind == "cancelled":
        return "Cancelled. No money moved."
    if text_kind == "insufficient_funds":
        return (
            f"Sorry Boss, your balance is ৳{facts.get('balance_bdt')} "
            f"— short of ৳{facts.get('amount_bdt')}."
        )
    if text_kind == "ambiguous_recipient":
        c = facts.get("candidates") or []
        return f"Did you mean one of: {', '.join(c)}?"
    if text_kind == "unknown_recipient":
        return (
            f"I don't know anyone called {facts.get('raw')!r}. "
            f"Try one of: {', '.join(facts.get('known') or [])}."
        )
    if text_kind == "balance":
        return f"Let me check, Boss — your current balance is ৳{facts.get('balance_bdt')}."
    if text_kind == "history_summary":
        n = facts.get("count", 0)
        return f"I checked your history, Boss. You have {n} recent transactions."
    if text_kind == "request_created":
        return (
            f"Request sent to {facts.get('payer')}: ৳{facts.get('amount_bdt')}. "
            f"They'll see it on their end."
        )
    if text_kind == "request_paid":
        return (
            f"Paid ৳{facts.get('amount_bdt')} to {facts.get('asker')}. "
            f"New balance: ৳{facts.get('new_balance_bdt')}."
        )
    if text_kind == "request_declined":
        return "Request declined."
    if text_kind == "rephrase":
        return "Sorry Boss, I didn't catch that. Could you rephrase?"
    return "Done."
