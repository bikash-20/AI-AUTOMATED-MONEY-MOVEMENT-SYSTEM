// Per-intent UUID generator. The backend dedupes on
// (initiator_user_id, idempotency_key), so each new UI action must come with
// a fresh key — but retries of the same intent (e.g. browser double-submit)
// must reuse the original key.

const KEY = "wallet:idempotency-prefix";

export function newIdempotencyKey(): string {
  // Prefix with a per-session timestamp so two sessions can't accidentally
  // collide. crypto.randomUUID is available in modern browsers and Node 19+.
  let prefix = "";
  try {
    prefix = sessionStorage.getItem(KEY) ?? "";
    if (!prefix) {
      prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem(KEY, prefix);
    }
  } catch {
    // SSR / no storage
    prefix = `${Date.now().toString(36)}`;
  }
  const uid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  return `${prefix}-${uid}`;
}