"use client";

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { getChartData } from "@/lib/mockData";
import type { ChartMetric } from "./ChartMetricSelector";
import type { Period } from "./PeriodSelector";

export default function PnLChart({ metric, period }: { metric: ChartMetric; period: Period }) {
  const data = getChartData(metric, period);

  return (
    <div data-tag="pnl.chart_30d" className="w-full h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: -10 }}>
          <CartesianGrid stroke="#1f1f2e" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            stroke="#6b6b80"
            fontSize={10}
            tickLine={false}
            axisLine={{ stroke: "#1f1f2e" }}
            interval={2}
          />
          <YAxis
            stroke="#6b6b80"
            fontSize={10}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => v.toFixed(2)}
          />
          <Tooltip
            contentStyle={{
              background: "#0D0D12",
              border: "1px solid #1f1f2e",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "#a0a0b8" }}
            formatter={(v: number) => [v.toFixed(4), metric === "pnl" ? "SOL" : metric === "volume" ? "SOL" : "$"]}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#00FF85"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: "#00FF85" }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}