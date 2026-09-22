"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export function BalanceCard({
  userId,
  displayName,
  phone,
}: {
  userId: number;
  displayName: string;
  phone: string;
}) {
  const [balance, setBalance] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.getBalance(userId).then(
      (r) => alive && setBalance(r.balance_bdt),
      () => alive && setBalance(null)
    );
    return () => {
      alive = false;
    };
  }, [userId]);

  return (
    <div className="glass rounded-2xl p-6 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-secondary text-sm font-medium uppercase tracking-wider">
          Balance
        </div>
        <div className="text-xs text-lavender">{phone}</div>
      </div>
      <div className="text-4xl font-bold text-cream tracking-tight">
        ৳
        <span className="text-peach-500">
          {balance === null ? "—" : Number(balance).toLocaleString("en-IN")}
        </span>
      </div>
      <div className="text-sm text-lavender">@{displayName.toLowerCase()}</div>
    </div>
  );
}