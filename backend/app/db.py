"""SQLAlchemy engine, session factory, schema init."""
from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from . import config
from .models import Base


def _engine_url() -> str:
    return f"sqlite:///{config.DB_PATH}"


def make_engine() -> Engine:
    """Build a fresh engine bound to the current config.DB_PATH.

    Factored out so tests can rebuild it against a tmp file without messing
    with module-level singletons.
    """
    eng = create_engine(
        _engine_url(),
        echo=False,
        future=True,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _):
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()

    return eng


# Default engine used by the running app; tests override via reset_engine().
_engine: Engine = make_engine()
_SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)


def reset_engine() -> Engine:
    """Drop the cached engine and rebuild against current config. Test-only."""
    global _engine, _SessionLocal
    try:
        _engine.dispose()
    except Exception:
        pass
    _engine = make_engine()
    _SessionLocal.configure(bind=_engine)
    return _engine


def init_db() -> None:
    """Create tables if they don't exist. Idempotent."""
    Base.metadata.create_all(_engine)
    # Lightweight development migration for the existing SQLite demo DB.
    # Production deployments should run a real migration tool such as Alembic.
    if _engine.dialect.name == "sqlite":
        columns = {column["name"] for column in inspect(_engine).get_columns("requests")}
        if "idempotency_key" not in columns:
            with _engine.begin() as connection:
                connection.execute(
                    text("ALTER TABLE requests ADD COLUMN idempotency_key VARCHAR(64) NOT NULL DEFAULT ''")
                )
        with _engine.begin() as connection:
            legacy_rows = connection.execute(
                text(
                    "SELECT id FROM requests "
                    "WHERE idempotency_key IS NULL OR idempotency_key = ''"
                )
            ).scalars().all()
            for request_id in legacy_rows:
                connection.execute(
                    text(
                        "UPDATE requests SET idempotency_key = :key "
                        "WHERE id = :request_id"
                    ),
                    {"key": f"legacy-request:{request_id}", "request_id": request_id},
                )
            connection.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_request_idem "
                "ON requests (asker_user_id, idempotency_key)"
            ))


@contextmanager
def session_scope() -> Iterator[Session]:
    """Transactional context. Commits on success, rolls back on exception."""
    s = _SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def get_session() -> Iterator[Session]:
    """FastAPI dependency. Caller is responsible for commit/rollback."""
    s = _SessionLocal()
    try:
        yield s
    finally:
        s.close()


# Module-level alias for callers that want the bound session factory.
# Note: this is a reference, but since _SessionLocal.configure(bind=...) updates
# the existing sessionmaker in place, callers using SessionLocal() will pick up
# the new engine automatically.
SessionLocal = _SessionLocal
