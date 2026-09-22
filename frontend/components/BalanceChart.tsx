"use client";

import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export function BalanceChart({
  data,
}: {
  data: { date: string; balance: number }[];
}) {
  if (!data.length) {
    return (
      <div className="text-center text-lavender py-8 text-sm">
        Not enough history to plot a chart.
      </div>
    );
  }
  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f0a585" stopOpacity={0.6} />
              <stop offset="100%" stopColor="#f0a585" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            tickFormatter={(d) => d.slice(5)}
            tick={{ fill: "#b8a8b8", fontSize: 11 }}
            axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
            tickLine={false}
            minTickGap={28}
          />
          <YAxis
            tick={{ fill: "#b8a8b8", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={48}
            tickFormatter={(v) => `${v.toLocaleString("en-IN")}`}
          />
          <Tooltip
            contentStyle={{
              background: "rgba(45, 35, 48, 0.95)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8,
              color: "#f2e9e4",
              fontSize: 12,
            }}
            formatter={(v: number) => [`৳${v.toLocaleString("en-IN")}`, "Balance"]}
            labelFormatter={(d) => d}
          />
          <Area
            type="monotone"
            dataKey="balance"
            stroke="#f0a585"
            strokeWidth={2}
            fill="url(#balGrad)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}