// MicCapture — single-utterance microphone capture with VAD auto-stop.
//
// Responsibilities:
//   1. Request mic permission (cached by browser after first grant).
//   2. Start Silero VAD on the mic stream.
//   3. When VAD fires onSpeechEnd, encode the captured audio to a
//      WebM/Opus blob and hand it to the caller.
//   4. Auto-stop after onSpeechEnd OR a hard max-duration timeout
//      (default 15s) so a runaway capture can't hang the UI.
//
// Why not reuse the existing VoiceButton.tsx MediaRecorder logic:
//   - VoiceButton is a click-to-start, click-to-stop manual control.
//   - MicCapture is voice-loop-driven (wake word → record → auto-stop).
//   - VoiceButton will REMAIN as a manual fallback button.
//   - MicCapture is the new automated path that the voice loop uses.
//
// Audio format note: the backend faster-whisper expects a file-like
// blob with a filename. faster-whisper's underlying library accepts
// most formats (webm, mp3, wav, m4a). WebM/Opus from MediaRecorder
// is the lowest-latency browser-supported format.

import { vad } from "./sileroVAD";

export interface CaptureResult {
  blob: Blob;
  durationMs: number;
  mimeType: string;
}

export interface CaptureOptions {
  // Hard timeout. If user speaks for longer than this, force-stop.
  // Default 15s. Should be < pending_ttl_seconds (60s) on backend.
  maxDurationMs?: number;
  // Min duration. Captures shorter than this are discarded
  // (user coughed, hit the mic, etc). Default 300ms.
  minDurationMs?: number;
}

export class MicCapture {
  private capturing = false;
  private startedAt = 0;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  async start(
    onResult: (result: CaptureResult) => void,
    onError: (err: Error) => void,
    options: CaptureOptions = {}
  ): Promise<void> {
    if (this.capturing) {
      console.warn("[mic] start called while capturing, ignoring");
      return;
    }
    const maxMs = options.maxDurationMs ?? 15000;
    const minMs = options.minDurationMs ?? 300;

    this.capturing = true;
    this.startedAt = Date.now();

    // Hard timeout — protects against VAD never firing (e.g. constant
    // background noise). After maxMs, force a speech_end with whatever
    // audio has been captured so far.
    this.timeoutHandle = setTimeout(() => {
      console.warn(`[mic] max duration ${maxMs}ms reached, force-stopping`);
      this.stop().catch(() => {});
    }, maxMs);

    try {
      await vad.start(
        {
          onSpeechStart: () => {
            // Speech detected — visual feedback handled by VoiceOrb via store state.
            // Nothing to do here; the audio is being captured by VAD's audio worklet.
          },
          onSpeechEnd: (audio) => {
            const durationMs = Date.now() - this.startedAt;
            // Encode Float32 → WAV blob. WAV is the most reliable format
            // for faster-whisper (no codec ambiguity).
            const wavBlob = encodeWav(audio, 16000);
            if (this.timeoutHandle) {
              clearTimeout(this.timeoutHandle);
              this.timeoutHandle = null;
            }
            this.capturing = false;
            if (durationMs < minMs) {
              // Too short — treat as misfire, don't send to STT.
              onError(new Error(`capture too short (${durationMs}ms), ignored`));
              return;
            }
            onResult({
              blob: wavBlob,
              durationMs,
              mimeType: "audio/wav",
            });
          },
          onError: (err) => {
            if (this.timeoutHandle) {
              clearTimeout(this.timeoutHandle);
              this.timeoutHandle = null;
            }
            this.capturing = false;
            onError(err);
          },
        },
        {
          minSpeechMs: 250,
          // Generous padding so we don't clip the first / last phoneme.
          speechPadMs: 200,
          positiveSpeechThreshold: 0.5,
          negativeSpeechThreshold: 0.35,
        }
      );
    } catch (e) {
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = null;
      }
      this.capturing = false;
      const err = e instanceof Error ? e : new Error(String(e));
      onError(err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    if (!this.capturing) return;
    this.capturing = false;
    try {
      await vad.stop();
    } catch (e) {
      console.warn("[mic] vad stop error (ignored):", e);
    }
  }

  isCapturing(): boolean {
    return this.capturing;
  }
}

// Singleton — only one capture at a time, and the voice loop owns it.
export const micCapture = new MicCapture();

// ---- WAV encoder ----------------------------------------------------------
// Float32 → 16-bit PCM WAV. Mono, 16kHz (matches Whisper's expected rate).
// ~50 lines of stdlib code, no external deps.
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  // Normalize: float32 in [-1, 1] → int16 in [-32768, 32767]
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataLength = samples.length * (bitsPerSample / 8);
  const bufferLength = 44 + dataLength;

  const buffer = new ArrayBuffer(bufferLength);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, "WAVE");
  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  // PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
