"use client";

import { FormEvent, useState } from "react";

export function SendForm({
  recipients,
  onSubmit,
  disabled,
  pending,
}: {
  recipients: string[];
  onSubmit: (args: { recipient: string; amount: string; note: string }) => void;
  disabled?: boolean;
  pending?: boolean;
}) {
  const [recipient, setRecipient] = useState(recipients[0] ?? "");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  function handle(e: FormEvent) {
    e.preventDefault();
    if (!recipient || !amount) return;
    onSubmit({ recipient, amount, note });
    setAmount("");
  }

  return (
    <form onSubmit={handle} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-secondary uppercase tracking-wider">
          Send to
        </label>
        <select
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          disabled={disabled || pending}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-cream focus:outline-none focus:border-peach-500/50 transition"
        >
          {recipients.map((r) => (
            <option key={r} value={r} className="bg-plum-900">
              {r}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-secondary uppercase tracking-wider">
          Amount (৳)
        </label>
        <input
          type="number"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          min="1"
          disabled={disabled || pending}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-cream text-lg font-semibold focus:outline-none focus:border-peach-500/50 transition"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-secondary uppercase tracking-wider">
          Note (optional)
        </label>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="chai, bill, etc."
          maxLength={140}
          disabled={disabled || pending}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-cream focus:outline-none focus:border-peach-500/50 transition"
        />
      </div>
      <button
        type="submit"
        disabled={disabled || pending || !recipient || !amount}
        className="btn-peach rounded-lg px-4 py-2.5 mt-1 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {pending ? "Working…" : "Send"}
      </button>
    </form>
  );
}