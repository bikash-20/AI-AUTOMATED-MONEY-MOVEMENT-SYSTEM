"""Voice router: STT endpoint + TTS endpoint + readiness probe.

The /speak endpoint returns WAV bytes synthesized by the configured
TTS engine (Qwen3 / Edge / off). The browser plays them through an
<audio> element so the user actually hears the *configured* voice — not
the browser's built-in default.

The /wake-status endpoint is a lightweight readiness probe so the
frontend can show "voice ready" without triggering a real STT/TTS call
(which would force model load on first hit and add 10–30s latency).
"""
from __future__ import annotations

import asyncio
import threading
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .. import config, voice_io

router = APIRouter(prefix="/voice", tags=["voice"])


# Track which engines have been initialized in this process. Lazy-loaded
# engines don't report `loaded: true` until they've actually been called.
_engine_state = {
    "stt_loaded": False,
    "stt_lock": threading.Lock(),
}


def _ensure_stt_warm() -> bool:
    """Trigger STT model load in background if not yet loaded.
    Returns True if warm, False if still loading."""
    with _engine_state["stt_lock"]:
        if _engine_state["stt_loaded"]:
            return True
        # Lazy-load in this thread. Model load is heavy (10–30s first time)
        # so this blocks — but it's only called once per process lifetime
        # from /wake-status after the dashboard mounts. Subsequent calls
        # return immediately.
        try:
            voice_io.get_stt().get()
            _engine_state["stt_loaded"] = True
            return True
        except Exception:
            return False


@router.get("/wake-status")
async def wake_status() -> JSONResponse:
    """Report voice pipeline readiness.

    Used by the frontend voice system to:
      - decide whether to show "voice ready" vs "voice warming up"
      - trigger background STT pre-warm (avoiding cold-start latency
        on the user's first voice command)

    Does NOT touch TTS — TTS is lazy and the first /voice/speak call
    will warm it on demand. We don't pre-warm TTS here because Qwen3-TTS
    load is also expensive (10s+) and the user might not actually use
    voice at all.
    """
    # Fire-and-forget background warm. Don't block the response on it.
    threading.Thread(target=_ensure_stt_warm, daemon=True).start()
    return JSONResponse({
        "stt_model": config.STT_MODEL,
        "stt_loaded": _engine_state["stt_loaded"],
        "tts_engine": config.TTS_ENGINE,
        "tts_voice": (
            config.EDGE_TTS_VOICE
            if (config.TTS_ENGINE or "").strip().lower() == "edge"
            else config.QWEN_TTS_VOICE
        ),
        "ready": _engine_state["stt_loaded"],
    })


@router.post("/transcribe")
async def transcribe(
    audio: bytes = File(...),
    language: Optional[str] = Form(None),
) -> JSONResponse:
    if not audio:
        raise HTTPException(400, "empty audio")
    try:
        text, lang, dur = voice_io.get_stt().transcribe_bytes(audio, language=language)
        # Mark STT as loaded once a successful transcribe completes.
        _engine_state["stt_loaded"] = True
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