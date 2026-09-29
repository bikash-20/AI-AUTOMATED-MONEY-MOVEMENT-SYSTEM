"use client";

// VoiceOrb — visual indicator for the voice system's state.
//
// Reads from the Zustand voice store and renders an animated orb
// with a color + animation matching the current state. Sits at the
// bottom-center of the dashboard, floating above the chat bar.
//
// State → visual mapping:
//   idle                  → dim grey, slow pulse
//   wake_listening        → soft peach glow, gentle ripple
//   capturing             → bright peach, animated waveform bars
//   transcribing          → spinning ring
//   processing            → spinning ring
//   speaking              → animated bars in sync with audio (we use
//                            a CSS-only animation since we don't have
//                            audio analyser data)
//   awaiting_confirmation → pulsing "say yes or no"
//   confirming            → spinning ring
//   declining             → brief red flash
//   muted_by_chat         → greyed out
//   error                 → red, dim
//
// Click behaviour: clicking the orb while idle starts a manual capture
// (uses the existing VoiceButton as fallback). When in any other state,
// clicking is a no-op (or stops the current op — but we'll keep this
// simple and just disable clicks when busy).

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  useVoiceStore,
  selectVoiceState,
  selectTranscript,
  selectResponse,
  selectMicPermission,
  selectError,
} from "@/voice/voiceStore";
import { AudioLines, LoaderCircle, MicOff, Mic, AlertCircle } from "lucide-react";

const STATE_COLORS: Record<string, { bg: string; ring: string; text: string }> = {
  idle: { bg: "bg-white/5", ring: "border-white/10", text: "text-cream/40" },
  wake_listening: { bg: "bg-peach-500/15", ring: "border-peach-500/40", text: "text-peach-500/80" },
  capturing: { bg: "bg-peach-500/30", ring: "border-peach-500", text: "text-peach-500" },
  transcribing: { bg: "bg-blue-500/15", ring: "border-blue-400/60", text: "text-blue-300" },
  processing: { bg: "bg-blue-500/15", ring: "border-blue-400/60", text: "text-blue-300" },
  speaking: { bg: "bg-emerald-500/20", ring: "border-emerald-400/70", text: "text-emerald-300" },
  awaiting_confirmation: { bg: "bg-amber-500/20", ring: "border-amber-400/70", text: "text-amber-300" },
  confirming: { bg: "bg-blue-500/15", ring: "border-blue-400/60", text: "text-blue-300" },
  declining: { bg: "bg-red-500/20", ring: "border-red-400/70", text: "text-red-300" },
  muted_by_chat: { bg: "bg-white/5", ring: "border-white/10", text: "text-cream/30" },
  error: { bg: "bg-red-500/15", ring: "border-red-400/60", text: "text-red-300" },
};

const STATE_LABEL: Record<string, string> = {
  idle: "Voice ready",
  wake_listening: 'Say "Hey Wallet"',
  capturing: "Listening…",
  transcribing: "Transcribing…",
  processing: "Thinking…",
  speaking: "Speaking…",
  awaiting_confirmation: 'Say "yes" or "no"',
  confirming: "Confirming…",
  declining: "Cancelling…",
  muted_by_chat: "Paused (typing)",
  error: "Voice error",
};

export function VoiceOrb() {
  const state = useVoiceStore(selectVoiceState);
  const transcript = useVoiceStore(selectTranscript);
  const response = useVoiceStore(selectResponse);
  const micPerm = useVoiceStore(selectMicPermission);
  const errorMessage = useVoiceStore(selectError);

  const [showTranscript, setShowTranscript] = useState(false);

  // Auto-hide transcript after 4s.
  useEffect(() => {
    if (!transcript && !response) {
      setShowTranscript(false);
      return;
    }
    setShowTranscript(true);
    const id = setTimeout(() => setShowTranscript(false), 4000);
    return () => clearTimeout(id);
  }, [transcript, response]);

  const colors = STATE_COLORS[state] || STATE_COLORS.idle;
  const label = STATE_LABEL[state] || state;

  // If mic is denied, show a small banner instead of the orb.
  if (micPerm === "denied") {
    return (
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40">
        <div className="glass rounded-full px-4 py-2 flex items-center gap-2 text-xs text-cream/70">
          <MicOff size={14} className="text-red-300" />
          <span>Microphone access denied — voice disabled</span>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-2">
      {/* Optional floating transcript / response bubble */}
      <AnimatePresence>
        {showTranscript && (transcript || response) && (
          <motion.div
            key={(transcript || "") + "|" + (response || "")}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="glass rounded-2xl px-4 py-2 max-w-md text-xs text-cream/90"
          >
            {transcript && (
              <div>
                <span className="text-peach-500/70 text-[10px] uppercase tracking-wider mr-2">
                  you
                </span>
                {transcript}
              </div>
            )}
            {response && (
              <div className="mt-1">
                <span className="text-emerald-400/70 text-[10px] uppercase tracking-wider mr-2">
                  wallet
                </span>
                {response}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* The orb itself */}
      <motion.button
        type="button"
        onClick={() => {
          // Click while idle: do nothing for now (mic is auto-on via
          // wake word). Click while error: clear error and try to
          // resume. The VoiceButton component is the manual fallback
          // for click-to-talk — it lives in ChatBar.
          if (state === "error") {
            useVoiceStore.getState().setError(null);
          }
        }}
        disabled={state === "capturing" || state === "transcribing" || state === "processing" || state === "confirming" || state === "declining"}
        className={
          "relative w-14 h-14 rounded-full flex items-center justify-center transition-all border " +
          colors.bg + " " + colors.ring + " " + colors.text +
          (state === "error" ? " cursor-pointer" : "")
        }
        animate={{
          scale: state === "wake_listening" ? [1, 1.05, 1] : 1,
        }}
        transition={{
          duration: 1.6,
          repeat: state === "wake_listening" ? Infinity : 0,
          ease: "easeInOut",
        }}
        title={label}
        aria-label={label}
      >
        {state === "capturing" ? (
          // Animated waveform bars (similar to VoiceButton's recording state).
          <span className="flex items-center gap-0.5">
            {[10, 18, 13, 21, 12, 17].map((height, i) => (
              <motion.span
                key={height}
                className="block w-0.5 rounded-full bg-current"
                animate={{ height: [height * 0.55, height, height * 0.65] }}
                transition={{ duration: 0.55, repeat: Infinity, delay: i * 0.08 }}
              />
            ))}
          </span>
        ) : state === "speaking" ? (
          // Speaker bars for TTS playback.
          <span className="flex items-center gap-0.5">
            {[9, 16, 11, 19, 13].map((height, i) => (
              <motion.span
                key={height}
                className="block w-0.5 rounded-full bg-current"
                animate={{ height: [height * 0.5, height * 0.9, height * 0.6] }}
                transition={{ duration: 0.45, repeat: Infinity, delay: i * 0.06 }}
              />
            ))}
          </span>
        ) : state === "transcribing" || state === "processing" || state === "confirming" || state === "declining" ? (
          <LoaderCircle size={20} className="animate-spin" />
        ) : state === "error" ? (
          <AlertCircle size={20} />
        ) : state === "muted_by_chat" ? (
          <MicOff size={18} />
        ) : (
          <Mic size={20} />
        )}

        {/* Pulse rings when in wake_listening */}
        {state === "wake_listening" && (
          <>
            <motion.span
              className="absolute inset-0 rounded-full border border-peach-500/40"
              animate={{ scale: [1, 1.6], opacity: [0.6, 0] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
            />
            <motion.span
              className="absolute inset-0 rounded-full border border-peach-500/30"
              animate={{ scale: [1, 2.2], opacity: [0.4, 0] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeOut", delay: 0.4 }}
            />
          </>
        )}

        {/* Pulse for awaiting_confirmation */}
        {state === "awaiting_confirmation" && (
          <motion.span
            className="absolute inset-0 rounded-full border border-amber-400/60"
            animate={{ scale: [1, 1.4], opacity: [0.7, 0] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: "easeOut" }}
          />
        )}
      </motion.button>

      {/* Status label */}
      <div className="text-[10px] uppercase tracking-wider text-cream/50">
        {errorMessage && state === "error" ? errorMessage : label}
      </div>
    </div>
  );
}