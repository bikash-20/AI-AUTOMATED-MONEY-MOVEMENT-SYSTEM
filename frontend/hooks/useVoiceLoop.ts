// useVoiceLoop — top-level orchestrator for the voice system.
//
// Owns the full voice lifecycle:
//   1. On mount: ask for mic permission, init wake word listener.
//   2. On wake-word detection: capture utterance via wake-word's built-in
//      onUtterance OR fall back to MicCapture if that path is unavailable.
//   3. On utterance captured: STT via /voice/transcribe.
//   4. On transcript: POST to /agent/act (same endpoint chat uses).
//   5. On card returned (review needed): speak the review, then start
//      ConfirmListener for yes/no.
//   6. On confirm/decline: POST to /agent/confirm, speak the result.
//
// CRITICAL: this hook does NOT render any UI. It just owns state and
// side effects. UI is the VoiceOrb component which subscribes to the
// voice store.
//
// CRITICAL: this hook does NOT call into chat code. It calls
// /agent/act and /agent/confirm directly via fetch — the same HTTP
// endpoints chat uses, but with a different caller. This keeps the
// chat system completely isolated from the voice system.

"use client";

import { useEffect, useRef } from "react";
import { useVoiceStore } from "@/voice/voiceStore";
import { wakeWordListener } from "@/voice/openWakeWord";
import { micCapture } from "@/voice/MicCapture";
import { confirmListener } from "@/voice/ConfirmListener";
import { attachChatCoordination } from "@/voice/chatCoordination";
import { speakText, subscribeSpeaking, isSpeaking } from "@/lib/speech";
import { api } from "@/lib/api";

// Generate a UUID v4 — used for idempotency keys. Avoids needing a
// polyfill; uses crypto.randomUUID() which is available in all
// modern browsers including Safari 15.4+.
function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers — sufficient entropy for client-side use.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function useVoiceLoop(userId: number, onAfterAct?: (resp: { text: string; pending_id?: number | null }) => void): void {
  // Keep latest userId in a ref so the closure-captured listener
  // always uses the current user.
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  // Keep latest callback ref.
  const onAfterActRef = useRef(onAfterAct);
  onAfterActRef.current = onAfterAct;

  useEffect(() => {
    let cleanupChatCoord: (() => void) | null = null;
    let cancelled = false;

    const store = useVoiceStore.getState();

    // ---- 1. Chat coordination bridge (Step 8) -------------------
    cleanupChatCoord = attachChatCoordination();

    // ---- 2. Pre-warm STT on backend ----------------------------
    // Fire-and-forget — first voice command should be fast.
    fetch("/api/voice/wake-status")
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j?.ready) store.setSttReady(true);
      })
      .catch(() => {
        // Ignore — non-critical.
      });

    // ---- 3. Init wake word listener ----------------------------
    async function initWakeWord() {
      try {
        // Request mic permission lazily so the user only sees the
        // browser permission prompt when they actually want voice.
        // We do this here so the wake word listener can start.
        // If permission is denied, the listener will throw and we
        // mark state accordingly.
        await wakeWordListener.start({
          onReady: () => {
            if (!cancelled) {
              store.setMicPermission("granted");
              store.setState("wake_listening");
            }
          },
          onError: (err) => {
            console.error("[voice-loop] wake word init error:", err);
            if (!cancelled) {
              const msg = err.message || String(err);
              if (msg.includes("Permission") || msg.includes("denied")) {
                store.setMicPermission("denied");
              }
              store.setError(`Wake-word unavailable: ${msg}`);
            }
          },
          onDetection: (event) => {
            if (cancelled) return;
            console.log("[voice-loop] wake detected:", event.label);
            // Move to capturing state. The actual command capture
            // happens via MicCapture which kicks off immediately.
            // (We don't use openWakeWord's onUtterance because we
            // need our own VAD-tuned capture with longer max duration
            // and tighter min-speech threshold.)
            store.setState("capturing");
            startCommandCapture();
          },
        });
      } catch (e) {
        if (!cancelled) {
          store.setError(e instanceof Error ? e.message : String(e));
        }
      }
    }

    // ---- 4. Command capture → STT → /agent/act ----------------
    async function startCommandCapture() {
      try {
        await micCapture.start(
          async (result) => {
            // Got audio. Stop wake word so it doesn't double-trigger.
            await wakeWordListener.stop();
            store.setState("transcribing");
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
              if (!transcript) {
                speakText("Sorry, I didn't catch that. Try again.");
                await gotoIdle();
                return;
              }
              store.setTranscript(transcript);
              store.setState("processing");
              await processCommand(transcript);
            } catch (e) {
              console.error("[voice-loop] STT error:", e);
              store.setError(e instanceof Error ? e.message : String(e));
              speakText("Sorry, I couldn't understand. Please try again.");
              await gotoIdle();
            }
          },
          async (err) => {
            console.warn("[voice-loop] capture error:", err.message);
            // Treat "too short" as silent — don't speak, just resume.
            await gotoIdle();
          },
          { maxDurationMs: 15000, minDurationMs: 300 }
        );
      } catch (e) {
        console.error("[voice-loop] mic capture start failed:", e);
        store.setError(e instanceof Error ? e.message : String(e));
        await gotoIdle();
      }
    }

    async function processCommand(transcript: string) {
      try {
        const resp = await api.agentAct({
          user_id: userIdRef.current,
          text: transcript,
          idempotency_key: uuid(),
        });
        store.setResponse(resp.text);

        // Speak the response first.
        store.setState("speaking");
        speakText(resp.text);

        // Notify page-level orchestrator (for refreshing history etc).
        if (onAfterActRef.current) {
          try { onAfterActRef.current(resp); } catch {}
        }

        // If a review card is needed, start the confirm listener.
        if (resp.card && resp.pending_id) {
          // Wait for TTS to finish playing before asking for confirmation.
          await waitForSpeechEnd();
          store.setPendingId(resp.pending_id);
          store.setState("awaiting_confirmation");
          await startConfirmListener(resp.pending_id);
        } else {
          // No review needed (e.g. balance check, history list).
          await waitForSpeechEnd();
          await gotoIdle();
        }
      } catch (e) {
        console.error("[voice-loop] /agent/act failed:", e);
        const msg = e instanceof Error ? e.message : String(e);
        store.setError(msg);
        speakText("Sorry, something went wrong. Please try again.");
        await gotoIdle();
      }
    }

    // ---- 5. Confirm listener (yes/no) --------------------------
    async function startConfirmListener(pendingId: number) {
      try {
        await confirmListener.start({
          userId: userIdRef.current,
          pendingId,
          timeoutMs: 10000,
          onResult: async (result) => {
            if (result.decision === "no_match") {
              // Timed out or unrecognized — let user click buttons.
              speakText("Please say yes or no, or use the buttons.");
              await gotoIdle();
              return;
            }
            const decision = result.decision;
            store.setState(decision === "confirm" ? "confirming" : "declining");
            try {
              const resp = await api.agentConfirm({
                user_id: userIdRef.current,
                pending_id: pendingId,
                idempotency_key: uuid(),
                decision,
              });
              store.setResponse(resp.text);
              store.setState("speaking");
              speakText(resp.text);
              if (onAfterActRef.current) {
                try {
                  onAfterActRef.current({ text: resp.text });
                } catch {}
              }
              await waitForSpeechEnd();
              await gotoIdle();
            } catch (e) {
              console.error("[voice-loop] confirm failed:", e);
              store.setError(e instanceof Error ? e.message : String(e));
              speakText("Sorry, the confirmation didn't go through.");
              await gotoIdle();
            }
          },
          onError: (err) => {
            console.warn("[voice-loop] confirm listener error:", err.message);
          },
        });
      } catch (e) {
        console.error("[voice-loop] startConfirmListener failed:", e);
        await gotoIdle();
      }
    }

    // ---- Helpers ----------------------------------------------
    async function gotoIdle() {
      store.setPendingId(null);
      // Restart wake word listener so the user can say another command.
      try {
        await wakeWordListener.stop();
        await wakeWordListener.start({
          onReady: () => store.setState("wake_listening"),
          onError: (err) => store.setError(err.message),
          onDetection: (event) => {
            store.setState("capturing");
            startCommandCapture();
          },
        });
      } catch (e) {
        console.error("[voice-loop] wake restart failed:", e);
        store.setError(e instanceof Error ? e.message : String(e));
        store.setState("idle");
      }
    }

    function waitForSpeechEnd(): Promise<void> {
      return new Promise((resolve) => {
        let alreadyDone = false;
        const done = () => {
          if (alreadyDone) return;
          alreadyDone = true;
          resolve();
        };
        // If TTS isn't currently speaking, resolve immediately.
        if (!isSpeaking()) {
          done();
          return;
        }
        // Wait for it to stop, then a small buffer for the last word.
        const unsub = subscribeSpeaking((speaking) => {
          if (!speaking) {
            unsub();
            setTimeout(done, 150);
          }
        });
        // Safety timeout: 30s max wait.
        setTimeout(() => {
          unsub();
          done();
        }, 30000);
      });
    }

    // ---- Kick off ----------------------------------------------
    initWakeWord();

    // ---- Cleanup -----------------------------------------------
    return () => {
      cancelled = true;
      cleanupChatCoord?.();
      wakeWordListener.stop().catch(() => {});
      micCapture.stop().catch(() => {});
      confirmListener.cancel().catch(() => {});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Empty deps intentional: this hook owns the full voice lifecycle
  // for the duration the component is mounted.
}