// Browser-side playback of TTS audio synthesized by the backend.
//
// Why this exists: the dashboard's spoken replies MUST use the backend's
// configured voice engine (Qwen3 / Edge / etc.), not the browser's built-in
// text-to-speech. Earlier versions of this file used window.speechSynthesis
// directly, which produced a flat robotic system voice regardless of what
// the user configured server-side. This module now:
//   1. POSTs the text to /voice/speak.
//   2. Receives a WAV blob from the configured TTS engine.
//   3. Plays it through an <audio> element.
//   4. Exposes an isSpeaking signal so the mic can be disabled while the
//      bot is talking (closes the mic→speaker feedback loop).
//
// Single-queue serialization: only ONE fetch + ONE <audio> is in flight at
// a time. New speakText() calls replace any queued-but-not-started text.
// This prevents the "multiple voices playing one by one" pile-up that
// happens when sendIntent / handleConfirm / onVoiceTranscript / ChatBar
// all call speakText independently within milliseconds.

export type SpeakingListener = (speaking: boolean) => void;

type Job = {
  text: string;
  onError?: (err: Error) => void;
  onEnd?: () => void;
  // Generation counter — bumped every time speakText() is called. Used to
  // detect stale fetch responses so a slow reply doesn't override a newer
  // utterance.
  generation: number;
};

const listeners = new Set<SpeakingListener>();
let activeAudio: HTMLAudioElement | null = null;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
let pending: Job | null = null; // next job to play
let draining = false;
let currentGeneration = 0;

export function isSpeaking(): boolean {
  return activeAudio !== null;
}

export function subscribeSpeaking(fn: SpeakingListener): () => void {
  listeners.add(fn);
  fn(activeAudio !== null);
  return () => {
    listeners.delete(fn);
  };
}

function setSpeaking(value: boolean) {
  listeners.forEach((l) => l(value));
}

function enterCooldown() {
  if (cooldownTimer) clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(() => {
    cooldownTimer = null;
    setSpeaking(false);
  }, 400);
}

function clearActiveAudio() {
  if (activeAudio) {
    try {
      activeAudio.pause();
      activeAudio.src = "";
    } catch {
      /* ignore */
    }
    activeAudio = null;
  }
}

/**
 * Speak `text` through the backend's configured TTS engine.
 *
 * If the backend fails to synthesize (model not loaded, network error,
 * unsupported engine), the error is propagated to the caller via `onError`.
 * We deliberately do NOT fall back to window.speechSynthesis — that was
 * exactly the bug this module rewrites.
 *
 * Behaviour: interrupt-and-replace. Anything currently playing is stopped
 * immediately. Any queued-but-not-started job is replaced by this one.
 * Only one TTS fetch is in flight at a time.
 */
export function speakText(
  text: string,
  options?: { onError?: (err: Error) => void; onEnd?: () => void }
): void {
  const clean = (text || "").replace(/[`*_]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return;
  if (typeof window === "undefined") return;

  // Stop anything currently playing so the new utterance takes over.
  if (activeAudio) {
    clearActiveAudio();
    if (cooldownTimer) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }
  }
  currentGeneration += 1;
  pending = {
    text: clean,
    onError: options?.onError,
    onEnd: options?.onEnd,
    generation: currentGeneration,
  };
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending) {
      const job = pending;
      pending = null;
      const myGen = job.generation;
      try {
        const wav = await fetchWav(job.text);
        // If another speakText() has been called since we started fetching,
        // drop this audio — the new job will be picked up by the loop.
        if (myGen !== currentGeneration) continue;
        await playBlob(wav, job);
      } catch (e) {
        if (myGen !== currentGeneration) continue; // stale
        const err = e instanceof Error ? e : new Error(String(e));
        job.onError?.(err);
      }
    }
  } finally {
    draining = false;
  }
}

async function fetchWav(text: string): Promise<Blob> {
  const res = await fetch("/api/voice/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.detail) detail += `: ${JSON.stringify(j.detail)}`;
    } catch {
      /* ignore */
    }
    throw new Error(`tts ${detail}`);
  }
  const blob = await res.blob();
  if (blob.size === 0) throw new Error("tts returned empty audio");
  return blob;
}

async function playBlob(blob: Blob, job: Job): Promise<void> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activeAudio = audio;
  setSpeaking(true);

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      if (activeAudio === audio) {
        clearActiveAudio();
        enterCooldown();
      }
      job.onEnd?.();
      resolve();
    };
    audio.onended = finish;
    audio.onerror = () => finish();
    audio.play().catch(() => finish());
  });
}

export function stopSpeaking(): void {
  if (typeof window === "undefined") return;
  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }
  clearActiveAudio();
  pending = null;
  currentGeneration += 1; // invalidate any in-flight fetch
  setSpeaking(false);
}
