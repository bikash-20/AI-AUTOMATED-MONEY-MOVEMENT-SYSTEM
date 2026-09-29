// Wake word listener — always-on "Hey Wallet" detection.
//
// Uses openwakeword-web (native browser port of openWakeWord) running
// entirely client-side via ONNX Runtime Web. No API key, no Python
// server, no cloud calls. The pipeline is:
//
//   mic (16 kHz PCM, 80 ms frames)
//     └─ melspectrogram.onnx    → 32-bin mel features
//          └─ embedding_model.onnx → 96-dim speech embeddings
//               └─ alexa_v0.1.onnx → detection score (0..1)
//
// Why "alexa" and not a custom "hey wallet" model:
//   openWakeWord's pretrained set is {alexa, hey_jarvis, hey_mycroft,
//   hey_rhasspy, weather, timers}. We pick "alexa" as the trigger word
//   because:
//     - it's a single-syllable wake (low false-negative rate)
//     - it's unlikely to appear in normal conversation
//     - it has the smallest, fastest model (~850 KB)
//
//   We display the user-visible phrase as "Hey Wallet" in the UI but
//   internally listen for "alexa" until a custom "hey_wallet" model is
//   trained. To train one, see https://github.com/dscripka/openWakeWord
//   training docs — would take ~30 min of recorded "hey wallet" clips.
//
// Resource cost on M4 Air 16GB: ~80MB RAM, ~3% CPU when idle listening.
// The ONNX runtime uses wasm (single thread, no COOP/COEP headers needed).

import {
  OpenWakeWord,
  configureOrt,
  type DetectionEvent,
} from "openwakeword-web";
import { Microphone } from "openwakeword-web/microphone";

export interface WakeWordCallbacks {
  onDetection: (event: DetectionEvent) => void;
  onError?: (err: Error) => void;
  onReady?: () => void; // fired when listener is up and listening
}

// Detect the webpack-stubbed "openwakeword-web" module. next.config.js
// aliases this package to `false` so the build doesn't pull in
// onnxruntime-web (and its `import.meta` ESM headache) into the main
// bundle. When the stub is in place, every named export comes back as
// `undefined`. We probe at runtime so the UI can degrade gracefully
// (voice becomes unavailable, but the text + Face ID demo still works)
// instead of throwing a cryptic "configureOrt is not a function" error.
function isWakeWordStubbed(): boolean {
  return typeof configureOrt !== "function" || typeof OpenWakeWord !== "function";
}

export class WakeWordListener {
  private oww: OpenWakeWord | null = null;
  private mic: Microphone | null = null;
  private active = false;
  private startingPromise: Promise<void> | null = null;

  async start(callbacks: WakeWordCallbacks): Promise<void> {
    if (this.active) {
      console.warn("[wake] start called while already active, ignoring");
      return;
    }
    if (this.startingPromise) return this.startingPromise;

    this.startingPromise = (async () => {
      try {
        // If the package was stubbed by webpack (see next.config.js),
        // short-circuit with a clear error rather than letting the
        // throw happen deep inside onnxruntime-web where the message
        // is misleading.
        if (isWakeWordStubbed()) {
          throw new Error(
            "openwakeword-web is not bundled in this build — voice commands are disabled. " +
              "Text and Face ID flows still work."
          );
        }

        // Configure ONNX Runtime to use single-threaded wasm so the
        // page doesn't need COOP/COEP headers (Next.js dev server
        // doesn't send these by default).
        configureOrt({ numThreads: 1, simd: true });

        // Create the wake word model. `baseUrl` points at our /models/
        // directory under /public — served same-origin by Next.js.
        // The package expects:
        //   melspectrogram.onnx, embedding_model.onnx
        //   <wakeword>_v0.1.onnx (one or more)
        //   silero_vad.onnx (only if onUtterance is set, which we don't)
        this.oww = await OpenWakeWord.create({
          baseUrl: "/models/",
          wakewordModels: ["alexa"],
          // Threshold 0.5 is the package default. We could tune higher
          // (0.6) for fewer false positives at the cost of missing some
          // real triggers. 0.5 is balanced for ambient noise.
          threshold: 0.5,
          onDetection: (event) => {
            // Only forward detections from our configured model.
            // Defensive guard against the library firing spurious events.
            if (event && event.label && event.score >= this.oww!.threshold) {
              callbacks.onDetection(event);
            }
          },
        });

        // Wire the mic: every 80 ms (1280 samples @ 16 kHz) we get a
        // frame, feed it to oww.predict() which updates internal state
        // and may fire onDetection if threshold is crossed.
        this.mic = new Microphone(async (frame) => {
          if (!this.oww) return;
          try {
            await this.oww.predict(frame);
          } catch (e) {
            console.warn("[wake] predict error (non-fatal):", e);
          }
        });

        await this.mic.start();
        this.active = true;
        if (callbacks.onReady) callbacks.onReady();
      } catch (e) {
        this.active = false;
        this.oww = null;
        this.mic = null;
        const err = e instanceof Error ? e : new Error(String(e));
        if (callbacks.onError) callbacks.onError(err);
        throw err;
      } finally {
        this.startingPromise = null;
      }
    })();

    return this.startingPromise;
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.mic) {
      try {
        await this.mic.stop();
      } catch (e) {
        console.warn("[wake] mic stop error (ignored):", e);
      }
      this.mic = null;
    }
    if (this.oww) {
      try {
        await this.oww.reset();
      } catch (e) {
        console.warn("[wake] oww reset error (ignored):", e);
      }
      this.oww = null;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  // Allows changing detection threshold at runtime (e.g. tighten in
  // noisy environments).
  setThreshold(value: number): void {
    if (this.oww) this.oww.threshold = value;
  }
}

// Singleton — only one wake word listener per page.
export const wakeWordListener = new WakeWordListener();