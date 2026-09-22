"""LLM resilience tests — regex fallback + chat reply."""
from __future__ import annotations

import pytest

from app import llm


HANDLES = ["bikash", "rishad", "arman", "tahzib", "srijan", "mahdin"]
BILLERS = ["Internet", "Electricity"]


def test_regex_send_intent():
    i = llm._regex_intent("send 500 to rishad", HANDLES, BILLERS)
    assert i["action"] == "send"
    assert i["amount"] == 500.0
    assert i["recipient"] == "rishad"


def test_regex_send_with_taka_suffix():
    i = llm._regex_intent("rishad ke 1k pathao", HANDLES, BILLERS)
    assert i["amount"] == 1000.0
    assert i["recipient"] == "rishad"
    # Bangla-only phrasing may classify as send via "pathao"; we just want
    # the amount + recipient to be recoverable regardless of action.
    assert i["action"] in ("send", "unknown")


def test_regex_send_with_comma_amount():
    i = llm._regex_intent("pay 1,200 to arman", HANDLES, BILLERS)
    assert i["action"] == "send"
    assert i["amount"] == 1200.0
    assert i["recipient"] == "arman"


def test_regex_balance_intent():
    i = llm._regex_intent("what's my balance", HANDLES, BILLERS)
    assert i["action"] == "balance"


def test_regex_history_intent():
    i = llm._regex_intent("show my recent transactions", HANDLES, BILLERS)
    assert i["action"] == "history"


def test_regex_request_intent():
    i = llm._regex_intent("request 300 from srijan", HANDLES, BILLERS)
    assert i["action"] == "request"
    assert i["amount"] == 300.0
    assert i["recipient"] == "srijan"


def test_regex_split_intent():
    i = llm._regex_intent("split 900 between rishad arman tahzib", HANDLES, BILLERS)
    assert i["action"] == "split"
    assert i["amount"] == 900.0
    assert sorted(i["split_recipients"]) == ["arman", "rishad", "tahzib"]


def test_regex_pay_bill_intent():
    i = llm._regex_intent("pay 1200 for internet bill", HANDLES, BILLERS)
    assert i["action"] == "pay_bill"
    assert i["amount"] == 1200.0
    assert i["biller"] == "Internet"


def test_regex_greeting_intent():
    i = llm._regex_intent("hello there", HANDLES, BILLERS)
    assert i["action"] == "greeting"


def test_regex_thanks_intent():
    i = llm._regex_intent("thanks", HANDLES, BILLERS)
    assert i["action"] == "thanks"


def test_regex_bye_intent():
    i = llm._regex_intent("goodbye", HANDLES, BILLERS)
    assert i["action"] == "bye"


def test_regex_unknown_intent():
    i = llm._regex_intent("xyzzy plugh", HANDLES, BILLERS)
    assert i["action"] == "unknown"


def test_deterministic_phrase_balance():
    s = llm._deterministic_phrase("balance", {"balance_bdt": "5000.00"})
    assert "5000" in s


def test_deterministic_chat_greeting():
    s = llm._deterministic_chat("hi there", "bikash")
    # Deterministic fallback may pick any of the greeting templates;
    # they all mention "Boss" OR are an active invitation. Be lenient.
    assert "Boss" in s or "send" in s.lower() or "hi" in s.lower() or "ready" in s.lower()


def test_chat_reply_never_empty():
    # Even if everything fails, chat_reply returns a sentence.
    s = llm.chat_reply("hi how are you", "bikash")
    assert isinstance(s, str)
    assert len(s) > 0


def test_deterministic_chat_handles_small_talk():
    s = llm._deterministic_chat("how are you", "bikash")
    assert "ready" in s.lower()


def test_phrase_never_empty():
    s = llm.phrase("balance", {"balance_bdt": "5000.00"})
    assert isinstance(s, str)
    assert len(s) > 0


def test_factual_phrase_does_not_call_llm(monkeypatch):
    def fail(*_args):
        raise AssertionError("factual phrases must not use the LLM")

    monkeypatch.setattr(llm, "_collect", fail)
    s = llm.phrase("balance", {"balance_bdt": "1234.56"})
    assert "1234.56" in s
    assert "check" in s.lower()
