"use client";
// data-tag: components.trade.filters_panel

import { Filter } from "lucide-react";

export interface TradeFilters {
  showFresh: boolean;
  showSmart: boolean;
  showBundled: boolean;
  showWash: boolean;
  minBalanceUsd: number;
  minSmartProfitUsd: number;
  search: string;
}

export const DEFAULT_FILTERS: TradeFilters = {
  showFresh: false,
  showSmart: false,
  showBundled: false,
  showWash: false,
  minBalanceUsd: 0,
  minSmartProfitUsd: 5000,
  search: "",
};

interface Props {
  filters: TradeFilters;
  onChange: (f: TradeFilters) => void;
  walletsCount: number;
  filteredCount: number;
}

export default function FiltersPanel({ filters, onChange, walletsCount, filteredCount }: Props) {
  const set = <K extends keyof TradeFilters>(k: K, v: TradeFilters[K]) =>
    onChange({ ...filters, [k]: v });

  return (
    <div className="surface-panel rounded-xl border border-bg-border p-4" data-tag="trade.filters">
      <div className="flex items-center gap-2 mb-3">
        <Filter className="w-4 h-4 text-white/40" />
        <h3 className="text-sm font-semibold text-white">Фильтры</h3>
        <span className="ml-auto text-xs text-white/40">
          {filteredCount} / {walletsCount}
        </span>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <Toggle label="🆕 Fresh" active={filters.showFresh} onClick={() => set("showFresh", !filters.showFresh)} />
        <Toggle label="🧠 Smart" active={filters.showSmart} onClick={() => set("showSmart", !filters.showSmart)} />
        <Toggle label="📦 Bundle" active={filters.showBundled} onClick={() => set("showBundled", !filters.showBundled)} />
        <Toggle label="⚠️ Wash" active={filters.showWash} onClick={() => set("showWash", !filters.showWash)} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <NumberField
          label="Min Balance ($)"
          value={filters.minBalanceUsd}
          onChange={(v) => set("minBalanceUsd", v)}
          step={500}
        />
        <NumberField
          label="Smart Profit ≥ ($)"
          value={filters.minSmartProfitUsd}
          onChange={(v) => set("minSmartProfitUsd", v)}
          step={1000}
        />
        <div>
          <label className="text-[10px] uppercase tracking-wider text-white/40">Поиск по кошельку</label>
          <input
            type="text"
            value={filters.search}
            onChange={(e) => set("search", e.target.value)}
            placeholder="Часть адреса…"
            className="mt-1 w-full px-3 py-2 rounded-md bg-white/5 border border-bg-border text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-[color-mix(in_srgb,var(--theme-secondary)_40%,transparent)]"
          />
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-3 py-1.5 rounded-md text-xs font-medium border transition " +
        (active
          ? "bg-[color-mix(in_srgb,var(--theme-secondary)_15%,transparent)] border-[color-mix(in_srgb,var(--theme-secondary)_40%,transparent)] text-[color:var(--theme-secondary)]"
          : "bg-white/5 border-bg-border text-white/50 hover:text-white")
      }
    >
      {label}
    </button>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step: number;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-white/40">{label}</label>
      <input
        type="number"
        value={value}
        step={step}
        min={0}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="mt-1 w-full px-3 py-2 rounded-md bg-white/5 border border-bg-border text-xs text-white focus:outline-none focus:border-[color-mix(in_srgb,var(--theme-secondary)_40%,transparent)]"
      />
    </div>
  );
}
