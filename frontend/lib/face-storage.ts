// Browser-side localStorage mirror for the face embedding.
//
// Kept in its own module (separate from lib/face.ts) so that any caller
// that only needs to read/clear the local copy — e.g. SettingsModal,
// which is statically imported by the main page bundle — does NOT pull
// face-api.js into the main chunk via the module graph. face-api.js is
// ~1.2 MB and brings transitive Node-builtin shenanigans with it; the
// confirm/enroll flows load it on demand via dynamic import.
//
// The stored embedding lives in two places:
//   1. The server (opaque blob, never echoed back) — for cross-device
//      recovery and for the demo's "I deleted localStorage" case.
//   2. localStorage, keyed by user_id — for the live confirmation flow,
//      where the browser needs the reference vector to compute similarity
//      without a server round-trip.
//
// All access goes through these helpers so the storage shape stays in
// one place. JSON parse errors return null (treat as "not enrolled") —
// we never want a corrupt blob to brick the confirm flow.

const STORAGE_PREFIX = "wallet:face:";

export function readStoredEmbedding(userId: number): number[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredEmbedding(userId: number, embedding: number[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `${STORAGE_PREFIX}${userId}`,
      JSON.stringify(embedding)
    );
  } catch {
    /* quota / private-mode failures are non-fatal — the server still has the blob */
  }
}

export function clearStoredEmbedding(userId: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`${STORAGE_PREFIX}${userId}`);
  } catch {
    /* ignore */
  }
}
