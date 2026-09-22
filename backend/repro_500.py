"""Test what happens when Ollama is unreachable."""
import os
import tempfile
from pathlib import Path

# Point at a dead Ollama — simulate the user's scenario.
os.environ["DB_PATH"] = str(Path(tempfile.mkdtemp()) / "test.db")
os.environ["OLLAMA_URL"] = "http://127.0.0.1:1"  # nothing listens here
os.environ["LLM_CASCADE"] = "qwen3:8b,deepseek-coder-v2:16b"

from fastapi.testclient import TestClient

from app.db import SessionLocal, init_db
from app.main import app
from app.seed import seed

init_db()
with SessionLocal() as s:
    seed(s)
    s.commit()

c = TestClient(app)
r = c.get("/users")
users = {u["handle"]: u for u in r.json()}
bikash = users["bikash"]

r = c.post(
    "/agent/act",
    json={
        "user_id": bikash["id"],
        "text": "send 500 to rishad",
        "idempotency_key": "dead-ollama-1234567890",
    },
)
print("Ollama dead, send status:", r.status_code)
print("body:", r.text[:2000])

r = c.post(
    "/agent/act",
    json={
        "user_id": bikash["id"],
        "text": "hi how are you",
        "idempotency_key": "greet-1234567890",
    },
)
print("Greeting status:", r.status_code)
print("body:", r.text[:2000])
