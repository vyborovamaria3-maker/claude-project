"use client";

import { useState, useRef, useCallback } from "react";
import { Clock, Users, Play, Square, CheckCircle2, Loader2 } from "lucide-react";
import { generateWallets, loadWallets, type WalletRole } from "@/lib/walletStore";

const TOTAL_LIMIT = 99;

type Props = {
  defaultRole?: WalletRole;
  onClose?: () => void;
};

export default function AdaptiveGenerateCard({ defaultRole = "bundle", onClose }: Props) {
  const [hours, setHours] = useState(1);
  const [count, setCount] = useState(10);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cancelledRef = useRef(false);

  const remaining = Math.max(0, TOTAL_LIMIT - loadWallets().length);

  const stop = useCallback(() => {
    cancelledRef.current = true;
    timerRef.current.forEach(clearTimeout);
    timerRef.current = [];
    setRunning(false);
  }, []);

  const start = useCallback(() => {
    if (running || count < 1 || hours < 0.1) return;
    const cap = Math.min(count, remaining);
    if (cap < 1) return;

    cancelledRef.current = false;
    setRunning(true);
    setDone(false);
    setProgress(0);
    setTotal(cap);

    const durationMs = hours * 3600 * 1000;

    for (let i = 0; i < cap; i++) {
      const delay = Math.random() * durationMs;
      const t = setTimeout(async () => {
        if (cancelledRef.current) return;
        try {
          await generateWallets(1, defaultRole);
        } catch {
          // skip errors
        }
        setProgress((p) => {
          const next = p + 1;
          if (next >= cap) {
            setRunning(false);
            setDone(true);
          }
          return next;
        });
      }, delay);
      timerRef.current.push(t);
    }
  }, [running, count, hours, remaining, defaultRole]);

  return (
    <div
      data-tag="step3.adaptive_generate.card"
      className="rounded-xl border border-neon-purple/40 bg-neon-purple/5 p-5 space-y-4"
    >
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-neon-purple" />
        <span className="text-white font-semibold">Adaptive Generate</span>
        <span className="text-xs text-white/40 ml-auto">
          {remaining} slots left
        </span>
      </div>

      <p className="text-xs text-white/50">
        Wallets will be created at random intervals within the specified time window.
        This mimics natural user behaviour.
      </p>

      {!running && !done && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs text-white/50 flex items-center gap-1.5">
              <Clock className="w-3 h-3" /> Duration (hours)
            </label>
            <input
              type="number"
              min={0.1}
              max={72}
              step={0.1}
              value={hours}
              onChange={(e) => setHours(Math.max(0.1, parseFloat(e.target.value) || 0.1))}
              className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neon-purple/50"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-white/50 flex items-center gap-1.5">
              <Users className="w-3 h-3" /> Wallets
            </label>
            <input
              type="number"
              min={1}
              max={Math.min(99, remaining)}
              value={count}
              onChange={(e) => setCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
              className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neon-purple/50"
            />
          </div>
        </div>
      )}

      {(running || done) && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-white/70">{done ? "Completed" : "Generating..."}</span>
            <span className="text-neon-purple font-mono">
              {progress}/{total}
            </span>
          </div>
          <div className="w-full h-2 bg-bg-soft rounded-full overflow-hidden">
            <div
              className="h-full bg-neon-purple rounded-full transition-all duration-300"
              style={{ width: total > 0 ? (progress / total) * 100 + "%" : "0%" }}
            />
          </div>
          {running && (
            <div className="flex items-center gap-2 text-xs text-white/40">
              <Loader2 className="w-3 h-3 animate-spin" />
              Creating wallets at random intervals over {hours}h
            </div>
          )}
          {done && (
            <div className="flex items-center gap-2 text-xs text-neon-green">
              <CheckCircle2 className="w-3 h-3" />
              All {total} wallets created successfully
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        {!running && !done && (
          <button
            type="button"
            data-tag="step3.adaptive_generate.start"
            onClick={start}
            disabled={count < 1 || remaining < 1}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-neon-purple text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <Play className="w-4 h-4" />
            Start ({Math.min(count, remaining)} wallets over {hours}h)
          </button>
        )}
        {running && (
          <button
            type="button"
            data-tag="step3.adaptive_generate.stop"
            onClick={stop}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition"
          >
            <Square className="w-4 h-4" />
            Stop
          </button>
        )}
        {done && (
          <button
            type="button"
            data-tag="step3.adaptive_generate.reset"
            onClick={() => {
              setDone(false);
              setProgress(0);
              setTotal(0);
            }}
            className="flex-1 py-2.5 rounded-lg border border-bg-border text-white/70 hover:border-white/30 transition text-sm"
          >
            New Batch
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 rounded-lg border border-bg-border text-white/50 hover:text-white transition text-sm"
          >
            Close
          </button>
        )}
      </div>
    </div>
  );
}
