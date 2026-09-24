"use client";

import { useState } from "react";
import { User } from "@/lib/api";
import { ChevronDown, CircleUserRound } from "lucide-react";

export function SessionSwitcher({
  users,
  currentId,
  onChange,
}: {
  users: User[];
  currentId: number;
  onChange: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = users.find((u) => u.id === currentId);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="btn-ghost rounded-full px-3.5 py-2 flex items-center gap-2 text-sm"
      >
        <CircleUserRound size={17} strokeWidth={1.8} />
        <span className="hidden sm:inline">Account</span>
        <ChevronDown size={15} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
      </button>
      {open ? (
        <div className="absolute right-0 top-[calc(100%+0.6rem)] z-30 min-w-48 glass-strong rounded-2xl p-2 shadow-glass">
          <div className="px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-secondary">
            Active account
          </div>
          {users.map((u) => (
            <button
              type="button"
              key={u.id}
              onClick={() => {
                onChange(u.id);
                setOpen(false);
              }}
              className={
                "w-full text-left px-3 py-2 rounded-xl text-sm transition-colors " +
                (u.id === currentId
                  ? "bg-peach-500 text-plum-950 font-semibold"
                  : "text-cream/80 hover:bg-white/10")
              }
              title={u.phone}
              role="menuitem"
            >
              {u.display_name}
            </button>
          ))}
          {current ? <span className="sr-only">Current account: {current.display_name}</span> : null}
        </div>
      ) : null}
    </div>
  );
}