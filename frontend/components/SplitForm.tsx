"use client";

import { FormEvent, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";

/**
 * N-way split form.
 *
 * Backwards compatible: still submits `{recipients, amount}` and still
 * enforces >= 2 recipients. Now supports up to 8 recipients via a chip
 * array + "+ Add person" picker.
 *
 * The "Add person" button opens a small dropdown listing recipients
 * who are not already chosen. Once 8 chips are placed, or every
 * available recipient is in the list, the button disables itself.
 */
export function SplitForm({
  recipients,
  onSubmit,
  disabled,
}: {
  recipients: string[];
  onSubmit: (args: { recipients: string[]; amount: string }) => void;
  disabled?: boolean;
}) {
  const [chosen, setChosen] = useState<string[]>(() => {
    // Seed with the first two available recipients (matches old behaviour
    // for the 2-person case). Falls back to a single seed if there's only one.
    const a = recipients[0] ?? "";
    const b = recipients[1] ?? recipients[0] ?? "";
    if (a && b && a !== b) return [a, b];
    if (a) return [a];
    return [];
  });
  const [amount, setAmount] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const MAX_RECIPIENTS = 8;

  const remaining = useMemo(
    () => recipients.filter((r) => !chosen.includes(r)),
    [recipients, chosen]
  );

  const canAdd = chosen.length < MAX_RECIPIENTS && remaining.length > 0;

  // Live per-person preview (decimal-safe rounding mirrors the engine).
  const preview = useMemo(() => {
    const n = chosen.length;
    const a = parseFloat(amount || "0");
    if (!n || !a || a <= 0) return null;
    const totalPaisa = Math.round(a * 100);
    const perPaisa = Math.floor(totalPaisa / n);
    const remainder = totalPaisa - perPaisa * n;
    const per = (perPaisa / 100).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const totalStr = a.toLocaleString("en-IN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
    return {
      n,
      per,
      totalStr,
      remainderNote: remainder > 0 ? ` (৳${(remainder / 100).toFixed(2)} extra on the first person)` : "",
    };
  }, [chosen.length, amount]);

  function add(handle: string) {
    if (!handle) return;
    if (chosen.includes(handle)) return;
    if (chosen.length >= MAX_RECIPIENTS) return;
    setChosen((c) => [...c, handle]);
    setPickerOpen(false);
  }

  function remove(handle: string) {
    setChosen((c) => c.filter((h) => h !== handle));
  }

  function handle(event: FormEvent) {
    event.preventDefault();
    if (chosen.length < 2) return;
    if (!amount || parseFloat(amount) <= 0) return;
    onSubmit({ recipients: chosen, amount });
    setAmount("");
  }

  const submitDisabled =
    disabled || chosen.length < 2 || !amount || parseFloat(amount) <= 0;

  return (
    <form onSubmit={handle} className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <span className="text-xs text-secondary uppercase tracking-wider">
          People ({chosen.length}/{MAX_RECIPIENTS})
        </span>
        <div className="flex flex-wrap gap-2">
          {chosen.map((h) => (
            <span
              key={h}
              className="inline-flex items-center gap-1.5 rounded-full bg-peach-500/15 text-peach-500 border border-peach-500/30 px-3 py-1 text-sm"
            >
              {h}
              <button
                type="button"
                aria-label={`Remove ${h}`}
                disabled={disabled}
                onClick={() => remove(h)}
                className="text-peach-500/70 hover:text-cream disabled:opacity-40"
              >
                <X size={14} strokeWidth={2.2} />
              </button>
            </span>
          ))}
          {canAdd ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                disabled={disabled}
                aria-expanded={pickerOpen}
                aria-haspopup="listbox"
                className="inline-flex items-center gap-1 rounded-full bg-white/5 text-cream/80 hover:bg-white/10 border border-white/10 px-3 py-1 text-sm disabled:opacity-40"
              >
                <Plus size={14} strokeWidth={2.2} />
                Add person
              </button>
              {pickerOpen ? (
                <ul
                  role="listbox"
                  className="absolute z-20 mt-1 left-0 min-w-[10rem] glass-strong rounded-xl p-1 shadow-glass"
                >
                  {remaining.map((r) => (
                    <li key={r}>
                      <button
                        type="button"
                        role="option"
                        aria-selected="false"
                        onClick={() => add(r)}
                        className="w-full text-left px-3 py-1.5 rounded-lg text-sm text-cream/90 hover:bg-white/10"
                      >
                        {r}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
        {chosen.length < 2 ? (
          <p className="text-[11px] text-secondary">
            Pick at least two people to split with.
          </p>
        ) : null}
      </div>

      <label className="flex flex-col gap-1 text-xs text-secondary uppercase tracking-wider">
        Total amount (৳)
        <input
          type="number"
          min="1"
          step="1"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={disabled}
          placeholder="900"
          className="field-input text-lg font-semibold"
        />
      </label>

      {preview ? (
        <div className="text-xs text-lavender">
          ৳{preview.totalStr} ÷ {preview.n} ={" "}
          <span className="text-cream font-medium">৳{preview.per}</span> each
          <span className="text-secondary">{preview.remainderNote}</span>
        </div>
      ) : null}

      <button
        type="submit"
        disabled={submitDisabled}
        className="btn-ghost rounded-lg px-4 py-2.5 disabled:opacity-40"
      >
        Split equally
      </button>
    </form>
  );
}
