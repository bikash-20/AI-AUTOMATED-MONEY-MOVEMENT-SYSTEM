// Voice state machine — single source of truth for the voice subsystem.
//
// Why Zustand: voice state changes 5–10x per second during capture
// (capturing → speech_start → speech_end → transcribing → ...). React
// Context re-renders cascade through the whole tree on every state change.
// Zustand selectors let components subscribe to just the slice they need.
//
// CRITICAL INVARIANT: this store is the voice system's state ONLY.
// Chat has its own state, its own component tree, its own handlers.
// Nothing in this file imports anything from ChatBar / lib/api chat
// helpers. The only bridge is chatCoordination.ts, which observes the
// DOM (document.activeElement) without touching React state in chat.

import { create } from "zustand";

export type VoiceState =
  | "idle"                  // nothing happening; wake-word listener is OFF
  | "wake_listening"        // wake-word listener ON, listening for "Hey Wallet"
  | "capturing"             // mic open, recording user command
  | "transcribing"          // STT in flight
  | "processing"            // /agent/act in flight
  | "speaking"              // TTS playing
  | "awaiting_confirmation" // mic open, listening for "yes/no"
  | "confirming"            // /agent/confirm in flight
  | "declining"             // /agent/confirm decline in flight
  | "muted_by_chat"         // chat input has focus; voice paused
  | "error";                // recoverable failure, will auto-recover

export interface VoiceStoreState {
  state: VoiceState;
  transcript: string;          // last user transcript
  response: string;            // last spoken response
  pendingId: number | null;    // pending txn awaiting confirmation
  errorMessage: string | null; // populated when state === "error"
  sttReady: boolean;           // STT model loaded on backend
  micPermission: "unknown" | "granted" | "denied";

  // Transitions — these are the only way to change state. Each one
  // validates that the transition is legal before applying it.
  setState: (next: VoiceState) => void;
  setTranscript: (text: string) => void;
  setResponse: (text: string) => void;
  setPendingId: (id: number | null) => void;
  setError: (msg: string | null) => void;
  setSttReady: (ready: boolean) => void;
  setMicPermission: (perm: "unknown" | "granted" | "denied") => void;
}

// Allowed transitions. Anything not listed here is rejected silently
// (we keep current state). This prevents race conditions where two
// async paths try to move the state machine in conflicting ways.
const ALLOWED: Record<VoiceState, VoiceState[]> = {
  idle: ["wake_listening", "muted_by_chat", "capturing", "error"],
  wake_listening: ["capturing", "idle", "muted_by_chat", "error"],
  capturing: ["transcribing", "idle", "wake_listening", "muted_by_chat", "error"],
  transcribing: ["processing", "wake_listening", "error"],
  processing: ["speaking", "awaiting_confirmation", "wake_listening", "error"],
  speaking: ["idle", "wake_listening", "muted_by_chat", "error"],
  awaiting_confirmation: ["confirming", "declining", "speaking", "wake_listening", "error"],
  confirming: ["speaking", "wake_listening", "error"],
  declining: ["speaking", "wake_listening", "error"],
  muted_by_chat: ["idle", "wake_listening", "error"],
  error: ["idle", "wake_listening", "muted_by_chat"],
};

export const useVoiceStore = create<VoiceStoreState>((set, get) => ({
  state: "idle",
  transcript: "",
  response: "",
  pendingId: null,
  errorMessage: null,
  sttReady: false,
  micPermission: "unknown",

  setState: (next) => {
    const current = get().state;
    if (current === next) return;
    if (!ALLOWED[current].includes(next)) {
      console.warn(`[voice] illegal transition ${current} -> ${next}, ignoring`);
      return;
    }
    set({ state: next });
  },
  setTranscript: (text) => set({ transcript: text }),
  setResponse: (text) => set({ response: text }),
  setPendingId: (id) => set({ pendingId: id }),
  setError: (msg) => set({
    errorMessage: msg,
    state: msg ? "error" : (get().state === "error" ? "idle" : get().state),
  }),
  setSttReady: (ready) => set({ sttReady: ready }),
  setMicPermission: (perm) => set({ micPermission: perm }),
}));

// Convenience selectors — components import these to avoid re-renders
// when unrelated state changes.
export const selectVoiceState = (s: VoiceStoreState) => s.state;
export const selectTranscript = (s: VoiceStoreState) => s.transcript;
export const selectResponse = (s: VoiceStoreState) => s.response;
export const selectSttReady = (s: VoiceStoreState) => s.sttReady;
export const selectMicPermission = (s: VoiceStoreState) => s.micPermission;
export const selectError = (s: VoiceStoreState) => s.errorMessage;
