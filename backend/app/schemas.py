"""Pydantic schemas for the wire protocol.

These are the contracts between the frontend, the agent router, and the
engine. Keep them stable.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


# ---- LLM intent -------------------------------------------------------------
class Intent(BaseModel):
    """Raw output of the LLM intent parser."""

    action: Literal["send", "request", "split", "pay_bill", "balance", "history", "unknown"] = "unknown"
    amount: Optional[float] = None
    recipient: Optional[str] = None
    biller: Optional[str] = None
    split_recipients: list[str] = Field(default_factory=list)


# ---- Resolver output --------------------------------------------------------
class Resolved(BaseModel):
    """LLM intent, normalized and pinned to real DB IDs."""

    action: str
    amount_bdt: Decimal
    initiator_user_id: int
    from_account_id: Optional[int] = None
    to_account_id: Optional[int] = None
    biller_id: Optional[int] = None
    recipient_handle: Optional[str] = None
    split_recipients: list[str] = Field(default_factory=list)
    note: Optional[str] = None


# ---- Agent request/response -------------------------------------------------
class AgentActRequest(BaseModel):
    user_id: int
    text: str = Field(min_length=1, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=64)


class AgentConfirmRequest(BaseModel):
    user_id: int
    pending_id: int
    idempotency_key: str = Field(min_length=8, max_length=64)
    decision: Literal["confirm", "decline"]


class ReviewCard(BaseModel):
    """Facts shown to the user in the review/confirm card."""

    kind: Literal["send", "request", "split", "pay_bill"]
    amount_bdt: Decimal
    recipient_label: Optional[str] = None  # handle or biller name
    recipient_phone: Optional[str] = None
    recipients: Optional[list[str]] = None  # for splits
    note: Optional[str] = None
    resulting_balance_bdt: Decimal
    initiator_handle: str
    initiator_phone: str


class AgentActResponse(BaseModel):
    """Returned by /agent/act. `card is None` when the action doesn't need
    confirmation (e.g. balance check, history list)."""

    text: str
    card: Optional[ReviewCard] = None
    pending_id: Optional[int] = None
    action: str  # echoes the resolved action
    idempotent_replay: bool = False
    data: Optional[dict] = None  # for balance / history direct results


class AgentConfirmResponse(BaseModel):
    text: str
    success: bool
    new_balance_bdt: Optional[Decimal] = None
    data: Optional[dict] = None


class AgentChatRequest(BaseModel):
    user_id: int
    text: str = Field(min_length=1, max_length=500)


class AgentChatResponse(BaseModel):
    text: str
    action: str  # greeting | thanks | bye | fallback


# ---- Accounts ---------------------------------------------------------------
class UserOut(BaseModel):
    id: int
    handle: str
    display_name: str
    phone: str


class BalanceOut(BaseModel):
    user_id: int
    handle: str
    balance_bdt: Decimal
    as_of: datetime


class TxnOut(BaseModel):
    id: int
    kind: str
    status: str
    amount_bdt: Decimal
    direction: Literal["in", "out"]  # from this user's POV
    counterparty: Optional[str]  # handle or biller name
    counterparty_phone: Optional[str] = None
    note: Optional[str]
    created_at: datetime
    completed_at: Optional[datetime]


class HistoryResponse(BaseModel):
    user_id: int
    handle: str
    balance_bdt: Decimal
    txns: list[TxnOut]
    # 14-day balance timeline (oldest first), used by the chart.
    timeline: list[dict]  # [{date: "2026-09-08", balance: 12500.00}, ...]


class PendingRequestOut(BaseModel):
    id: int
    asker_handle: str
    asker_phone: str
    amount_bdt: Decimal
    note: Optional[str]
    created_at: datetime


class SavingsGoalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    festival: str
    target_amount_bdt: Decimal
    saved_amount_bdt: Decimal
    target_date: Optional[datetime]


class SavingsGoalCreate(BaseModel):
    festival: str = Field(min_length=2, max_length=32)
    target_amount_bdt: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    target_date: Optional[datetime] = None


class SavingsContribution(BaseModel):
    amount_bdt: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    idempotency_key: str = Field(min_length=8, max_length=64)


class BillerOut(BaseModel):
    id: int
    name: str
    category: str
    account_number: str
