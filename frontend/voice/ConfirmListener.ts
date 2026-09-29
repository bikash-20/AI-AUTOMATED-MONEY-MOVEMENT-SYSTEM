// ConfirmListener — voice "yes/no" confirmation after a review card.
//
// After a voice command produces a pending transaction (the wallet
// spoke back the review text), this listener takes over the mic for
// ~10 seconds and listens for the user to say "yes", "confirm",
// "okay", "do it", "no", "cancel", "stop".
//
// If matched, it dispatches the decision via the caller-provided
// callback. If no match within 10s, it gives up and the user can
// still click the Confirm/Cancel buttons in the UI.
//
// IMPORTANT: this reuses the same MicCapture that the wake-word
// loop uses (micCapture singleton). They're mutually exclusive
// because MicCapture.stop() tears down the VAD and mic stream.
//
// How matching works:
//   We send the captured audio to /voice/transcribe (the same backend
//   STT used for the main command), then string-match the transcript
//   against a small set of positive and negative phrases. This is
//   simpler and more reliable than a separate intent classifier for
//   such a constrained vocabulary.

import { micCapture } from "./MicCapture";

export type ConfirmDecision = "confirm" | "decline" | "no_match";

export interface ConfirmResult {
  decision: ConfirmDecision;
  transcript: string;
}

export interface ConfirmListenerOptions {
  userId: number;
  pendingId: number;
  // Max ms to listen. Default 10s.
  timeoutMs?: number;
  // Called when a decision is made (or timeout fires).
  onResult: (result: ConfirmResult) => void;
  // Called if mic capture or STT fails — treat as no_match so user
  // can still click buttons.
  onError?: (err: Error) => void;
}

// Phrases that count as "yes" — case-insensitive substring match.
const POSITIVE = [
  "yes", "yeah", "yep", "yup", "confirm", "do it", "ok", "okay",
  "sure", "please", "go ahead", "proceed", "send it", "approved",
];

// Phrases that count as "no".
const NEGATIVE = [
  "no", "nope", "nah", "cancel", "stop", "decline", "abort",
  "don't", "do not", "wait", "hold on",
];

function classify(transcript: string): ConfirmDecision {
  const t = transcript.toLowerCase().trim();
  if (!t) return "no_match";
  // Order matters: check negative first so "no, don't send it"
  // is classified as decline, not confirm.
  for (const phrase of NEGATIVE) {
    if (t.includes(phrase)) return "decline";
  }
  for (const phrase of POSITIVE) {
    if (t.includes(phrase)) return "confirm";
  }
  return "no_match";
}

export class ConfirmListener {
  private listening = false;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  async start(options: ConfirmListenerOptions): Promise<void> {
    if (this.listening) {
      console.warn("[confirm] start called while already listening, ignoring");
      return;
    }
    this.listening = true;
    const timeoutMs = options.timeoutMs ?? 10000;

    // Hard timeout — if user doesn't say anything, give up.
    this.timeoutHandle = setTimeout(() => {
      this.finish({
        decision: "no_match",
        transcript: "",
      }, options);
    }, timeoutMs);

    try {
      await micCapture.start(
        async (result) => {
          // Got captured audio — transcribe and classify.
          // We do the STT fetch here rather than in MicCapture to
          // keep MicCapture focused on capture only.
          try {
            const fd = new FormData();
            fd.append("audio", result.blob, "audio.wav");
            const resp = await fetch("/api/voice/transcribe", {
              method: "POST",
              body: fd,
            });
            if (!resp.ok) throw new Error(`transcribe ${resp.status}`);
            const json = await resp.json();
            const transcript = (json.text || "").trim();
            const decision = classify(transcript);
            this.finish({ decision, transcript }, options);
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            if (options.onError) options.onError(err);
            this.finish({ decision: "no_match", transcript: "" }, options);
          }
        },
        (err) => {
          // Capture-level error (mic permission, VAD never fired, etc).
          if (options.onError) options.onError(err);
          this.finish({ decision: "no_match", transcript: "" }, options);
        },
        {
          // Short max duration: confirm window is 10s total, leave
          // headroom for STT roundtrip.
          maxDurationMs: 8000,
          minDurationMs: 200, // even "yes" is ~300ms; allow shorter
        }
      );
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (options.onError) options.onError(err);
      this.finish({ decision: "no_match", transcript: "" }, options);
    }
  }

  private finish(result: ConfirmResult, options: ConfirmListenerOptions): void {
    if (!this.listening) return; // already finished
    this.listening = false;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    // Tear down mic capture so the wake-word loop can resume.
    micCapture.stop().catch(() => {});
    try {
      options.onResult(result);
    } catch (e) {
      console.warn("[confirm] onResult threw (ignored):", e);
    }
  }

  async cancel(): Promise<void> {
    if (!this.listening) return;
    this.listening = false;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    await micCapture.stop();
  }

  isListening(): boolean {
    return this.listening;
  }
}

// Singleton — one confirm listener per page.
export const confirmListener = new ConfirmListener();