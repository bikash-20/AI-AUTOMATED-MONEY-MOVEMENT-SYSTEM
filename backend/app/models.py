"""SQLAlchemy ORM. Schema is portable to Postgres (Numeric, Enum-as-text,
JSON-as-text, integer PKs, FKs with proper indexes).

Naming convention: snake_case; enum values stored as VARCHAR for portability.
"""
from __future__ import annotations

import enum
from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)


# On SQLite, autoincrement only works with the exact `Integer` type.
# On Postgres we keep `BigInteger`. This is the standard SQLAlchemy
# cross-dialect portability pattern.
_PKType = Integer().with_variant(BigInteger(), "postgresql")
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class TxnKind(str, enum.Enum):
    SEND = "send"
    REQUEST = "request"
    BILL = "bill"
    SPLIT_CHILD = "split_child"
    SAVINGS = "savings"  # internal transfer to a savings goal; bypasses _execute()


class TxnStatus(str, enum.Enum):
    PENDING = "pending"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    DECLINED = "declined"
    PAID = "paid"


class RequestStatus(str, enum.Enum):
    PENDING = "pending"
    PAID = "paid"
    DECLINED = "declined"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    handle: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(64), nullable=False)
    phone: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.current_timestamp(), nullable=False
    )
    # Face ID enrollment (demo): opaque 128-dim float32 embedding produced
    # by face-api.js on the client. We never see the raw face image — the
    # webcam frames stay in the browser. NULL = not enrolled.
    face_embedding: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    face_enrolled_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    account: Mapped["Account"] = relationship(back_populates="user", uselist=False)

    def __repr__(self) -> str:
        return f"<User {self.handle}>"


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    balance_bdt: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False, default=Decimal("0.00")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.current_timestamp(), nullable=False
    )

    user: Mapped[User] = relationship(back_populates="account")

    __table_args__ = (
        CheckConstraint("balance_bdt >= 0", name="ck_balance_nonneg"),
    )


class Transaction(Base):
    """Single row per money-moving intent. State machine:
    pending -> completed (on explicit confirm)
    pending -> cancelled (on decline OR TTL expiry)
    For requests: pending is a *proposal*, not a debit.
    """
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(_PKType, primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False)
    initiator_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), nullable=False
    )
    from_account_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("accounts.id"), nullable=True
    )
    to_account_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("accounts.id"), nullable=True
    )
    biller_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("billers.id"), nullable=True
    )
    amount_bdt: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    note: Mapped[Optional[str]] = mapped_column(String(140), nullable=True)
    parent_split_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("splits.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.current_timestamp(), nullable=False
    )
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        # Idempotency is per-initiator (one user's "send 500 to rishad" twice
        # with same key = same outcome; another user with same key is unrelated).
        UniqueConstraint(
            "initiator_user_id", "idempotency_key", name="uq_txn_idem"
        ),
        Index("ix_txn_status", "status"),
        Index("ix_txn_from", "from_account_id"),
        Index("ix_txn_to", "to_account_id"),
        Index("ix_txn_created", "created_at"),
    )


class Request(Base):
    """Money request from one user to another. When the asker pays it, we
    create a Transaction of kind=send and link it via linked_txn_id.
    """
    __tablename__ = "requests"

    id: Mapped[int] = mapped_column(_PKType, primary_key=True)
    asker_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    payer_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    amount_bdt: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    note: Mapped[Optional[str]] = mapped_column(String(140), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    linked_txn_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("transactions.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.current_timestamp(), nullable=False
    )
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_req_payer", "payer_user_id", "status"),
        Index("ix_req_asker", "asker_user_id"),
        UniqueConstraint("asker_user_id", "idempotency_key", name="uq_request_idem"),
    )


class Biller(Base):
    __tablename__ = "billers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    category: Mapped[str] = mapped_column(String(32), nullable=False)
    account_number: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.current_timestamp(), nullable=False
    )


class Split(Base):
    """Parent record for an equal-split operation. Children are Transactions
    of kind=split_child with parent_split_id pointing here.
    """
    __tablename__ = "splits"

    id: Mapped[int] = mapped_column(_PKType, primary_key=True)
    initiator_account_id: Mapped[int] = mapped_column(
        ForeignKey("accounts.id"), nullable=False
    )
    total_amount_bdt: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    per_amount_bdt: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    recipients_json: Mapped[str] = mapped_column(Text, nullable=False)  # JSON list of ints
    note: Mapped[Optional[str]] = mapped_column(String(140), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.current_timestamp(), nullable=False
    )


class SavingsGoal(Base):
    """A named festival savings target owned by one wallet user."""

    __tablename__ = "savings_goals"

    id: Mapped[int] = mapped_column(_PKType, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    festival: Mapped[str] = mapped_column(String(32), nullable=False)
    target_amount_bdt: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    saved_amount_bdt: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    target_date: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.current_timestamp(), nullable=False
    )

    __table_args__ = (
        CheckConstraint("target_amount_bdt > 0", name="ck_goal_target_positive"),
        CheckConstraint("saved_amount_bdt >= 0", name="ck_goal_saved_nonneg"),
        UniqueConstraint("user_id", "festival", name="uq_user_festival_goal"),
        Index("ix_goal_user", "user_id"),
    )


class TxnTag(Base):
    """A category tag applied to a transaction.

    Tags are produced by:
      - the categorizer worker (`source='auto'` or `source='llm'`) running
        off the EventBus after a successful `_execute()`
      - the user manually via `POST /users/{id}/transactions/{txn}/tags`
        (`source='user'`).

    UNIQUE(txn_id, tag_slug) makes tag application idempotent and lets
    the user override an auto-tag by inserting the same slug with
    source='user' (the engine layer never touches this; the routers
    enforce the override semantics).
    """

    __tablename__ = "txn_tags"

    id: Mapped[int] = mapped_column(_PKType, primary_key=True)
    txn_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False
    )
    tag_slug: Mapped[str] = mapped_column(String(32), nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="auto")
    by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.current_timestamp(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("txn_id", "tag_slug", name="uq_txn_tag"),
        Index("ix_txn_tag_slug", "tag_slug"),
        Index("ix_txn_tag_txn", "txn_id"),
    )
