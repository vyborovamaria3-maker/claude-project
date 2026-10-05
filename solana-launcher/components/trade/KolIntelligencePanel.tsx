"use client";

import { useEffect, useMemo, useState } from "react";

type Trade = {
  source: "kol" | "smartmoney" | string;
  maker: string;
  side: "buy" | "sell" | string;
  tokenAddress: string;
  symbol?: string | null;
  amountUsd?: number | null;
  tokenAmount?: number | null;
  priceUsd?: number | null;
  buyCostUsd?: number | null;
  priceNow?: number | null;
  priceChange?: number | null;
  timestamp?: number | null;
  positionAction?: string | null;
  launchpad?: string | null;
  twitterUsername?: string | null;
  twitterName?: string | null;
  avatar?: string | null;
  tags?: string[] | null;
  transactionHash?: string | null;
};

type KolResponse = {
  available: boolean;
  configured: boolean;
  mint: string;
  kolTrades: Trade[];
  smartMoneyTrades: Trade[];
  liveSignals: unknown[];
  errors?: string[];
  stale?: boolean;
  cacheTtlMs?: number;
  fetchedAt?: number;
  error?: string;
};

function usd(value: number) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, {
    maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
  })}`;
}

function shortWallet(value: string) {
  if (!value) return "-";
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function tradeFlow(rows: Trade[]) {
  return rows.reduce((sum, row) => {
    const amount = Number(row.amountUsd || 0);
    const side = String(row.side || "").toLowerCase();
    return sum + (side === "buy" ? amount : side === "sell" ? -amount : 0);
  }, 0);
}

function countSide(rows: Trade[], side: string) {
  return rows.filter((row) => String(row.side || "").toLowerCase() === side).length;
}

function uniqueMakers(rows: Trade[]) {
  return new Set(rows.map((row) => row.maker).filter(Boolean)).size;
}

function timeLabel(timestamp?: number | null) {
  if (!timestamp) return "--:--";
  const ms = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function unsignedUsd(value?: number | null) {
  return `$${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export default function KolIntelligencePanel({ mint }: { mint: string }) {
  const [data, setData] = useState<KolResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/trade/kols?mint=${encodeURIComponent(mint)}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as KolResponse;
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load KOL intelligence");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [mint]);

  const summary = useMemo(() => {
    const kol = data?.kolTrades ?? [];
    const smart = data?.smartMoneyTrades ?? [];
    const all = [...kol, ...smart];

    const riskTags = Array.from(
      new Set(
        all
          .flatMap((row) => row.tags ?? [])
          .filter((tag) =>
            ["wash_trader", "arbitrager", "sniper", "insider", "bundler"].includes(tag)
          )
      )
    );

    const topKol = [...kol]
      .sort((a, b) => Number(b.amountUsd || 0) - Number(a.amountUsd || 0))[0];

    const timeline = [...all]
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, 12);

    return {
      kol,
      smart,
      hasKolActivity: kol.length > 0,
      hasSmartActivity: smart.length > 0,
      kolFlow: tradeFlow(kol),
      smartFlow: tradeFlow(smart),
      kolBuys: countSide(kol, "buy"),
      kolSells: countSide(kol, "sell"),
      smartBuys: countSide(smart, "buy"),
      smartSells: countSide(smart, "sell"),
      uniqueKols: uniqueMakers(kol),
      uniqueSmart: uniqueMakers(smart),
      riskTags,
      topKol,
      timeline,
    };
  }, [data]);

  return (
    <section className="glass rounded-xl border border-bg-border p-4" data-tag="trade.analysis.kols">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-sm font-semibold text-white">KOL & Smart Money</h2>
          <p className="text-xs text-white/40 mt-0.5">
            Recent wallet activity, social identity and risk context for this token
          </p>
        </div>
        {data?.stale ? (
          <span className="text-[10px] px-2 py-1 rounded bg-yellow-500/10 text-yellow-300 border border-yellow-500/20">
            cached
          </span>
        ) : null}
      </div>

      {loading && (
        <div className="py-8 text-center text-sm text-white/40">Loading KOL intelligence...</div>
      )}

      {error && !loading && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Metric
              label="KOL Activity"
              value={`${summary.kolBuys} buy / ${summary.kolSells} sell`}
              sub={`${summary.uniqueKols} unique`}
            />
            <Metric
              label="Net KOL Flow"
              value={usd(summary.kolFlow)}
              sub={`${summary.kol.length} matched trades`}
            />
            <Metric
              label="Smart Money Flow"
              value={usd(summary.smartFlow)}
              sub={`${summary.smartBuys} buy / ${summary.smartSells} sell`}
            />
            <Metric
              label="Smart Wallets"
              value={String(summary.uniqueSmart)}
              sub={`${summary.smart.length} matched trades`}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-[0.9fr_1.6fr] mt-3">
            <div className="rounded-lg border border-white/5 bg-white/[0.025] p-3">
              <div className="text-[11px] uppercase tracking-wide text-white/35 mb-2">Top caller</div>
              {summary.topKol ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    {summary.topKol.avatar ? (
                      <img
                        src={summary.topKol.avatar}
                        alt=""
                        className="w-8 h-8 rounded-full border border-white/10"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-white/5 border border-white/10" />
                    )}
                    <div className="min-w-0">
                      <div className="text-sm text-white truncate">
                        {summary.topKol.twitterUsername
                          ? `@${summary.topKol.twitterUsername}`
                          : shortWallet(summary.topKol.maker)}
                      </div>
                      <div className="text-[11px] text-white/40 truncate">
                        {summary.topKol.twitterName || shortWallet(summary.topKol.maker)}
                      </div>
                    </div>
                  </div>
                  <div className="text-xs text-white/60">
                    Latest matched size: {unsignedUsd(summary.topKol.amountUsd)}
                  </div>
                  <div className="text-[11px] text-white/40 break-all">
                    Wallet: {summary.topKol.maker}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(summary.topKol.tags ?? []).slice(0, 8).map((tag) => (
                      <span
                        key={tag}
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${
                          ["wash_trader", "arbitrager", "sniper", "insider", "bundler"].includes(tag)
                            ? "border-red-500/20 bg-red-500/10 text-red-300"
                            : "border-white/10 bg-white/5 text-white/45"
                        }`}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-xs text-white/35">No recent KOL activity for this token.</div>
              )}

              <div className="mt-4 pt-3 border-t border-white/5">
                <div className="text-[11px] uppercase tracking-wide text-white/35 mb-2">Risk tags</div>
                {summary.riskTags.length ? (
                  <div className="flex flex-wrap gap-1">
                    {summary.riskTags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-red-500/20 bg-red-500/10 text-red-300"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-white/35">No flagged tags in current snapshot.</div>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-white/5 bg-white/[0.025] overflow-hidden">
              <div className="px-3 py-2 border-b border-white/5 text-[11px] uppercase tracking-wide text-white/35">
                Activity timeline
              </div>
              {summary.timeline.length ? (
                <div className="divide-y divide-white/5">
                  {summary.timeline.map((row, i) => (
                    <div
                      key={`${row.transactionHash || row.maker}-${i}`}
                      className="grid grid-cols-[44px_64px_minmax(0,1fr)] sm:grid-cols-[48px_74px_minmax(0,1fr)_auto] gap-2 items-center px-3 py-2 text-xs"
                    >
                      <span className="text-white/35">{timeLabel(row.timestamp)}</span>
                      <span className="text-white/45">
                        {row.source === "kol" ? "KOL" : "SMART"}
                      </span>
                      <span className="truncate text-white/70 min-w-0">
                        {row.twitterUsername ? `@${row.twitterUsername}` : shortWallet(row.maker)}
                      </span>
                      <span
                        className={
                          (String(row.side || "").toLowerCase() === "buy"
                            ? "text-emerald-300"
                            : String(row.side || "").toLowerCase() === "sell"
                              ? "text-red-300"
                              : "text-white/60")
                        + " col-span-3 sm:col-span-1 sm:text-right"}
                      >
                        {String(row.side || "").toUpperCase()} {unsignedUsd(row.amountUsd)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-4 text-xs text-white/35">
                  No recent KOL activity for this token.
                  <br />
                  No recent Smart Money activity for this token.
                </div>
              )}
            </div>
          </div>

          {(!summary.hasKolActivity || !summary.hasSmartActivity) && (
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {!summary.hasKolActivity && (
                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 text-xs text-white/35">
                  No recent KOL activity for this token
                </div>
              )}
              {!summary.hasSmartActivity && (
                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 text-xs text-white/35">
                  No recent Smart Money activity for this token
                </div>
              )}
            </div>
          )}

          {(data.errors?.length ?? 0) > 0 && (
            <div className="mt-3 text-[11px] text-yellow-300/70">
              Partial source errors: {data.errors?.join(" | ")}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.025] p-3">
      <div className="text-[10px] uppercase tracking-wide text-white/35">{label}</div>
      <div className="text-sm font-semibold text-white mt-1">{value}</div>
      <div className="text-[11px] text-white/35 mt-0.5">{sub}</div>
    </div>
  );
}
