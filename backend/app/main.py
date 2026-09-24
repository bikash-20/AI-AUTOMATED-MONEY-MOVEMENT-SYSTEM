"""FastAPI app entry point. Wires routers, lifespan, CORS."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import Body, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config, engine, voice_io
from .db import SessionLocal, init_db
from .routers import accounts, agent, insights, voice
from .seed import seed
from .services.event_bus import get_bus
from .workers import categorizer_worker

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
log = logging.getLogger("wallet")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("starting wallet demo backend")
    init_db()
    # Seed (idempotent).
    with SessionLocal() as s:
        result = seed(s)
        s.commit()
        log.info("seed: %s", result)
    # Start pending-txn TTL sweeper.
    engine.start_sweeper(SessionLocal)
    # Start the categorizer worker (consumes categorize.requested events).
    categorizer_worker.start_categorizer(get_bus())
    log.info("ready on http://%s:%d", config.APP_HOST, config.APP_PORT)
    try:
        yield
    finally:
        engine.stop_sweeper()
        await categorizer_worker.stop_categorizer()
        voice_io.drain_and_stop()
        log.info("shutdown complete")


app = FastAPI(title="Wallet Demo", lifespan=lifespan)

# CORS: same threat-model reasoning as ollama-local-model-website/voice_server.py.
# Binds to 127.0.0.1 by default, no server-side state worth exfiltrating.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS", "PATCH"],
    allow_headers=["*"],
)

app.include_router(agent.router)
app.include_router(accounts.router)
app.include_router(insights.router)
app.include_router(voice.router)


@app.get("/")
def root() -> dict:
    return {
        "service": "wallet-demo",
        "ollama_url": config.OLLAMA_URL,
        "llm_cascade": config.LLM_CASCADE,
        "tts_engine": config.TTS_ENGINE,
        "openrouter_configured": bool((config.OPENROUTER_API_KEY or "").strip()),
    }


def _probe_ollama() -> bool:
    """Quick liveness check against the local Ollama server."""
    try:
        with httpx.Client(timeout=2.0) as c:
            r = c.get(f"{config.OLLAMA_URL}/api/tags")
            return r.status_code == 200
    except Exception:
        return False


def _ollama_models() -> list[str]:
    try:
        with httpx.Client(timeout=2.0) as c:
            r = c.get(f"{config.OLLAMA_URL}/api/tags")
            r.raise_for_status()
            return [m.get("name", "") for m in r.json().get("models", []) if m.get("name")]
    except Exception:
        return []


def _probe_openrouter() -> bool:
    if not (config.OPENROUTER_API_KEY or "").strip():
        return False
    try:
        with httpx.Client(timeout=2.0) as c:
            r = c.get(
                f"{config.OPENROUTER_URL}/models",
                headers={"Authorization": f"Bearer {config.OPENROUTER_API_KEY}"},
            )
            return r.status_code == 200
    except Exception:
        return False


@app.get("/health")
def health() -> dict:
    installed_models = _ollama_models()
    return {
        "ok": True,
        "ollama_reachable": _probe_ollama(),
        "ollama_url": config.OLLAMA_URL,
        "ollama_models": installed_models,
        "llm_models_ready": [m for m in config.LLM_CASCADE if m in installed_models],
        "llm_models_missing": [m for m in config.LLM_CASCADE if m not in installed_models],
        "openrouter_reachable": _probe_openrouter(),
        "openrouter_configured": bool((config.OPENROUTER_API_KEY or "").strip()),
        "regex_fallback": True,
    }


@app.get("/settings")
def get_settings() -> dict:
    """Public settings (no secrets exposed)."""
    return {
        "ollama_url": config.OLLAMA_URL,
        "llm_cascade": config.LLM_CASCADE,
        "openrouter_url": config.OPENROUTER_URL,
        "openrouter_models": config.OPENROUTER_MODELS,
        "openrouter_key_set": bool((config.OPENROUTER_API_KEY or "").strip()),
        "tts_engine": config.TTS_ENGINE,
        "edge_tts_voice": config.EDGE_TTS_VOICE,
        "qwen_tts_voice": config.QWEN_TTS_VOICE,
        "stt_model": config.STT_MODEL,
        "pending_ttl_seconds": config.PENDING_TTL_SECONDS,
    }


@app.patch("/settings")
def patch_settings(payload: dict = Body(...)) -> dict:
    """Update endpoint config in-process. Survives until restart.
    Not for secrets (use env vars for those)."""
    if "ollama_url" in payload:
        config.OLLAMA_URL = payload["ollama_url"].strip()
    if "llm_cascade" in payload:
        config.LLM_CASCADE = [
            m.strip() for m in payload["llm_cascade"].split(",") if m.strip()
        ]
    if "openrouter_url" in payload:
        config.OPENROUTER_URL = payload["openrouter_url"].strip()
    if "openrouter_models" in payload:
        config.OPENROUTER_MODELS = [
            m.strip() for m in payload["openrouter_models"].split(",") if m.strip()
        ]
    if "openrouter_api_key" in payload:
        # Allow runtime key set (demo-only). Empty string clears it.
        config.OPENROUTER_API_KEY = payload["openrouter_api_key"].strip()
    if "tts_engine" in payload:
        config.TTS_ENGINE = payload["tts_engine"].strip().lower()
    if "edge_tts_voice" in payload:
        config.EDGE_TTS_VOICE = payload["edge_tts_voice"].strip()
    if "qwen_tts_voice" in payload:
        config.QWEN_TTS_VOICE = payload["qwen_tts_voice"].strip()
    if "stt_model" in payload:
        config.STT_MODEL = payload["stt_model"].strip()
    return get_settings()
