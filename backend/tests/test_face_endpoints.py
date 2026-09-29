"""Tests for the Face ID enrollment endpoints.

Browser-side matching is NOT covered here — that lives in the frontend
lib/face.ts wrapper and face-api.js. We only test the server contract:
storage round-trip, idempotency, validation, and the cosine_similarity
helper (which the test suite also uses as a reference for the threshold).
"""
from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import User
from app.routers.accounts import (
    FACE_MATCH_THRESHOLD,
    _pack_embedding,
    _unpack_embedding,
    cosine_similarity,
)


# ---- Helpers ---------------------------------------------------------------
def _bikash_id() -> int:
    with SessionLocal() as s:
        return s.query(User).filter_by(handle="bikash").one().id


def _ghost_id() -> int:
    """A user_id that doesn't exist after the seed run."""
    with SessionLocal() as s:
        existing = {u.id for u in s.query(User).all()}
    candidate = max(existing) + 9999
    assert candidate not in existing
    return candidate


def _valid_embedding(seed: float = 0.01) -> list[float]:
    """A valid 128-dim vector. Deterministic — same seed → same vector."""
    return [float(i) * seed for i in range(128)]


# ---- Round-trip pack/unpack ------------------------------------------------
def test_pack_unpack_round_trip_preserves_values():
    """JSON encode/decode must be lossless for valid floats."""
    vec = _valid_embedding()
    blob = _pack_embedding(vec)
    assert isinstance(blob, bytes)
    assert _unpack_embedding(blob) == vec


def test_unpack_defensive_on_garbage():
    """A corrupted blob must NOT raise — status reads must never 500."""
    assert _unpack_embedding(b"\xff\xfe\xfd") == []
    assert _unpack_embedding(b"not-json") == []
    # Empty blob is technically valid JSON: null → [].
    assert _unpack_embedding(b"") == []


# ---- cosine_similarity -----------------------------------------------------
def test_cosine_similarity_identical_is_one():
    vec = _valid_embedding()
    assert math.isclose(cosine_similarity(vec, vec), 1.0, rel_tol=1e-9)


def test_cosine_similarity_orthogonal_is_zero():
    """Two L2-orthogonal vectors score 0.0."""
    a = [1.0] + [0.0] * 127
    b = [0.0, 1.0] + [0.0] * 126
    assert math.isclose(cosine_similarity(a, b), 0.0, abs_tol=1e-9)


def test_cosine_similarity_dimension_mismatch_safe():
    """Mismatched lengths must not raise — return 0.0."""
    a = [1.0] * 128
    b = [1.0] * 64
    assert cosine_similarity(a, b) == 0.0


def test_cosine_similarity_empty_inputs_safe():
    assert cosine_similarity([], []) == 0.0
    assert cosine_similarity([1.0], []) == 0.0


def test_cosine_similarity_zero_vector_safe():
    """Zero vector would NaN out a naive impl — guard against it."""
    zero = [0.0] * 128
    vec = _valid_embedding()
    assert cosine_similarity(zero, vec) == 0.0
    assert cosine_similarity(vec, zero) == 0.0


def test_face_match_threshold_is_face_api_default():
    """face-api.js documents 0.6 as the default match distance threshold.
    Keeping the server-side constant in sync avoids drift if tests start
    checking both ends."""
    assert FACE_MATCH_THRESHOLD == 0.6


# ---- HTTP: status before/after enroll --------------------------------------
def test_status_unenrolled_returns_false():
    client = TestClient(app)
    bikash = _bikash_id()
    resp = client.get(f"/users/{bikash}/face/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["user_id"] == bikash
    assert body["enrolled"] is False
    assert body["enrolled_at"] is None


def test_enroll_then_status_returns_true_with_timestamp():
    client = TestClient(app)
    bikash = _bikash_id()
    vec = _valid_embedding()
    enroll = client.post(f"/users/{bikash}/face", json={"embedding": vec})
    assert enroll.status_code == 200, enroll.text
    body = enroll.json()
    assert body["user_id"] == bikash
    assert body["enrolled"] is True
    assert body["enrolled_at"] is not None

    status = client.get(f"/users/{bikash}/face/status").json()
    assert status["enrolled"] is True
    assert status["enrolled_at"] == body["enrolled_at"]


def test_enroll_overwrites_previous_embedding():
    """Re-enrollment is allowed and bumps the timestamp."""
    client = TestClient(app)
    bikash = _bikash_id()
    first = client.post(f"/users/{bikash}/face", json={"embedding": _valid_embedding()}).json()
    second = client.post(f"/users/{bikash}/face", json={"embedding": _valid_embedding(seed=0.02)}).json()
    assert first["enrolled_at"] is not None
    assert second["enrolled_at"] is not None
    # Timestamps must differ (wall-clock time has at least 1ms granularity
    # in practice; we assert they don't collide by string inequality).
    assert first["enrolled_at"] != second["enrolled_at"]


def test_delete_clears_enrollment():
    client = TestClient(app)
    bikash = _bikash_id()
    # First enroll so we have something to delete.
    client.post(f"/users/{bikash}/face", json={"embedding": _valid_embedding()})
    deleted = client.delete(f"/users/{bikash}/face")
    assert deleted.status_code == 200
    assert deleted.json() == {"user_id": bikash, "enrolled": False}
    # And the DB row reflects the cleared state.
    with SessionLocal() as s:
        u = s.get(User, bikash)
        assert u.face_embedding is None
        assert u.face_enrolled_at is None
    status = client.get(f"/users/{bikash}/face/status").json()
    assert status["enrolled"] is False


def test_delete_is_idempotent_when_already_cleared():
    """Deleting twice is a no-op the second time — no error, still 200."""
    client = TestClient(app)
    bikash = _bikash_id()
    # No prior enrollment.
    first = client.delete(f"/users/{bikash}/face")
    second = client.delete(f"/users/{bikash}/face")
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["enrolled"] is False
    assert second.json()["enrolled"] is False


# ---- HTTP: validation ------------------------------------------------------
def test_enroll_rejects_wrong_dim_too_short():
    client = TestClient(app)
    bikash = _bikash_id()
    resp = client.post(f"/users/{bikash}/face", json={"embedding": [0.1] * 64})
    assert resp.status_code == 422


def test_enroll_rejects_wrong_dim_too_long():
    client = TestClient(app)
    bikash = _bikash_id()
    resp = client.post(f"/users/{bikash}/face", json={"embedding": [0.1] * 200})
    assert resp.status_code == 422


def test_enroll_rejects_nan():
    """NaN is silently round-trippable in JSON but breaks similarity. Reject
    at the request boundary so it can never land in the DB."""
    client = TestClient(app)
    bikash = _bikash_id()
    vec = _valid_embedding()
    vec[10] = float("nan")
    resp = client.post(f"/users/{bikash}/face", json={"embedding": vec})
    assert resp.status_code == 422


def test_enroll_rejects_inf():
    client = TestClient(app)
    bikash = _bikash_id()
    vec = _valid_embedding()
    vec[42] = float("inf")
    resp = client.post(f"/users/{bikash}/face", json={"embedding": vec})
    assert resp.status_code == 422


# ---- HTTP: not found -------------------------------------------------------
@pytest.mark.parametrize("method", ["get", "post", "delete"])
def test_unknown_user_returns_404(method):
    client = TestClient(app)
    ghost = _ghost_id()
    if method == "get":
        resp = client.get(f"/users/{ghost}/face/status")
    elif method == "post":
        resp = client.post(f"/users/{ghost}/face", json={"embedding": _valid_embedding()})
    else:
        resp = client.delete(f"/users/{ghost}/face")
    assert resp.status_code == 404
    assert "user not found" in resp.json()["detail"].lower()
