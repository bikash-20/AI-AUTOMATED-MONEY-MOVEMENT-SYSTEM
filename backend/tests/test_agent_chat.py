from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import User


def test_chat_balance_uses_current_account_value():
    with SessionLocal() as session:
        user_id = session.query(User).filter_by(handle="bikash").one().id

    with TestClient(app) as client:
        response = client.post(
            "/agent/chat",
            json={"user_id": user_id, "text": "check my balance"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["action"] == "balance"
    assert "50000.00" in body["text"]