"use client";

import clsx from "clsx";
import { useI18n } from "@/components/providers/I18nProvider";

export type ChartMetric = "pnl" | "volume" | "ath";

const METRICS: { id: ChartMetric; label: string }[] = [
  { id: "pnl", label: "PnL" },
  { id: "volume", label: "Volume" },
  { id: "ath", label: "ATH" },
];

const METRIC_LABEL_KEYS: Record<ChartMetric, "dashboard.metric.pnl" | "dashboard.metric.volume" | "dashboard.metric.ath"> = {
  pnl: "dashboard.metric.pnl",
  volume: "dashboard.metric.volume",
  ath: "dashboard.metric.ath",
};

type Props = {
  active: ChartMetric;
  onChange: (m: ChartMetric) => void;
};

export default function ChartMetricSelector({ active, onChange }: Props) {
  const { t } = useI18n();

  return (
    <div data-tag="dashboard.chart_metric_selector" className="flex items-center gap-1 bg-bg-card/40 border border-bg-border rounded-lg p-1">
      {METRICS.map((m) => (
        <button
          key={m.id}
          type="button"
          data-tag={"dashboard.chart_metric." + m.id}
          onClick={() => onChange(m.id)}
          className={clsx(
            "px-3 py-1.5 text-xs font-semibold rounded-md transition",
            active === m.id
              ? "bg-[color:var(--theme-primary)] text-[color:var(--theme-content-inverted)] shadow-[0_18px_30px_-18px_color-mix(in_srgb,var(--theme-primary)_70%,transparent)]"
              : "text-white/50 hover:text-white hover:bg-white/5"
          )}
        >
          {t(METRIC_LABEL_KEYS[m.id]) || m.label}
        </button>
      ))}
    </div>
  );
}

