"""Voice I/O — TTS queue/worker (Qwen3 -> Edge fallback) + STT helper.

Mirrors ~/python/AI ENGINEERING/voice.py:
  - speak() puts jobs on a queue; worker thread drains it
  - Qwen3-TTS via mlx-audio is the local, realistic voice
  - Edge TTS is the lightweight online fallback (default for v1)
  - afplay on macOS for non-blocking playback
"""
from __future__ import annotations

import os
import queue
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Optional

from . import config


# ---- TTS model state --------------------------------------------------------
_model = None
_model_lock = threading.Lock()
_tts_thread: Optional[threading.Thread] = None
_tts_queue: "queue.Queue[str | None]" = queue.Queue()


def _model_dir() -> str:
    explicit = (config.QWEN_TTS_MODEL_DIR or "").strip()
    if explicit:
        return explicit
    cached = Path.home() / ".cache/huggingface/hub/qwen3-tts-custom"
    if cached.exists() and (cached / "config.json").exists():
        return str(cached)
    return config.QWEN_TTS_MODEL


def _get_model():
    """Lazy-init Qwen3-TTS. Thread-safe."""
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        from mlx_audio.tts import load_model  # heavy import

        path = _model_dir()
        print(f"  [tts] loading Qwen3-TTS from {path}…")
        _model = load_model(path)
        print(f"  [tts] ready (speaker={config.QWEN_TTS_VOICE})")
        return _model


# ---- TTS synthesis ---------------------------------------------------------
def _edge_synthesize_to_wav(text: str, out_path: str) -> None:
    import asyncio

    try:
        import edge_tts
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "edge-tts is not installed. pip install edge-tts"
        ) from exc

    async def _run() -> None:
        comm = edge_tts.Communicate(text=text, voice=config.EDGE_TTS_VOICE)
        await comm.save(out_path)

    asyncio.run(_run())


def _qwen_synthesize_to_wav(text: str, out_path: str) -> None:
    model = _get_model()
    gen = model.generate_custom_voice(
        text=text,
        speaker=config.QWEN_TTS_VOICE,
        language=config.QWEN_TTS_LANG,
        instruct=config.QWEN_TTS_INSTRUCT or None,
    )
    try:
        result = next(iter(gen))
    except StopIteration:
        if not Path(out_path).exists() or Path(out_path).stat().st_size == 0:
            raise RuntimeError("Qwen3-TTS produced no audio")
        return
    audio = getattr(result, "audio", None)
    sr = getattr(result, "sample_rate", 24000)
    if audio is None or len(audio) == 0:
        raise RuntimeError("Qwen3-TTS produced empty audio")
    _save_wav(audio, sr, out_path)


def _synthesize_to_wav(text: str, out_path: str) -> None:
    engine = (config.TTS_ENGINE or "edge").strip().lower()
    if engine == "edge":
        try:
            _edge_synthesize_to_wav(text, out_path)
            return
        except RuntimeError as e:
            if "edge-tts is not installed" not in str(e):
                raise
            print("  [tts] Edge TTS unavailable; falling back to Qwen3.")
            try:
                _qwen_synthesize_to_wav(text, out_path)
                return
            except Exception:
                raise RuntimeError(
                    "No TTS backend available."
                ) from e
    if engine == "qwen":
        _qwen_synthesize_to_wav(text, out_path)
        return
    if engine == "off":
        # No-op but still produce an empty wav so callers don't choke.
        _save_wav(__import__("numpy").zeros((1,), dtype="float32"), 24000, out_path)
        return
    raise ValueError(f"Unsupported TTS_ENGINE={engine!r}")


def _save_wav(audio, sample_rate: int, out_path: str) -> None:
    import numpy as np
    from scipy.io import wavfile

    if hasattr(audio, "tolist"):
        try:
            audio = np.asarray(audio)
        except Exception:
            audio = np.array(audio.tolist())
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 2:
        if audio.shape[0] <= 8 and audio.shape[1] > audio.shape[0]:
            audio = audio.mean(axis=0)
        else:
            audio = audio.mean(axis=-1)
    audio = np.clip(audio, -1.0, 1.0)
    pcm = (audio * 32767.0).astype(np.int16)
    wavfile.write(out_path, int(sample_rate), pcm)


def _play_wav(path: str) -> None:
    try:
        subprocess.Popen(
            ["afplay", "-v", "1.0", path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        try:
            subprocess.Popen(
                ["aplay", path],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            print(f"  [tts] no audio player for {path}")


def _tts_worker() -> None:
    while True:
        text = _tts_queue.get()
        if text is None:
            break
        try:
            _speak_blocking(text)
        except Exception as e:  # noqa: BLE001
            print(f"  [tts] worker error: {e!r}")
        finally:
            _tts_queue.task_done()


def _speak_blocking(text: str) -> None:
    clean = " ".join(text.split())
    if not clean:
        return
    fd, path = tempfile.mkstemp(prefix="wallet_tts_", suffix=".wav")
    os.close(fd)
    try:
        _synthesize_to_wav(clean, path)
        _play_wav(path)
        # Wait briefly so afplay doesn't get killed mid-play.
        try:
            import time

            while subprocess.run(
                ["pgrep", "-f", f"afplay.*{Path(path).name}"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode == 0:
                time.sleep(0.2)
        except Exception:
            pass
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def speak(text: str) -> None:
    """Queue `text` for playback. Returns immediately."""
    if not config.VOICE_REPLY_ENABLED:
        return
    if not text or not text.strip():
        return
    global _tts_thread
    if _tts_thread is None or not _tts_thread.is_alive():
        _tts_thread = threading.Thread(target=_tts_worker, daemon=True)
        _tts_thread.start()
    _tts_queue.put(text)


def drain_and_stop() -> None:
    """Called at shutdown so audio doesn't get cut off."""
    if _tts_queue is not None and not _tts_queue.empty():
        try:
            _tts_queue.join()
        except Exception:
            pass
    _tts_queue.put(None)


# ---- STT --------------------------------------------------------------------
class STT:
    """Lazy wrapper around faster-whisper. Mirrors the pattern from
    ollama-local-model-website/voice_server.py."""

    def __init__(self):
        self._model = None
        self._lock = threading.Lock()

    def get(self):
        if self._model is None:
            with self._lock:
                if self._model is None:
                    from faster_whisper import WhisperModel

                    print(f"  [stt] loading faster-whisper {config.STT_MODEL} ({config.STT_COMPUTE})…")
                    self._model = WhisperModel(
                        config.STT_MODEL,
                        device="auto",
                        compute_type=config.STT_COMPUTE,
                    )
                    print("  [stt] ready.")
        return self._model

    def transcribe_bytes(self, audio_bytes: bytes, language: Optional[str] = None) -> tuple[str, str, float]:
        """Return (text, detected_language, duration_sec)."""
        import io

        model = self.get()
        buf = io.BytesIO(audio_bytes)
        buf.name = "audio.webm"
        segs, info = model.transcribe(
            buf, language=language, beam_size=1,
            vad_filter=True, condition_on_previous_text=False,
        )
        text = " ".join(s.text.strip() for s in segs).strip()
        return text, info.language, info.duration


_stt = STT()


def get_stt() -> STT:
    return _stt
