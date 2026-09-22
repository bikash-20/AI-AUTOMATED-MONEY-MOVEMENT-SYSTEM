// Single source of truth for the active-session localStorage key.
// Used by /login (writes) and the dashboard (reads + clears).

export const SESSION_KEY = "wallet:active-user-id";

export function readActiveUserId(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const v = localStorage.getItem(SESSION_KEY);
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeActiveUserId(id: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SESSION_KEY, String(id));
  } catch {
    // ignore
  }
}

export function clearActiveUserId(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}