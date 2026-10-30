"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { buildSocialSourceParams, fetchJson } from "@/lib/trade/social-intelligence-api";
import { DEFAULT_SOCIAL_OPTIONS, deriveSocialMetrics, MINT_RE, type Market, type SocialTimeline, type TwitterStats } from "@/lib/trade/social-intelligence";

type Source<T> = { status: "idle" | "loading" | "ready" | "error"; data: T | null };
type Evidence = {
  observedDexTrades: unknown[];
  seedWalletTrades: unknown[];
  walletPnl: Array<{ status?: string }>;
  meta: { forensicIndexAvailable: boolean; dexIndexAvailable: boolean };
};
type Snapshot = { mint: string; x: Source<TwitterStats>; tg: Source<SocialTimeline>; market: Source<Market>; chain: Source<Evidence> };
const source = <T,>(loading: boolean): Source<T> => ({ status: loading ? "loading" : "idle", data: null });
const empty = (mint: string): Snapshot => {
  const loading = MINT_RE.test(mint);
  return { mint, x: source(loading), tg: source(loading), market: source(loading), chain: source(loading) };
};
export const overviewNumber = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1, notation: n >= 10000 ? "compact" : "standard" }).format(n);
export function telegramMentions(tg: SocialTimeline | null) {
  return tg == null ? null : tg.meta?.matchedPlatforms?.telegram ?? tg.meta?.matchedBeforeLimit ?? tg.platforms?.telegram ?? tg.timeline.filter(item => !item.platform || item.platform.toLowerCase() === "telegram").length;
}

/** Source GET summaries. No model generation, stream analysis or RPC backfill. */
export default function useAnalysisOverview(mint: string) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => empty(mint));
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    setSnapshot(empty(mint));
    if (!MINT_RE.test(mint)) return;
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 25000);
    const { x, tg } = buildSocialSourceParams(mint, DEFAULT_SOCIAL_OPTIONS);
    const backend = (process.env.NEXT_PUBLIC_BACKEND_URL || "/fastapi").replace(/\/$/, "");
    async function read<K extends "x" | "tg" | "market" | "chain">(key: K, url: string, valid: (data: Snapshot[K]["data"]) => boolean) {
      try {
        const data = await fetchJson<Snapshot[K]["data"]>(url, controller.signal);
        if (!valid(data)) throw new Error("Incomplete source response");
        if (active) setSnapshot(previous => ({ ...previous, [key]: { status: "ready", data } }));
      } catch {
        if (active) setSnapshot(previous => ({ ...previous, [key]: { status: "error", data: null } }));
      }
    }
    void Promise.all([
      read("x", `/api/trade/dev-twitter?${x}`, data => !!data && Number.isFinite(data.totalTweets) && Array.isArray(data.topTweets) && Array.isArray(data.shillers) && !!data.aggregated),
      read("tg", `${backend}/api/v1/social/token/${encodeURIComponent(mint)}?${tg}`, data => !!data && Array.isArray(data.timeline)),
      read("market", `/api/token-ohlcv?mint=${encodeURIComponent(mint)}`, data => !!data?.pair),
      read("chain", `/api/blockchain/evidence?mint=${encodeURIComponent(mint)}&limit=100`, data => !!data?.meta && Array.isArray(data.observedDexTrades) && Array.isArray(data.seedWalletTrades) && Array.isArray(data.walletPnl)),
    ]).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [mint, revision]);
  // A URL change must never display the previous token while the effect catches up.
  const current = snapshot.mint === mint ? snapshot : empty(mint);
  const metrics = useMemo(() => deriveSocialMetrics(current.x.data, current.tg.data, current.market.data, null, null, [], DEFAULT_SOCIAL_OPTIONS), [current.x.data, current.tg.data, current.market.data]);
  return { ...current, metrics, refresh, loading: [current.x, current.tg, current.market, current.chain].some(item => item.status === "loading") };
}
