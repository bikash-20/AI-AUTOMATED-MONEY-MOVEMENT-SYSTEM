from fastapi.testclient import TestClient

from app.main import app


def test_history_returns_current_balance_for_today():
    with TestClient(app) as client:
        response = client.get("/users/1/history")

    assert response.status_code == 200
    body = response.json()
    assert body["timeline"][-1]["balance"] == float(body["balance_bdt"])