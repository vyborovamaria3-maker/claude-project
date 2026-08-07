"use client";

import clsx from "clsx";
import { useI18n } from "@/components/providers/I18nProvider";

export type Period = "1H" | "1D" | "7D" | "30D" | "90D" | "1Y" | "ALL";

const PERIODS: { id: Period; label: string }[] = [
  { id: "1H", label: "1H" },
  { id: "1D", label: "1D" },
  { id: "7D", label: "7D" },
  { id: "30D", label: "30D" },
  { id: "90D", label: "90D" },
  { id: "1Y", label: "1Y" },
  { id: "ALL", label: "ALL" },
];

const PERIOD_LABEL_KEYS: Record<Period, "dashboard.period.1h" | "dashboard.period.1d" | "dashboard.period.7d" | "dashboard.period.30d" | "dashboard.period.90d" | "dashboard.period.1y" | "dashboard.period.all"> = {
  "1H": "dashboard.period.1h",
  "1D": "dashboard.period.1d",
  "7D": "dashboard.period.7d",
  "30D": "dashboard.period.30d",
  "90D": "dashboard.period.90d",
  "1Y": "dashboard.period.1y",
  ALL: "dashboard.period.all",
};

type Props = {
  active: Period;
  onChange: (p: Period) => void;
};

export default function PeriodSelector({ active, onChange }: Props) {
  const { t } = useI18n();

  return (
    <div
      data-tag="dashboard.period_selector"
      className="flex min-w-0 max-w-full items-center gap-1 overflow-x-auto overscroll-x-contain rounded-full border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.09),rgba(255,255,255,0.03))] p-1.5 shadow-[0_14px_40px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-md [-webkit-overflow-scrolling:touch]"
    >
      {PERIODS.map((p) => (
        <button
          key={p.id}
          type="button"
          data-tag={`dashboard.period.${p.id.toLowerCase()}`}
          onClick={() => onChange(p.id)}
          className={clsx(
            "relative shrink-0 overflow-hidden rounded-full px-2.5 py-1.5 text-xs font-semibold transition-all duration-300 ease-out transform-gpu will-change-transform active:scale-[0.98] sm:px-3.5",
            active === p.id
              ? "bg-[linear-gradient(180deg,rgba(255,255,255,0.12),rgba(255,255,255,0.05))] text-white border border-neon-green/35 shadow-[0_0_0_1px_rgba(0,255,133,0.12),0_0_18px_rgba(0,255,133,0.18)] -translate-y-px"
              : "text-white/50 border border-transparent hover:-translate-y-0.5 hover:text-white hover:bg-white/[0.05] hover:border-white/10"
          )}
        >
          {active === p.id ? (
            <>
              <span className="absolute inset-x-2 bottom-0 h-px rounded-full bg-gradient-to-r from-transparent via-neon-green/70 to-transparent shadow-[0_0_10px_rgba(0,255,133,0.6)]" />
              <span className="absolute inset-0 rounded-full ring-1 ring-inset ring-white/10" />
            </>
          ) : null}
          {t(PERIOD_LABEL_KEYS[p.id]) || p.label}
        </button>
      ))}
    </div>
  );
}
