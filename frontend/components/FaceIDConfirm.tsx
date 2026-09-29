"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Scan, ShieldCheck, X } from "lucide-react";
import {
  FACE_MATCH_THRESHOLD,
  FaceMatchResult,
  cosineSimilarity,
  getEmbedding,
  loadModels,
  match,
  openCamera,
  readStoredEmbedding,
  stopCamera,
} from "@/lib/face";

// re-export for consumers that want the type
export type { FaceMatchResult };

type Phase =
  | "loading-models"
  | "requesting-camera"
  | "scanning"
  | "matched"
  | "not-matched"
  | "needs-enrollment"
  | "camera-error"
  | "cancelled";

/**
 * Face ID confirmation overlay for sensitive actions (currently: payment
 * confirmation). Shows a camera preview, runs the detector on each frame,
 * and only resolves `onMatch()` when the captured embedding scores at or
 * above FACE_MATCH_THRESHOLD against the user's stored embedding.
 *
 * Lifecycle:
 *   1. On mount → loadModels() (cached after first call) → openCamera().
 *   2. We re-check the user has a stored embedding in localStorage. If
 *      not, we surface a "needs enrollment" state instead of forcing
 *      the user to enroll inline here — enrollment belongs in settings.
 *   3. We poll getEmbedding() ~3x per second on a rAF loop, displaying
 *      a real-time similarity score so the user has feedback.
 *   4. As soon as the score crosses the threshold we call onMatch() and
 *      stop the camera. Three consecutive misses flip us to "not-matched"
 *      and surface a manual "Try again" button.
 *
 * The camera stream is ALWAYS released on unmount, even on error paths —
 * the browser's camera-active indicator MUST go off when the modal
 * closes, otherwise users immediately distrust the whole feature.
 */
export function FaceIDConfirm({
  userId,
  onMatch,
  onCancel,
  onEnrollInstead,
}: {
  userId: number;
  onMatch: () => void;
  onCancel: () => void;
  onEnrollInstead?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const stopFlagRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("loading-models");
  const [score, setScore] = useState<number | null>(null);
  const [storedMissing, setStoredMissing] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  // ---- Lifecycle: load models, open camera, start scanning --------------
  useEffect(() => {
    let cancelled = false;
    stopFlagRef.current = false;

    async function setup() {
      try {
        await loadModels();
        if (cancelled) return;

        // Confirm we have something to match against. The localStorage
        // copy is the source of truth for live matching; the server copy
        // is the recovery backup.
        const stored = readStoredEmbedding(userId);
        if (!stored || stored.length === 0) {
          setStoredMissing(true);
          setPhase("needs-enrollment");
          return;
        }

        setPhase("requesting-camera");
        const stream = await openCamera();
        if (cancelled) {
          stopCamera(stream);
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        // iOS Safari requires explicit play() to start the stream flowing.
        await v.play().catch(() => {
          /* play() may reject if interrupted; we'll catch the next frame */
        });
        if (cancelled) return;
        setPhase("scanning");
        void scanLoop(stored);
      } catch (e) {
        if (cancelled) return;
        setErrorDetail(formatCameraError(e));
        setPhase("camera-error");
      }
    }

    void setup();

    return () => {
      cancelled = true;
      stopFlagRef.current = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      stopCamera(streamRef.current);
      streamRef.current = null;
    };
  }, [userId]);

  // ---- Scanner loop ------------------------------------------------------
  // Runs ~3x/sec (every 12 frames at 60fps) so the user sees a real-time
  // score without burning CPU. We deliberately do NOT match on every
  // frame — face-api.js takes ~30ms per call and we'd starve the UI
  // thread if we ran it at 60Hz.
  async function scanLoop(stored: number[]) {
    const v = videoRef.current;
    if (!v) return;
    const FRAME_SKIP = 12;
    let frame = 0;
    let missCount = 0;

    const tick = async () => {
      if (stopFlagRef.current) return;
      frame++;
      if (frame % FRAME_SKIP === 0) {
        try {
          const emb = await getEmbedding(v);
          if (emb) {
            const s = cosineSimilarity(emb, stored);
            setScore(s);
            const result: FaceMatchResult = match(emb, stored, FACE_MATCH_THRESHOLD);
            if (result.ok) {
              setPhase("matched");
              // Brief "matched" beat before the parent fires onMatch().
              // 350ms gives the user the visual confirmation that the
              // camera worked, so the subsequent balance change doesn't
              // feel like it came out of nowhere.
              setTimeout(() => {
                if (!stopFlagRef.current) onMatch();
              }, 350);
              return;
            }
            missCount = 0;
          } else {
            // No face in this frame — bump miss counter and only fail
            // out after a few empty frames so the user has time to
            // settle into frame.
            missCount++;
            if (missCount >= 6) {
              setPhase("not-matched");
              missCount = 0;
            }
          }
        } catch {
          /* transient — keep scanning */
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  // ---- Render ------------------------------------------------------------
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      aria-label="Face ID confirmation"
    >
      <div
        className="absolute inset-0 bg-plum-950/80 backdrop-blur-sm"
        onClick={onCancel}
      />
      <motion.div
        className="relative w-full max-w-md glass-strong rounded-2xl p-6"
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        <button
          type="button"
          onClick={onCancel}
          className="absolute top-4 right-4 text-cream/70 hover:text-cream"
          aria-label="Close"
        >
          <X size={20} strokeWidth={1.8} />
        </button>

        <div className="flex items-center gap-2 mb-2">
          <Scan size={20} className="text-peach-500" />
          <h2 className="text-lg font-bold text-cream">Confirm with Face ID</h2>
        </div>
        <p className="text-sm text-secondary mb-4">
          Look at the camera to confirm this payment.
        </p>

        {/* Camera viewport */}
        <div className="relative aspect-[4/3] w-full rounded-xl overflow-hidden bg-plum-950 mb-4 ring-1 ring-white/10">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            // Mirror the preview — webcams are unmirrored by default
            // and that disorients users who expect a "mirror" view.
            className="absolute inset-0 w-full h-full object-cover scale-x-[-1]"
          />
          {phase === "scanning" && score !== null ? (
            <ScoreOverlay score={score} />
          ) : null}
          {phase === "matched" ? (
            <MatchedOverlay />
          ) : null}
          {phase === "loading-models" ||
          phase === "requesting-camera" ? (
            <CenterStatus
              label={
                phase === "loading-models"
                  ? "Loading Face ID models…"
                  : "Opening camera…"
              }
            />
          ) : null}
          {phase === "camera-error" ? (
            <CenterStatus label={errorDetail ?? "Camera unavailable"} />
          ) : null}
        </div>

        {/* Status row / actions */}
        <div className="text-sm text-cream/80 mb-3 min-h-[1.25rem]">
          {phase === "scanning" && score !== null ? (
            score >= FACE_MATCH_THRESHOLD ? (
              <span className="text-mint-400">Match confirmed</span>
            ) : score >= FACE_MATCH_THRESHOLD - 0.15 ? (
              <span>Almost there — keep looking at the camera…</span>
            ) : (
              <span className="text-secondary">
                Position your face in good light, then hold still.
              </span>
            )
          ) : phase === "not-matched" ? (
            <span className="text-peach-500">
              Face doesn&apos;t match. Try again.
            </span>
          ) : phase === "needs-enrollment" ? (
            <span className="text-secondary">
              You haven&apos;t enrolled a face yet — enroll once and confirm
              next time without typing.
            </span>
          ) : phase === "matched" ? (
            <span className="text-mint-400">Face matched. Confirming…</span>
          ) : null}
        </div>

        <div className="flex gap-2">
          {phase === "needs-enrollment" && onEnrollInstead ? (
            <button
              type="button"
              onClick={onEnrollInstead}
              className="btn-peach rounded-lg px-5 py-2 flex-1 text-sm font-semibold"
            >
              Enroll my face
            </button>
          ) : phase === "not-matched" || phase === "camera-error" ? (
            <button
              type="button"
              onClick={onCancel}
              className="btn-ghost rounded-lg px-5 py-2 flex-1 text-sm"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={onCancel}
              className="btn-ghost rounded-lg px-5 py-2 flex-1 text-sm"
            >
              Cancel
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ---- Sub-components --------------------------------------------------------

function ScoreOverlay({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(1, (score + 0.2) / 1.2));
  const pass = score >= FACE_MATCH_THRESHOLD;
  return (
    <div className="absolute bottom-0 inset-x-0 p-3 bg-gradient-to-t from-plum-950/85 to-transparent">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-cream/80 font-mono">
          match {(score * 100).toFixed(0)}%
        </span>
        <span className={pass ? "text-mint-400" : "text-cream/60"}>
          need {(FACE_MATCH_THRESHOLD * 100).toFixed(0)}%
        </span>
      </div>
      <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
        <div
          className={
            pass
              ? "h-full bg-mint-400 transition-[width] duration-150"
              : "h-full bg-peach-500 transition-[width] duration-150"
          }
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}

function MatchedOverlay() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-mint-400/20 backdrop-blur-[1px]">
      <div className="flex flex-col items-center gap-2 text-mint-400">
        <ShieldCheck size={56} strokeWidth={1.6} />
        <span className="text-sm font-semibold">Face matched</span>
      </div>
    </div>
  );
}

function CenterStatus({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-cream/70">
        <Scan size={36} strokeWidth={1.5} className="animate-pulse" />
        <span className="text-sm">{label}</span>
      </div>
    </div>
  );
}

function formatCameraError(e: unknown): string {
  const err = e as { name?: string; message?: string };
  if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
    return "Camera access denied. Allow camera permission and try again.";
  }
  if (err?.name === "NotFoundError" || err?.name === "DevicesNotFoundError") {
    return "No camera found on this device.";
  }
  if (err?.name === "NotReadableError" || err?.name === "TrackStartError") {
    return "Camera is in use by another app.";
  }
  return err?.message ?? "Camera unavailable";
}
