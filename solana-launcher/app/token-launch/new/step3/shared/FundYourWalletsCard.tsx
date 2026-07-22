"use client";

import { useState } from "react";
import { AlertTriangle, Send } from "lucide-react";

type DistMode = "auto" | "manual" | "equal" | "range";

// data-tag: step3.fund.card
export default function FundYourWalletsCard({
  selectedCount = 1,
}: {
  selectedCount?: number;
}) {
  const [includeDev, setIncludeDev] = useState(false);
  const [mode, setMode] = useState<DistMode>("auto");
  const [total, setTotal] = useState("0.1");
  const [minPct, setMinPct] = useState("80");
  const [maxPct, setMaxPct] = useState("120");
  const [manualAmounts, setManualAmounts] = useState<Record<string, string>>({});

  // Mock wallets shown in Manual mode
  const wallets = [
    { id: "w1", address: "DLuQtJZpMaqeocUT3wkwXjwQx22sGWcBig2oZpQYwWHD", balance: 0, skipped: true },
  ];

  const totalToSend = wallets.reduce((sum, w) => {
    const v = parseFloat(manualAmounts[w.id] ?? "");
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);
  const filledCount = wallets.filter((w) => {
    const v = parseFloat(manualAmounts[w.id] ?? "");
    return Number.isFinite(v) && v > 0;
  }).length;

  return (
    <div
      data-tag="step3.fund.card"
      className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-5 space-y-4"
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
          <AlertTriangle className="w-4 h-4" />
        </div>
        <div>
          <div className="text-amber-400 font-semibold">Fund Your Wallets</div>
          <p className="text-sm text-amber-200/70 mt-1 leading-snug">
            {selectedCount} selected wallet(s) have zero balance (including DEV). Fund selected
            launch wallets from your Phantom wallet before launching.
          </p>
        </div>
      </div>

      <div
        data-tag="step3.fund.card.body"
        className="rounded-lg border border-bg-border bg-bg-card/50 p-4 space-y-3"
      >
        <label
          data-tag="step3.fund.include_dev"
          className="flex items-center gap-2 text-sm text-white/80 cursor-pointer select-none"
        >
          <input
            type="checkbox"
            checked={includeDev}
            onChange={(e) => setIncludeDev(e.target.checked)}
            className="w-4 h-4 accent-neon-green"
          />
          Include dev wallet in Phantom funding
        </label>

        <div data-tag="step3.fund.mode" className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ModeBtn tag="step3.fund.mode.auto" active={mode === "auto"} onClick={() => setMode("auto")}>
              Auto
            </ModeBtn>
            <ModeBtn tag="step3.fund.mode.manual" active={mode === "manual"} onClick={() => setMode("manual")}>
              Manual
            </ModeBtn>
            {mode !== "manual" && (
              <>
                <span className="w-1 h-1 rounded-full bg-white/40 mx-1" />
                <ModeBtn tag="step3.fund.mode.equal" active={mode === "equal"} onClick={() => setMode("equal")}>
                  Equal
                </ModeBtn>
                <ModeBtn tag="step3.fund.mode.range" active={mode === "range"} onClick={() => setMode("range")}>
                  Range
                </ModeBtn>
              </>
            )}
          </div>
          {mode === "manual" && (
            <button
              type="button"
              data-tag="step3.fund.apply_recommended"
              className="text-sm font-semibold text-cyan-300 hover:text-cyan-200 transition"
            >
              Apply recommended
            </button>
          )}
        </div>

        {mode === "manual" ? (
          <div data-tag="step3.fund.manual" className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/70">Manual distribution</span>
              <span data-tag="step3.fund.manual.count" className="text-white/50">
                {filledCount} wallet(s) with amount
              </span>
            </div>

            <div className="space-y-2">
              {wallets.map((w) => (
                <div
                  key={w.id}
                  data-tag="step3.fund.manual.row"
                  className="flex items-center gap-3 rounded-lg border border-bg-border bg-bg-soft/40 px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono text-white/80 truncate">{w.address}</div>
                    <div className="text-[11px] text-white/40 mt-0.5">
                      Balance: {w.balance.toFixed(4)} SOL{w.skipped ? " · skipped for Phantom" : ""}
                    </div>
                  </div>
                  <input
                    data-tag="step3.fund.manual.amount"
                    type="text"
                    placeholder="0.00"
                    value={manualAmounts[w.id] ?? ""}
                    onChange={(e) =>
                      setManualAmounts((prev) => ({ ...prev, [w.id]: e.target.value }))
                    }
                    className="w-28 bg-bg-soft/60 border border-bg-border rounded-md px-2.5 py-1.5 text-sm text-right focus:outline-none focus:border-neon-green/50"
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-1">
              <span data-tag="step3.fund.manual.total" className="text-sm text-white/70">
                Total to send: {totalToSend.toFixed(4)} SOL
              </span>
              <button
                type="button"
                data-tag="step3.fund.submit"
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-neon-green/80 hover:bg-neon-green text-bg font-semibold text-sm transition"
              >
                <Send className="w-4 h-4" />
                Fund from Phantom
              </button>
            </div>
          </div>
        ) : mode === "range" ? (
          <div data-tag="step3.fund.range" className="space-y-3">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <div className="text-xs text-white/60 mb-1">Total SOL to distribute</div>
                <input
                  data-tag="step3.fund.total"
                  type="text"
                  value={total}
                  onChange={(e) => setTotal(e.target.value)}
                  className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-neon-green/50"
                />
              </div>
              <div className="w-20">
                <div className="text-xs text-white/60 mb-1">Min %</div>
                <input
                  data-tag="step3.fund.range.min"
                  type="text"
                  value={minPct}
                  onChange={(e) => setMinPct(e.target.value)}
                  className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-neon-green/50"
                />
              </div>
              <div className="w-20">
                <div className="text-xs text-white/60 mb-1">Max %</div>
                <input
                  data-tag="step3.fund.range.max"
                  type="text"
                  value={maxPct}
                  onChange={(e) => setMaxPct(e.target.value)}
                  className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-neon-green/50"
                />
              </div>
              <button
                type="button"
                data-tag="step3.fund.range.reshuffle"
                className="px-4 py-2 rounded-lg border border-bg-border bg-bg-card/40 text-sm text-white/80 hover:border-white/20 hover:text-white transition"
              >
                Reshuffle
              </button>
            </div>

            <p className="text-xs text-white/50 leading-snug">
              Fills each wallet&apos;s launch shortfall first, then splits the rest with random
              weights between min/max % of an equal share.
            </p>

            <div className="flex justify-end">
              <button
                type="button"
                data-tag="step3.fund.submit"
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-neon-green/80 hover:bg-neon-green text-bg font-semibold text-sm transition"
              >
                <Send className="w-4 h-4" />
                Fund from Phantom
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <div className="text-xs text-white/60 mb-1">Total SOL to distribute</div>
              <input
                data-tag="step3.fund.total"
                type="text"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-neon-green/50"
              />
            </div>
            <button
              type="button"
              data-tag="step3.fund.submit"
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-neon-green/80 hover:bg-neon-green text-bg font-semibold text-sm transition"
            >
              <Send className="w-4 h-4" />
              Fund from Phantom
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeBtn({
  tag,
  active,
  onClick,
  children,
}: {
  tag: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-tag={tag}
      onClick={onClick}
      className={[
        "px-3 py-1.5 rounded-md text-sm font-medium transition border",
        active
          ? "bg-neon-green text-bg border-neon-green"
          : "bg-bg-card/40 border-bg-border text-white/70 hover:text-white hover:border-white/20",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
