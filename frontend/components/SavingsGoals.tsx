"use client";

import { useEffect, useState } from "react";
import { api, SavingsGoal } from "@/lib/api";

const FESTIVALS = ["Eid", "Durga Puja", "Pohela Boishakh", "Valentine's Day"];

export function SavingsGoals({ userId }: { userId: number }) {
  const [goals, setGoals] = useState<SavingsGoal[]>([]);
  const [festival, setFestival] = useState(FESTIVALS[0]);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try { setGoals(await api.getSavingsGoals(userId)); } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { load(); }, [userId]);

  async function createGoal() {
    if (!target || busy) return;
    setBusy(true); setError(null);
    try {
      await api.createSavingsGoal(userId, { festival, target_amount_bdt: target });
      setTarget(""); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function contribute(goal: SavingsGoal) {
    const amount = window.prompt(`Save how much for ${goal.festival}?`, "500");
    if (!amount || busy) return;
    setBusy(true); setError(null);
    try {
      await api.contributeSavings(userId, goal.id, { amount_bdt: amount, idempotency_key: crypto.randomUUID() });
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <section className="glass rounded-2xl p-6">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="text-secondary text-sm font-medium uppercase tracking-wider">Festival savings</div>
          <p className="text-xs text-secondary mt-1">Set money aside for the days that matter.</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        <select value={festival} onChange={(e) => setFestival(e.target.value)} className="field-select flex-1 min-w-40">
          {FESTIVALS.map((item) => <option key={item}>{item}</option>)}
        </select>
        <input type="number" min="1" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Target ৳" className="field-input w-32" />
        <button onClick={createGoal} disabled={!target || busy} className="btn-peach rounded-lg px-4 py-2 text-sm disabled:opacity-40">Create</button>
      </div>
      {error ? <p className="text-xs text-red-200 mb-3">{error}</p> : null}
      {goals.length ? <div className="grid gap-2 sm:grid-cols-2">{goals.map((goal) => {
        const progress = Math.min(100, Number(goal.saved_amount_bdt) / Number(goal.target_amount_bdt) * 100);
        return <div key={goal.id} className="rounded-xl bg-white/5 border border-white/10 p-3">
          <div className="flex justify-between text-sm"><span className="text-cream">{goal.festival}</span><span className="text-peach-500">{Math.round(progress)}%</span></div>
          <div className="h-1.5 rounded-full bg-white/10 mt-2 overflow-hidden"><div className="h-full bg-peach-500 rounded-full" style={{ width: `${progress}%` }} /></div>
          <div className="flex items-center justify-between mt-2 text-xs text-secondary"><span>৳{Number(goal.saved_amount_bdt).toLocaleString("en-IN")} / ৳{Number(goal.target_amount_bdt).toLocaleString("en-IN")}</span><button onClick={() => contribute(goal)} disabled={busy} className="text-peach-500 hover:text-cream">Add money</button></div>
        </div>;
      })}</div> : <p className="text-sm text-secondary">No savings goals yet.</p>}
    </section>
  );
}
