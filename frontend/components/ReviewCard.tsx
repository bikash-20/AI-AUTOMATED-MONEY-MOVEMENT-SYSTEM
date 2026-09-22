"use client";

import { AgentActResponse } from "@/lib/api";

export function ReviewCard({
  resp,
  onConfirm,
  onDecline,
  pending,
  voiceListening,
}: {
  resp: AgentActResponse;
  onConfirm: () => void;
  onDecline: () => void;
  pending?: boolean;
  voiceListening?: boolean;
}) {
  const card = resp.card;
  if (!card) return null;

  return (
    <div className="glass-strong rounded-2xl p-5 border-l-4 border-l-peach-500 shadow-glow-peach">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-secondary uppercase tracking-wider">
          Confirm
        </div>
        {voiceListening ? (
          <div className="flex items-center gap-1.5 text-xs text-peach-500">
            <span className="w-1.5 h-1.5 rounded-full bg-peach-500 mic-active" />
            Say &quot;yes&quot; to confirm, &quot;no&quot; to cancel
          </div>
        ) : null}
      </div>
      <div className="text-cream text-base leading-relaxed mb-3">
        {resp.text}
      </div>
      <div className="text-sm text-secondary border-t border-white/10 pt-3 mb-4">
        {card.kind === "split" && card.recipients ? (
          <>
            Splitting <span className="text-peach-500">৳{Number(card.amount_bdt).toLocaleString("en-IN")}</span>{" "}
            equally among {card.recipients.join(", ")}.
          </>
        ) : card.recipient_label ? (
          <>
            To <span className="text-peach-500">{card.recipient_label}</span>
            {card.recipient_phone ? (
              <span className="text-lavender"> · {card.recipient_phone}</span>
            ) : null}
            {" — "}৳{Number(card.amount_bdt).toLocaleString("en-IN")}
          </>
        ) : (
          <>
            ৳{Number(card.amount_bdt).toLocaleString("en-IN")} payment
          </>
        )}
        <br />
        New balance:{" "}
        <span className="text-cream font-medium">
          ৳{Number(card.resulting_balance_bdt).toLocaleString("en-IN")}
        </span>
      </div>
      <div className="flex gap-2">
        <button
          onClick={onConfirm}
          disabled={pending}
          className="btn-peach rounded-lg px-5 py-2 flex-1 disabled:opacity-40"
        >
          {pending ? "Working…" : "Confirm"}
        </button>
        <button
          onClick={onDecline}
          disabled={pending}
          className="btn-ghost rounded-lg px-5 py-2 disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}