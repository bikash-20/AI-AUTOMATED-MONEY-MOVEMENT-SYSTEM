"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { User, api } from "@/lib/api";
import { clearActiveUserId, readActiveUserId, writeActiveUserId } from "@/lib/session";

// Deterministic pastel-from-hash so each tile gets a consistent accent ring
// without ever storing anything extra on the user.
function accentFromHandle(h: string): string {
  let n = 0;
  for (let i = 0; i < h.length; i++) n = (n * 31 + h.charCodeAt(i)) | 0;
  const palette = ["#f0a585", "#c89bd9", "#8db9d9", "#a8c89b", "#e8b86a", "#d98db3"];
  return palette[Math.abs(n) % palette.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function LoginPage() {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);

  useEffect(() => {
    api
      .listUsers()
      .then((u) => setUsers(u))
      .catch((e) => setError(`Couldn't reach server: ${(e as Error).message}`));
  }, []);

  function pick(u: User) {
    setLoadingId(u.id);
    writeActiveUserId(u.id);
    // Tiny delay so the press is visible — also lets us surface errors if any.
    setTimeout(() => router.push("/"), 180);
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      {/* Brand */}
      <div className="mb-10 text-center">
        <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight">
          <span className="text-cream">Wallet</span>
          <span className="text-peach-500">.</span>
        </h1>
      </div>

      {error ? (
        <div className="glass-strong rounded-xl px-4 py-3 text-sm text-red-300/90 mb-4">
          {error}
        </div>
      ) : null}

      {/* Tile grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4 w-full max-w-3xl">
        {users.length === 0 && !error ? (
          <div className="col-span-full text-center text-lavender py-12 text-sm">
            Loading users…
          </div>
        ) : (
          users.map((u) => {
            const accent = accentFromHandle(u.handle);
            const isLoading = loadingId === u.id;
            return (
              <button
                key={u.id}
                onClick={() => pick(u)}
                disabled={loadingId !== null}
                className="group glass rounded-2xl p-5 flex flex-col items-center gap-3 text-center transition-all hover:bg-white/10 hover:border-white/20 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center text-lg font-bold text-plum-950 shrink-0 transition-transform group-hover:scale-105"
                  style={{ background: accent }}
                >
                  {initials(u.display_name)}
                </div>
                <div className="min-w-0 w-full">
                  <div className="text-xs text-lavender truncate">
                    {u.phone}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-secondary mt-auto pt-1">
                  {isLoading ? (
                    <span className="text-peach-500">…</span>
                  ) : (
                    <span className="opacity-0 group-hover:opacity-100 transition-all text-peach-500">
                      →
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}