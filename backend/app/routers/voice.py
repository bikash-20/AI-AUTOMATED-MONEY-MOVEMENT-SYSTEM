"""Voice router: STT endpoint + TTS endpoint.

The /speak endpoint now returns WAV bytes synthesized by the configured
TTS engine (Qwen3 / Edge / off). The browser plays them through an
<audio> element so the user actually hears the *configured* voice — not
the browser's built-in default.
"""
from __future__ import annotations

import asyncio
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
    """Synthesize speech with the configured TTS engine and return WAV bytes.

    The browser plays these bytes via an <audio> element. If synthesis
    fails, we return 500 with the underlying error — the frontend surfaces
    that to the user rather than silently falling back to a generic
    browser voice (which is the bug this endpoint previously had).

    `voice_io.synthesize` is sync and internally calls `asyncio.run()` for
    the Edge TTS branch. Since this handler runs on the FastAPI event
    loop, we MUST offload the work to a worker thread — otherwise the
    inner `asyncio.run()` raises "cannot be called from a running event
    loop". `asyncio.to_thread` is the idiomatic way; it gives us a real
    fresh thread with no inherited loop, so Edge TTS's `asyncio.run`
    succeeds. Same offload also keeps Qwen-TTS (multi-second synthesis)
    from blocking the loop's other handlers.
    """
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "expected JSON body with `text`")
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "empty text")
    try:
        wav_bytes = await asyncio.to_thread(voice_io.synthesize, text)
    except RuntimeError as e:
        # Surface engine load / synthesis failures to the client. Do NOT
        # fall back to a generic voice — the user has chosen Qwen/Edge and
        # they should know if it failed.
        raise HTTPException(500, f"tts failed: {e}") from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"tts failed: {type(e).__name__}: {e}") from e
    return Response(content=wav_bytes, media_type="audio/wav")