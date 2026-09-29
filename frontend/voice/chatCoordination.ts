// Chat coordination — bridge between the chat input and the voice system.
//
// Purpose: when the user is actively typing in the chat input, the voice
// loop should pause (set voice state to "muted_by_chat"). This prevents
// the wake-word detector from accidentally firing on keystroke noise,
// and prevents the wake-word utterance capture from competing with the
// user's typing focus.
//
// Constraint: we MUST NOT modify ChatBar.tsx or any chat component.
// The bridge observes the DOM globally instead.
//
// Strategy:
//   1. Watch `document.activeElement` for focus/blur on text inputs.
//   2. Watch `document` for `input` events to detect typing activity.
//   3. Debounce: typing activity keeps voice muted for 1.5s after the
//      last keystroke (so brief pauses don't release the mute).
//   4. When no input activity AND no input is focused for 1.5s,
//      release the mute.
//
// Edge cases handled:
//   - User clicks mic button (which has type="button"): no input event,
//     no focus on text input, voice resumes.
//   - User uses keyboard shortcut to focus search elsewhere: only
//     INPUT/TEXTAREA elements count, not buttons or divs.
//   - Multiple input events fire per keystroke (e.g. autocomplete):
//     debounce handles this.
//   - User navigates away from page entirely: cleanup unhooks listeners.

import { useVoiceStore } from "./voiceStore";

const TYPING_DEBOUNCE_MS = 1500;

let listenersAttached = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let mutedThisSession = false;

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  // Filter out non-text inputs (checkbox, radio, file, submit, etc.)
  if (el instanceof HTMLInputElement) {
    const nonText = new Set([
      "button", "submit", "reset", "checkbox", "radio", "file",
      "color", "range", "image",
    ]);
    if (nonText.has(el.type)) return false;
  }
  return true;
}

function setMuted(muted: boolean): void {
  const store = useVoiceStore.getState();
  if (muted) {
    // Only transition into muted if we're idle/listening/wake_listening.
    // Don't interrupt an active capture or transaction.
    if (
      store.state === "idle" ||
      store.state === "wake_listening"
    ) {
      store.setState("muted_by_chat");
      mutedThisSession = true;
    }
  } else {
    // Only unmute if WE muted it. (Don't unmute from other sources.)
    if (mutedThisSession && store.state === "muted_by_chat") {
      store.setState("idle");
      mutedThisSession = false;
    }
  }
}

function scheduleUnmute(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Only unmute if no input is currently focused.
    if (!isTypingTarget(document.activeElement)) {
      setMuted(false);
    }
  }, TYPING_DEBOUNCE_MS);
}

function handleFocusIn(e: FocusEvent): void {
  if (isTypingTarget(e.target as Element)) {
    setMuted(true);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }
}

function handleFocusOut(e: FocusEvent): void {
  if (isTypingTarget(e.target as Element)) {
    // Input lost focus — schedule unmute in case nothing else takes focus.
    scheduleUnmute();
  }
}

function handleInput(e: Event): void {
  if (isTypingTarget(e.target as Element)) {
    setMuted(true);
    scheduleUnmute();
  }
}

export function attachChatCoordination(): () => void {
  if (listenersAttached) {
    console.warn("[chat-coord] already attached, returning no-op cleanup");
    return () => {};
  }
  listenersAttached = true;

  document.addEventListener("focusin", handleFocusIn);
  document.addEventListener("focusout", handleFocusOut);
  document.addEventListener("input", handleInput);

  // Detect already-focused input at attach time (e.g. voice loop starts
  // after user has clicked into chat). Initial check.
  if (isTypingTarget(document.activeElement)) {
    setMuted(true);
  }

  return function cleanup() {
    listenersAttached = false;
    document.removeEventListener("focusin", handleFocusIn);
    document.removeEventListener("focusout", handleFocusOut);
    document.removeEventListener("input", handleInput);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    mutedThisSession = false;
  };
}