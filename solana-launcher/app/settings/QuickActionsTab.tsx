"use client";

import { useEffect, useState } from "react";
import { Pencil, RotateCcw, X } from "lucide-react";

const LS_KEY = "solana-launcher.quick-actions";

type Mode = "percentage" | "sol";

type QuickActionsConfig = {
  sellMode: Mode;
  buyMode: Mode;
  sellPct: number[];
  sellSol: number[];
  buySol: number[];
  buyPct: number[];
  priorityFee: number;
  slippage: number;
  jitoTip: number;
};

const DEFAULTS: QuickActionsConfig = {
  sellMode: "percentage",
  buyMode: "sol",
  sellPct: [25, 50, 75, 100],
  sellSol: [0.1, 0.25, 0.5, 1],
  buySol: [0.1, 0.25, 0.5, 1],
  buyPct: [10, 25, 50, 100],
  priorityFee: 0.001,
  slippage: 1,
  jitoTip: 0.0001,
};

function load(): QuickActionsConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(v: QuickActionsConfig) {
  localStorage.setItem(LS_KEY, JSON.stringify(v));
}

function ChipEditor({
  values,
  onChange,
  editing,
  color,
  suffix = "",
}: {
  values: number[];
  onChange: (v: number[]) => void;
  editing: boolean;
  color: "red" | "green";
  suffix?: string;
}) {
  const [drafts, setDrafts] = useState(values.map(String));

  useEffect(() => {
    setDrafts(values.map(String));
  }, [values, editing]);

  const palette = color === "green"
    ? { bg: "rgba(20,241,149,0.16)", fg: "var(--theme-success)", border: "var(--theme-success-border)" }
    : { bg: "rgba(239,68,68,0.12)", fg: "var(--theme-danger)", border: "var(--theme-danger-border)" };

  const commit = (newDrafts: string[]) => {
    const parsed = newDrafts.map((s) => parseFloat(s)).filter((n) => !Number.isNaN(n) && n > 0);
    if (parsed.length) onChange(parsed);
  };

  const update = (i: number, val: string) => {
    const next = [...drafts];
    next[i] = val;
    setDrafts(next);
    commit(next);
  };

  const remove = (i: number) => {
    const next = drafts.filter((_, idx) => idx !== i);
    setDrafts(next);
    commit(next);
  };

  return (
    <div className="flex flex-nowrap items-center justify-center gap-2 min-h-[2.25rem] overflow-x-auto">
      {drafts.map((d, i) => (
        <div key={i} className="relative group shrink-0" style={{ height: "2.125rem", width: "4rem" }}>
          <div
            className="h-full w-full flex items-center justify-center rounded-lg border"
            style={{ borderColor: palette.border, background: palette.bg }}
          >
            {editing ? (
              <input
                type="number"
                value={d}
                onChange={(e) => update(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const val = parseFloat((e.target as HTMLInputElement).value);
                    if (!Number.isNaN(val) && val > 0) {
                      const next = [...drafts];
                      next[i] = String(val);
                      setDrafts(next);
                      commit(next);
                    }
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === "Backspace" && d === "") remove(i);
                }}
                className="w-full h-full bg-transparent outline-none text-center text-sm font-semibold px-2 text-content"
              />
            ) : (
              <span className="text-sm font-semibold whitespace-nowrap text-content">
                {parseFloat(d)}{suffix}
              </span>
            )}
          </div>
          {editing && (
            <button
              onClick={() => remove(i)}
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-bg-card border border-bg-border flex items-center justify-center text-content-muted hover:text-danger hover:border-danger-border transition opacity-0 group-hover:opacity-100"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          )}
        </div>
      ))}
      {editing && (
        <button
          type="button"
          onClick={() => setDrafts((prev) => [...prev, ""])}
          className="shrink-0 h-[2.125rem] w-16 rounded-lg text-sm font-semibold border border-dashed border-white/20 text-content-faint hover:text-content hover:border-primary-border transition"
        >
          +
        </button>
      )}
    </div>
  );
}

export default function QuickActionsTab() {
  const [cfg, setCfg] = useState<QuickActionsConfig>(() => load());
  const [editSellPct, setEditSellPct] = useState(false);
  const [editSellSol, setEditSellSol] = useState(false);
  const [editBuySol, setEditBuySol] = useState(false);
  const [editBuyPct, setEditBuyPct] = useState(false);

  const update = (patch: Partial<QuickActionsConfig>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    save(next);
  };

  const reset = () => {
    setCfg({ ...DEFAULTS });
    save({ ...DEFAULTS });
  };

  return (
    <div className="space-y-6">
      <section className="surface-panel-hero overflow-hidden p-5 sm:p-6">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,var(--page-glow,var(--theme-primary-soft)),transparent_32%),radial-gradient(circle_at_top_right,var(--page-glow-2,var(--theme-cool-glow)),transparent_30%)]" />
        <div className="relative flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-content">Quick Actions</h2>
            <p className="mt-0.5 text-sm text-content-muted">Preset buttons for faster trading actions and fee tuning.</p>
          </div>
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 text-xs text-content-muted hover:text-content transition"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Reset
          </button>
        </div>
      </section>

      <div className="surface-panel-hero p-5 md:p-6 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-content-muted shrink-0">Mode:</span>
              <div className="flex items-center rounded-lg overflow-hidden border border-bg-border bg-bg-card">
                <button
                  type="button"
                  onClick={() => update({ sellMode: "percentage" })}
                  className={["px-2.5 py-1 text-xs font-semibold transition", cfg.sellMode === "percentage" ? "bg-danger-soft text-danger" : "text-content-muted hover:text-content"].join(" ")}
                >%
                </button>
                <button
                  type="button"
                  onClick={() => update({ sellMode: "sol" })}
                  className={["px-2.5 py-1 text-xs font-semibold transition", cfg.sellMode === "sol" ? "bg-danger-soft text-danger" : "text-content-muted hover:text-content"].join(" ")}
                >SOL</button>
              </div>
            </div>

            <div className="bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] border border-bg-border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-danger">Sell SOL</span>
                  {cfg.sellMode === "sol" && <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-danger-soft text-danger border border-danger-border">Active</span>}
                </div>
                <button onClick={() => setEditSellSol((v) => !v)} className="flex items-center gap-1 text-xs text-content-muted hover:text-content transition">
                  <Pencil className="w-3 h-3" /> Edit
                </button>
              </div>
              <ChipEditor values={cfg.sellSol} editing={editSellSol} onChange={(v) => update({ sellSol: v })} color="red" />
            </div>

            <div className="bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] border border-bg-border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-danger">Sell %</span>
                  {cfg.sellMode === "percentage" && <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-danger-soft text-danger border border-danger-border">Active</span>}
                </div>
                <button onClick={() => setEditSellPct((v) => !v)} className="flex items-center gap-1 text-xs text-content-muted hover:text-content transition">
                  <Pencil className="w-3 h-3" /> Edit
                </button>
              </div>
              <ChipEditor values={cfg.sellPct} editing={editSellPct} onChange={(v) => update({ sellPct: v })} color="red" suffix="%" />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-content-muted shrink-0">Mode:</span>
              <div className="flex items-center rounded-lg overflow-hidden border border-bg-border bg-bg-card">
                <button
                  type="button"
                  onClick={() => update({ buyMode: "sol" })}
                  className={["px-2.5 py-1 text-xs font-semibold transition", cfg.buyMode === "sol" ? "bg-success-soft text-success" : "text-content-muted hover:text-content"].join(" ")}
                >SOL</button>
                <button
                  type="button"
                  onClick={() => update({ buyMode: "percentage" })}
                  className={["px-2.5 py-1 text-xs font-semibold transition", cfg.buyMode === "percentage" ? "bg-success-soft text-success" : "text-content-muted hover:text-content"].join(" ")}
                >%
                </button>
              </div>
            </div>

            <div className="bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] border border-bg-border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-success">Buy SOL</span>
                  {cfg.buyMode === "sol" && <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-success-soft text-success border border-success-border">Active</span>}
                </div>
                <button onClick={() => setEditBuySol((v) => !v)} className="flex items-center gap-1 text-xs text-content-muted hover:text-content transition">
                  <Pencil className="w-3 h-3" /> Edit
                </button>
              </div>
              <ChipEditor values={cfg.buySol} editing={editBuySol} onChange={(v) => update({ buySol: v })} color="green" />
            </div>

            <div className="bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] border border-bg-border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-success">Buy %</span>
                  {cfg.buyMode === "percentage" && <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-success-soft text-success border border-success-border">Active</span>}
                </div>
                <button onClick={() => setEditBuyPct((v) => !v)} className="flex items-center gap-1 text-xs text-content-muted hover:text-content transition">
                  <Pencil className="w-3 h-3" /> Edit
                </button>
              </div>
              <ChipEditor values={cfg.buyPct} editing={editBuyPct} onChange={(v) => update({ buyPct: v })} color="green" suffix="%" />
            </div>
          </div>
        </div>
      </div>

      <div className="surface-panel-hero p-5 md:p-6 space-y-5">
        <div>
          <p className="text-sm font-semibold text-content">Transaction fees</p>
          <p className="text-xs text-content-muted mt-0.5">Applied when trading with regular wallets.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs text-content-muted uppercase tracking-widest">Priority Fee (SOL)</label>
            <input type="number" min={0} step={0.0001} value={cfg.priorityFee} onChange={(e) => update({ priorityFee: parseFloat(e.target.value) || 0 })} className="w-full bg-bg-soft border border-bg-border rounded-lg px-3 py-2.5 text-sm text-content font-mono focus:border-neon-green/40 outline-none" />
            <p className="text-[11px] text-content-faint">Priority fee paid to the network.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-content-muted uppercase tracking-widest">Slippage (%)</label>
            <input type="number" min={0.1} max={100} step={0.1} value={cfg.slippage} onChange={(e) => update({ slippage: parseFloat(e.target.value) || 1 })} className="w-full bg-bg-soft border border-bg-border rounded-lg px-3 py-2.5 text-sm text-content font-mono focus:border-neon-green/40 outline-none" />
            <p className="text-[11px] text-content-faint">Allowed price deviation.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-content-muted uppercase tracking-widest">Jito Tip (SOL)</label>
            <input type="number" min={0} step={0.00001} value={cfg.jitoTip} onChange={(e) => update({ jitoTip: parseFloat(e.target.value) || 0 })} className="w-full bg-bg-soft border border-bg-border rounded-lg px-3 py-2.5 text-sm text-content font-mono focus:border-neon-green/40 outline-none" />
            <p className="text-[11px] text-content-faint">Tip for Jito validators.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
