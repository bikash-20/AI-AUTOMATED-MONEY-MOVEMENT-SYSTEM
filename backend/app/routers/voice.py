"""Voice router: STT endpoint + TTS trigger (browser can also play returned
audio from the chat path, but having a separate /speak endpoint keeps parity
with the existing voice_server.py pattern)."""
from __future__ import annotations

import io
import wave
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .. import voice_io

router = APIRouter(prefix="/voice", tags=["voice"])


@router.post("/transcribe")
async def transcribe(
    audio: bytes = File(...),
    language: Optional[str] = Form(None),
) -> JSONResponse:
    if not audio:
        raise HTTPException(400, "empty audio")
    try:
        text, lang, dur = voice_io.get_stt().transcribe_bytes(audio, language=language)
    except Exception as e:
        raise HTTPException(500, f"transcribe failed: {e}")
    return JSONResponse({"text": text, "language": lang, "duration": dur})


@router.post("/speak")
async def speak(request: Request) -> Response:
    """Server-side TTS playback trigger. Browser can also play audio it gets
    directly from the agent response, but this endpoint keeps symmetry with
    the existing voice_server.py and lets the server pick the best voice."""
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "expected JSON body with `text`")
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "empty text")
    voice_io.speak(text)
    return JSONResponse({"queued": True})
