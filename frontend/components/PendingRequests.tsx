"use client";

import { PendingRequest } from "@/lib/api";

export function PendingRequests({
  items,
  onPay,
  onDecline,
  pendingId,
}: {
  items: PendingRequest[];
  onPay: (id: number) => void;
  onDecline: (id: number) => void;
  pendingId?: number;
}) {
  if (!items.length) {
    return (
      <div className="text-center text-lavender py-6 text-sm">
        No pending requests.
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((r) => {
        const isPending = pendingId === r.id;
        return (
          <li
            key={r.id}
            className="flex items-center justify-between gap-3 p-3 rounded-lg bg-white/5 border border-white/10"
          >
            <div className="min-w-0 flex-1">
              <div className="text-cream text-sm font-medium">
                <span className="text-peach-500">{r.asker_handle}</span> asks
                you for ৳{Number(r.amount_bdt).toLocaleString("en-IN")}
              </div>
              <div className="text-xs text-lavender">{r.asker_phone}</div>
              {r.note ? (
                <div className="text-xs text-secondary mt-0.5 italic">
                  &ldquo;{r.note}&rdquo;
                </div>
              ) : null}
            </div>
            <div className="flex gap-1.5 shrink-0">
              <button
                onClick={() => onPay(r.id)}
                disabled={isPending}
                className="btn-peach rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
              >
                Pay
              </button>
              <button
                onClick={() => onDecline(r.id)}
                disabled={isPending}
                className="btn-ghost rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
              >
                ✕
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}