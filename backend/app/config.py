"""Single source of truth for env config.

Mirrors the pattern from ~/python/AI ENGINEERING/config.py.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env", override=False)

# ---- App --------------------------------------------------------------------
APP_HOST = os.getenv("APP_HOST", "127.0.0.1")
APP_PORT = int(os.getenv("APP_PORT", "8000"))

# ---- DB ---------------------------------------------------------------------
_db_raw = os.getenv("DB_PATH", "./wallet.db")
DB_PATH = Path(_db_raw).expanduser()
if not DB_PATH.is_absolute():
    DB_PATH = (ROOT / DB_PATH).resolve()

# ---- Pending txn TTL --------------------------------------------------------
PENDING_TTL_SECONDS = max(5, int(os.getenv("PENDING_TTL_SECONDS", "60")))
SWEEPER_INTERVAL_SECONDS = max(1, int(os.getenv("SWEEPER_INTERVAL_SECONDS", "5")))

# ---- LLM cascade ------------------------------------------------------------
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
_cascade_raw = os.getenv("LLM_CASCADE", "deepseek-coder-v2:16b")
LLM_CASCADE = [m.strip() for m in _cascade_raw.split(",") if m.strip()]

# OpenRouter (cloud fallback). Activated when a key is set AND the local
# cascade is empty/failing. Free models by default.
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
OPENROUTER_URL = os.getenv("OPENROUTER_URL", "https://openrouter.ai/api/v1").strip()
_openrouter_models = os.getenv(
    "OPENROUTER_MODELS",
    "deepseek/deepseek-chat-v3-0324:free,qwen/qwen3-4b:free,meta-llama/llama-3.3-8b-instruct:free",
)
OPENROUTER_MODELS = [m.strip() for m in _openrouter_models.split(",") if m.strip()]

# ---- TTS --------------------------------------------------------------------
TTS_ENGINE = os.getenv("TTS_ENGINE", "edge").strip().lower()
EDGE_TTS_VOICE = os.getenv("EDGE_TTS_VOICE", "en-US-GuyNeural")
QWEN_TTS_MODEL = os.getenv("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
QWEN_TTS_MODEL_DIR = os.getenv("QWEN_TTS_MODEL_DIR", "").strip()
QWEN_TTS_VOICE = os.getenv("QWEN_TTS_VOICE", "Ryan")
QWEN_TTS_LANG = os.getenv("QWEN_TTS_LANG", "English")
QWEN_TTS_INSTRUCT = os.getenv(
    "QWEN_TTS_INSTRUCT", "Speak calmly, like a thoughtful assistant."
)
VOICE_REPLY_ENABLED = os.getenv("VOICE_REPLY_ENABLED", "true").strip().lower() in {
    "1", "true", "yes", "on"
}

# ---- STT --------------------------------------------------------------------
STT_MODEL = os.getenv("STT_MODEL", "base")
STT_COMPUTE = os.getenv("STT_COMPUTE", "int8")

# ---- Seed -------------------------------------------------------------------
SEED_BALANCE_BIKASH = int(os.getenv("SEED_BALANCE_BIKASH", "50000"))
SEED_BALANCE_DEFAULT = int(os.getenv("SEED_BALANCE_DEFAULT", "10000"))

# ---- System prompts ---------------------------------------------------------
INTENT_SYSTEM_PROMPT = """You are a STRICT JSON parser for a money-movement demo.
Reply with ONLY valid JSON matching this exact schema, no prose, no markdown fences:
{
  "action": "send" | "request" | "split" | "pay_bill" | "balance" | "history" | "unknown",
  "amount": <positive number or null>,
  "recipient": <one of the known handles as a string or null>,
  "biller": <one of the known biller names as a string or null>,
  "split_recipients": <array of handles, possibly empty>
}
If anything is unclear, use null. Never invent values. Never add commentary."""

PHRASER_SYSTEM_PROMPT = """You are a concise, friendly assistant for a BD MFS demo.
Address the user as 'Boss' when natural. One or two sentences. No filler.
Reply with ONLY the sentence, no quotes, no markdown."""
