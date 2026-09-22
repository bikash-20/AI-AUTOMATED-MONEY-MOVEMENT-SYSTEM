"""Idempotent seed: 6 users, 2 billers, deterministic BD phone numbers.

Run via `python -m app.seed` or called from app.main lifespan.
"""
from __future__ import annotations

import random
from decimal import Decimal

from sqlalchemy.orm import Session

from . import config
from .models import Account, Biller, User


# Order matters for stable phone numbers.
DEMO_USERS: list[tuple[str, str]] = [
    ("bikash", "Bikash"),
    ("rishad", "Rishad"),
    ("arman", "Arman"),
    ("tahzib", "Tahzib"),
    ("srijan", "Srijan"),
    ("mahdin", "Mahdin"),
]

DEMO_BILLERS: list[tuple[str, str, str]] = [
    # name, category, account_number
    ("Internet", "utility", "ISP-001"),
    ("Electricity", "utility", "PWR-002"),
    ("Shopping", "shopping", "SHOP-003"),
]


def _bd_phone(rng: random.Random) -> str:
    """Generate a +880 1XXX-XXXXXX number. 1[3-9]XX prefix, random 6 digits."""
    op = rng.choice(["13", "14", "15", "16", "17", "18", "19"])
    mid = f"{rng.randint(100, 999)}"
    last = f"{rng.randint(0, 999999):06d}"
    return f"+880 {op}{mid}-{last}"


def seed(session: Session) -> dict:
    """Insert demo data. Returns counts. Safe to call repeatedly."""
    rng = random.Random(20260922)  # fixed seed -> reproducible phone numbers

    user_count = 0
    for handle, display in DEMO_USERS:
        existing = session.query(User).filter_by(handle=handle).one_or_none()
        if existing:
            continue
        user = User(
            handle=handle,
            display_name=display,
            phone=_bd_phone(rng),
        )
        session.add(user)
        session.flush()
        # Seed balance: bikash rich, everyone else 10k.
        balance = (
            Decimal(config.SEED_BALANCE_BIKASH)
            if handle == "bikash"
            else Decimal(config.SEED_BALANCE_DEFAULT)
        )
        session.add(Account(user_id=user.id, balance_bdt=balance))
        user_count += 1

    biller_count = 0
    for name, category, acc_no in DEMO_BILLERS:
        existing = session.query(Biller).filter_by(name=name).one_or_none()
        if existing:
            continue
        session.add(Biller(name=name, category=category, account_number=acc_no))
        biller_count += 1

    return {"new_users": user_count, "new_billers": biller_count}


if __name__ == "__main__":
    from .db import SessionLocal, init_db

    init_db()
    with SessionLocal() as s:
        result = seed(s)
        s.commit()
        print(result)
