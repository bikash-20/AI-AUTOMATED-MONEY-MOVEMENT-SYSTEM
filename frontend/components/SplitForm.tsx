"use client";

import { FormEvent, useState } from "react";

export function SplitForm({
  recipients,
  onSubmit,
  disabled,
}: {
  recipients: string[];
  onSubmit: (args: { recipients: string[]; amount: string }) => void;
  disabled?: boolean;
}) {
  const [first, setFirst] = useState(recipients[0] ?? "");
  const [second, setSecond] = useState(recipients[1] ?? recipients[0] ?? "");
  const [amount, setAmount] = useState("");

  function handle(event: FormEvent) {
    event.preventDefault();
    if (!first || !second || first === second || !amount) return;
    onSubmit({ recipients: [first, second], amount });
    setAmount("");
  }

  return (
    <form onSubmit={handle} className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs text-secondary uppercase tracking-wider">
          Person one
          <select value={first} onChange={(e) => setFirst(e.target.value)} disabled={disabled} className="field-select">
            {recipients.map((recipient) => <option key={recipient} value={recipient}>{recipient}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-secondary uppercase tracking-wider">
          Person two
          <select value={second} onChange={(e) => setSecond(e.target.value)} disabled={disabled} className="field-select">
            {recipients.map((recipient) => <option key={recipient} value={recipient}>{recipient}</option>)}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-secondary uppercase tracking-wider">
        Total amount (৳)
        <input type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={disabled} placeholder="900" className="field-input text-lg font-semibold" />
      </label>
      <button type="submit" disabled={disabled || !amount || !first || !second || first === second} className="btn-ghost rounded-lg px-4 py-2.5 disabled:opacity-40">
        Split equally
      </button>
    </form>
  );
}
