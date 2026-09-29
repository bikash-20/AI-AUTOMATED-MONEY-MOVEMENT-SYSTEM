// Silero VAD wrapper — voice activity detection in the browser.
//
// Uses @ricky0123/vad-web which bundles:
//   - Silero VAD v5 ONNX model (~2MB, loaded from CDN by default)
//   - onnxruntime-web (already a peer dep)
//   - AudioWorklet for sample-accurate processing
//
// Why this and not a hand-rolled ONNX wrapper:
//   - AudioWorklet plumbing is fiddly (audio thread ↔ main thread messaging)
//   - VAD frame sizes must match the model (512 / 1024 / 1600 samples)
//   - Pre-emphasis + normalization is non-trivial
//   The package handles all of it; we just listen for events.
//
// Model loading note: by default @ricky0123/vad-web fetches the ONNX model
// from a CDN URL. For air-gapped / local-only use we can override via
// `baseAssetPath` to point at our /public folder, but for the demo the
// CDN fetch is fine — the model is small (~2MB) and cached.
//
// IMPORTANT: this module is ONLY used during an active capture session
// (state === "capturing"). It's loaded on demand and torn down on stop.
// Wake-word detection (state === "wake_listening") uses a separate,
// even lighter mechanism (see openWakeWord.ts).

import { MicVAD } from "@ricky0123/vad-web";

export interface VADCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void; // captured audio since speech start
  onError?: (err: Error) => void;
}

export interface VADOptions {
  // Minimum speech duration (ms) before triggering speech_end.
  // Default 250ms — filters out coughs, keyboard clicks.
  minSpeechMs?: number;
  // Padding (ms) added before speech_start and after speech_end.
  // Helps capture the first/last phonemes. Default 100ms.
  speechPadMs?: number;
  // PositiveSpeechThreshold: probability above which a frame is "speech".
  // Range 0..1. Default 0.5 (balanced).
  positiveSpeechThreshold?: number;
  // NegativeSpeechThreshold: probability below which speech_end fires.
  // Default 0.35 (must be < positiveSpeechThreshold).
  negativeSpeechThreshold?: number;
}

export class SileroVAD {
  private vad: MicVAD | null = null;
  private active = false;
  private callbacks: VADCallbacks | null = null;

  async start(callbacks: VADCallbacks, options: VADOptions = {}): Promise<void> {
    if (this.active) {
      console.warn("[vad] start called while already active, ignoring");
      return;
    }
    this.callbacks = callbacks;
    this.active = true;
    try {
      this.vad = await MicVAD.new({
        minSpeechMs: options.minSpeechMs ?? 250,
        preSpeechPadMs: options.speechPadMs ?? 100,
        positiveSpeechThreshold: options.positiveSpeechThreshold ?? 0.5,
        negativeSpeechThreshold: options.negativeSpeechThreshold ?? 0.35,
        onSpeechStart: () => {
          if (this.callbacks?.onSpeechStart) this.callbacks.onSpeechStart();
        },
        onSpeechEnd: (audio) => {
          if (this.callbacks?.onSpeechEnd) {
            this.callbacks.onSpeechEnd(audio);
          }
        },
        onVADMisfire: () => {
          // VAD triggered but no real speech detected (e.g. noise burst).
          // Just ignore — caller will get a speech_end with very short audio.
        },
      });
    } catch (e) {
      this.active = false;
      const err = e instanceof Error ? e : new Error(String(e));
      if (callbacks.onError) callbacks.onError(err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.vad || !this.active) return;
    this.active = false;
    this.callbacks = null;
    try {
      await this.vad.destroy();
    } catch (e) {
      console.warn("[vad] destroy error (ignored):", e);
    } finally {
      this.vad = null;
    }
  }

  isActive(): boolean {
    return this.active;
  }
}

// Singleton — only one VAD instance needed across the app.
export const vad = new SileroVAD();
