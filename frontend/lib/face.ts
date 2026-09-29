// Browser-side face detection + embedding extraction.
//
// All matching happens in the browser — the server stores an opaque
// 128-dim float vector per user and never sees the raw webcam frames.
//
// Threat model: this is a *demo* biometric. It raises the cost of
// accidental shoulder-surfing and stops a casual user from confirming
// while a different person is at the screen. It is NOT a security
// boundary — the matching is fully client-side and trivially bypassable
// by anyone with browser DevTools.
//
// Performance notes:
//   - tiny_face_detector is ~5x faster than the default ssd_mobilenetv1
//     detector and is more than accurate enough for a 50cm webcam distance.
//   - face_landmark_68_tiny is required by face_recognition_net for
//     alignment — without it the embedding is rotation/scale sensitive.
//   - We deliberately do NOT use face_expression/age/gender nets; we only
//     need the descriptor.

// We intentionally do NOT statically import face-api.js at the top of
// this module — face-api.js's transitive deps (tfjs-core → node-fetch)
// reach into Node built-ins (`fs`, `encoding`) that webpack can't bundle
// for the client without warnings. Doing a static `import * as faceapi`
// would also break the production build because the dynamic chunk
// emitted for FaceIDConfirm (ssr:false) would still trace those imports.
//
// We also can't use `import type * as FaceApiTypes from "face-api.js"`
// — webpack's module graph resolves the specifier at parse time even
// for type-only imports (TypeScript erases them later, but the bundler
// has already failed). So we describe the shapes we need inline below.
//
// Instead, we lazy-import face-api.js inside each function that needs
// it. The first call pays the ~1.2 MB parse cost; subsequent calls hit
// the cached module reference.

// Inline structural types for the parts of face-api.js we touch. These
// match the public API of face-api.js v0.22.x; if upstream changes them,
// the runtime import will catch the mismatch.
type FaceApiTinyDetectorOptionsCtor = new (opts: {
  inputSize: number;
  scoreThreshold: number;
}) => unknown;

type FaceApiModule = {
  TinyFaceDetectorOptions: FaceApiTinyDetectorOptionsCtor;
  nets: {
    tinyFaceDetector: { loadFromUri: (uri: string) => Promise<void> };
    faceLandmark68TinyNet: { loadFromUri: (uri: string) => Promise<void> };
    faceRecognitionNet: { loadFromUri: (uri: string) => Promise<void> };
  };
  detectSingleFace: (
    input: HTMLVideoElement,
    options: unknown
  ) => {
    withFaceLandmarks: (
      tiny: boolean
    ) => {
      withFaceDescriptor: () => Promise<{ descriptor: ArrayLike<number> } | null>;
    };
  };
};

// Match the server's `cosine_similarity` in backend/app/routers/accounts.py.
// Keeping these in lockstep means a face that matches in the browser will
// also pass any server-side check we add later.
export const FACE_MATCH_THRESHOLD = 0.6;

// Where we mounted the model weights in /public. Must match next.config.js.
const MODEL_URL = "/models/face-api";

// ---- Module-level state ----------------------------------------------------
let modelsPromise: Promise<void> | null = null;
let detectorOptions: unknown = null;
let faceApiModule: FaceApiModule | null = null;

async function getFaceApi(): Promise<FaceApiModule> {
  if (faceApiModule) return faceApiModule;
  faceApiModule = (await import("face-api.js")) as unknown as FaceApiModule;
  return faceApiModule;
}

export type FaceMatchResult =
  | { ok: true; score: number }
  | { ok: false; reason: "no-face" | "low-score"; score?: number };

// ---- Model loading ---------------------------------------------------------
/**
 * Load the three face-api.js models we need. Idempotent: every caller
 * resolves to the same Promise, so racing callers don't trigger two
 * downloads.
 *
 * Safe to call on the server (returns a never-resolving Promise so SSR
 * render paths don't accidentally try to load ~4 MB of weights into
 * Node).
 */
export function loadModels(): Promise<void> {
  if (typeof window === "undefined") {
    return new Promise(() => {
      /* never resolves server-side */
    });
  }
  if (modelsPromise) return modelsPromise;
  modelsPromise = (async () => {
    const faceapi = await getFaceApi();
    // Tiny detector: 320x240 input, ~0.5 confidence threshold. This is
    // the smallest detector that face-api.js ships with and is fine for
    // a head-on webcam shot. Bump inputSize to 416 if we see misses at
    // >1m distance.
    detectorOptions = new faceapi.TinyFaceDetectorOptions({
      inputSize: 320,
      scoreThreshold: 0.5,
    });
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
  })();
  return modelsPromise;
}

export function areModelsLoaded(): boolean {
  return detectorOptions !== null && modelsPromise !== null;
}

// ---- Camera ----------------------------------------------------------------
export type CameraError = "not-allowed" | "not-found" | "in-use" | "unknown";

/**
 * Open the user's webcam. Resolves to a MediaStream the caller must
 * attach to a <video> element (and MUST release via `stopCamera` when
 * done — the camera light staying on is the #1 trust-destroyer for
 * any face-recognition UX).
 */
export async function openCamera(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    throw new Error("camera API not available in this environment");
  }
  return navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      facingMode: "user",
    },
    audio: false,
  });
}

/** Stop every track on the stream so the camera indicator goes off. */
export function stopCamera(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  }
}

// ---- Detection -------------------------------------------------------------
/**
 * Run the full detector+landmarks+recognizer pipeline on a single frame
 * of the given video element and return the resulting 128-dim embedding.
 * Returns null if no face is detected in this frame.
 *
 * Important: this MUST be called with `await` between frames so the
 * browser has time to paint the next video frame — calling it in a
 * tight loop will produce stale embeddings from the same frame.
 */
export async function getEmbedding(
  video: HTMLVideoElement
): Promise<number[] | null> {
  if (!areModelsLoaded() || !detectorOptions) {
    throw new Error("face models not loaded — call loadModels() first");
  }
  // Guard: faceapi needs a video that has actually started producing
  // frames, otherwise every call returns NaN embeddings.
  if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
    return null;
  }
  const faceapi = await getFaceApi();
  const detection = await faceapi
    .detectSingleFace(video, detectorOptions)
    .withFaceLandmarks(true) // tiny model
    .withFaceDescriptor();
  if (!detection) return null;
  // Float32Array → plain array. JSON.stringify over a Float32Array
  // produces `{}`, which would silently corrupt the server payload.
  return Array.from(detection.descriptor);
}

// ---- Matching --------------------------------------------------------------
/**
 * Cosine similarity. Returns a value in [-1, 1]; for aligned face
 * embeddings the practical range is [0.3, 1.0]. Anything below
 * FACE_MATCH_THRESHOLD (0.6) is treated as "different person".
 *
 * Defensive against dimension mismatch and zero-norm vectors — those
 * return 0.0 rather than NaN, matching the server-side helper so the
 * two implementations never disagree on the boundary case.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Compare a freshly-captured embedding against the stored one and decide
 * whether it's the same person. Returns a discriminated union so the
 * UI can give a precise reason ("no face found" vs "different face")
 * rather than a single binary yes/no.
 */
export function match(
  captured: number[],
  stored: number[],
  threshold: number = FACE_MATCH_THRESHOLD
): FaceMatchResult {
  const score = cosineSimilarity(captured, stored);
  if (score >= threshold) return { ok: true, score };
  return { ok: false, reason: "low-score", score };
}

// ---- Local-storage mirror --------------------------------------------------
// The read/clear helpers used to live here, but they were pulled out into
// `lib/face-storage.ts` so that callers which only need the local mirror
// (e.g. SettingsModal — statically imported by the main page bundle)
// don't drag face-api.js into the main chunk through the module graph.
// Re-export them here for any existing imports that point at `@/lib/face`.
export {
  readStoredEmbedding,
  writeStoredEmbedding,
  clearStoredEmbedding,
} from "./face-storage";
