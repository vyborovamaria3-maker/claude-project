"use client";

import { useState, useRef } from "react";
import { AlertTriangle, Minus, Plus, Clock, Square } from "lucide-react";
import {
  generateWallets,
  loadWallets,
  type WalletRole,
} from "@/lib/walletStore";

const MAX_PER_BATCH = 100;
const TOTAL_LIMIT = 99;

// data-tag: step3.generate.card
export default function GenerateWalletsCard({
  onGenerated,
  defaultRole = "bundle",
}: {
  onGenerated?: (count: number) => void;
  defaultRole?: WalletRole;
}) {
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [schedOpen, setSchedOpen] = useState(false);
  const [schedTotal, setSchedTotal] = useState(20);
  const [schedDurationMin, setSchedDurationMin] = useState(1);
  const [schedRandomize, setSchedRandomize] = useState(false);
  const [schedRunning, setSchedRunning] = useState(false);
  const [schedDone, setSchedDone] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fmtDuration = (min: number) => {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  };

  const startScheduled = () => {
    if (schedRunning) return;
    setSchedRunning(true);
    setSchedDone(0);
    const totalMs = schedDurationMin * 60 * 1000;
    const walletsLeft = schedTotal;
    let generated = 0;

    const scheduleNext = () => {
      if (generated >= walletsLeft) { stopScheduled(); return; }
      const remaining = walletsLeft - generated;
      const count = schedRandomize ? Math.max(1, Math.floor(Math.random() * Math.min(5, remaining)) + 1) : 1;
      const safeBatch = Math.min(count, remaining);
      generateWallets(safeBatch, defaultRole).then(() => {
        generated += safeBatch;
        setSchedDone(generated);
        onGenerated?.(safeBatch);
        if (generated < walletsLeft) {
          const msLeft = totalMs * (1 - generated / walletsLeft);
          const delay = schedRandomize
            ? Math.random() * (msLeft / (walletsLeft - generated)) * 2
            : msLeft / (walletsLeft - generated);
          timeoutRef.current = setTimeout(scheduleNext, Math.max(500, delay));
        } else {
          stopScheduled();
        }
      });
    };
    scheduleNext();
  };

  const stopScheduled = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    setSchedRunning(false);
  };

  const remaining = Math.max(0, TOTAL_LIMIT - loadWallets().length);
  const cap = Math.min(MAX_PER_BATCH, remaining);
  const safeCount = Math.max(1, Math.min(count, Math.max(1, cap)));

  const handleGenerate = async () => {
    if (busy || cap < 1) return;
    setBusy(true);
    setError(null);
    try {
      await generateWallets(safeCount, defaultRole);
      onGenerated?.(safeCount);
    } catch (err: any) {
      setError(err?.message || String(err) || "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-tag="step3.generate.card"
      className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-5 space-y-4"
    >
      <div
        data-tag="step3.generate.warning"
        className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3"
      >
        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <p className="text-sm text-amber-100/90 leading-snug">
          <span className="font-semibold">Export your wallets!</span>{" "}
          <span className="text-white/70">
            Use JSON or TXT format. Private keys are the only way to recover access to your funds.
          </span>
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-white font-semibold">Generate Bundle Wallets</div>
        <div data-tag="step3.generate.remaining" className="text-xs text-white/50">
          {remaining} slots remaining (max {MAX_PER_BATCH} per batch)
        </div>
      </div>

      <div className="flex items-stretch gap-2">
        <button
          type="button"
          data-tag="step3.generate.dec"
          onClick={() => setCount((c) => Math.max(1, c - 1))}
          className="w-10 rounded-lg border border-bg-border bg-bg-card/40 text-white/80 hover:border-white/20 hover:text-white transition flex items-center justify-center"
        >
          <Minus className="w-4 h-4" />
        </button>
        <input
          data-tag="step3.generate.count"
          type="number"
          min={1}
          max={cap || 1}
          value={count}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            setCount(Number.isFinite(v) ? v : 1);
          }}
          className="flex-1 bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-center text-base focus:outline-none focus:border-neon-green/50"
        />
        <button
          type="button"
          data-tag="step3.generate.inc"
          onClick={() => setCount((c) => Math.min(cap || 1, c + 1))}
          className="w-10 rounded-lg border border-bg-border bg-bg-card/40 text-white/80 hover:border-white/20 hover:text-white transition flex items-center justify-center"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          data-tag="step3.generate.submit"
          onClick={handleGenerate}
          disabled={busy || cap < 1}
          className="flex-1 py-2.5 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {busy ? "Generating..." : `Generate ${safeCount} Wallet${safeCount === 1 ? "" : "s"}`}
        </button>
        <button
          type="button"
          onClick={() => setSchedOpen((v) => !v)}
          title="Scheduled generation"
          className={[
            "w-10 rounded-lg border transition flex items-center justify-center",
            schedOpen
              ? "bg-neon-green/20 border-neon-green text-neon-green"
              : "border-bg-border bg-bg-card/40 text-white/60 hover:text-white hover:border-white/20",
          ].join(" ")}
        >
          <Clock className="w-4 h-4" />
        </button>
      </div>

      {schedOpen && (
        <div className="rounded-xl border border-neon-green/20 bg-neon-green/5 p-4 space-y-5">
          <div className="text-sm font-semibold text-white flex items-center gap-2">
            <Clock className="w-4 h-4 text-neon-green" /> Scheduled Generation
          </div>

          {/* Duration slider */}
          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-white/50">Duration</span>
              <span className="text-neon-green font-semibold">{fmtDuration(schedDurationMin)}</span>
            </div>
            <input
              type="range" min={1} max={480} step={1}
              value={schedDurationMin}
              disabled={schedRunning}
              onChange={(e) => setSchedDurationMin(Number(e.target.value))}
              className="w-full accent-neon-green h-1.5 rounded-full cursor-pointer disabled:opacity-40"
            />
            <div className="flex justify-between text-xs text-white/30">
              <span>1 min</span><span>1h</span><span>2h</span><span>4h</span><span>8h</span>
            </div>
          </div>

          {/* Total wallets slider */}
          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-white/50">Total wallets</span>
              <span className="text-neon-green font-semibold">{schedTotal}</span>
            </div>
            <input
              type="range" min={1} max={99} step={1}
              value={schedTotal}
              disabled={schedRunning}
              onChange={(e) => setSchedTotal(Number(e.target.value))}
              className="w-full accent-neon-green h-1.5 rounded-full cursor-pointer disabled:opacity-40"
            />
            <div className="flex justify-between text-xs text-white/30">
              <span>1</span><span>25</span><span>50</span><span>75</span><span>99</span>
            </div>
          </div>

          {/* Randomize toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-white font-medium">Random intervals</p>
              <p className="text-[10px] text-white/40">Generates at random moments within the duration</p>
            </div>
            <button
              type="button"
              disabled={schedRunning}
              onClick={() => setSchedRandomize((v) => !v)}
              className={[
                "w-10 h-5 rounded-full transition relative disabled:opacity-40",
                schedRandomize ? "bg-neon-green" : "bg-bg-border",
              ].join(" ")}
            >
              <span className={[
                "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all",
                schedRandomize ? "left-[22px]" : "left-0.5",
              ].join(" ")} />
            </button>
          </div>

          {/* Progress */}
          {(schedRunning || schedDone > 0) && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-white/50">
                <span>Progress</span>
                <span>{Math.min(schedDone, schedTotal)} / {schedTotal}</span>
              </div>
              <div className="h-1.5 rounded-full bg-bg-border overflow-hidden">
                <div
                  className="h-full bg-neon-green transition-all duration-500"
                  style={{ width: `${Math.min(100, (schedDone / schedTotal) * 100)}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={startScheduled}
              disabled={schedRunning}
              className="flex-1 py-2 rounded-lg bg-neon-green text-bg text-sm font-semibold hover:shadow-neon-green disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {schedRunning ? "Running..." : "Start"}
            </button>
            {schedRunning && (
              <button
                type="button"
                onClick={stopScheduled}
                className="px-4 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 text-sm font-semibold hover:bg-red-500/20 transition flex items-center gap-1"
              >
                <Square className="w-3 h-3" /> Stop
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div
          data-tag="step3.generate.error"
          className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300"
        >
          <div className="font-semibold">Generation failed</div>
          <div className="mt-1 font-mono text-xs break-all">{error}</div>
        </div>
      )}
    </div>
  );
}
