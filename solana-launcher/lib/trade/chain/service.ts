import { analyzeChainFull, type ChainAnalysisFull } from "./analyze";
import { HybridChainProvider } from "./provider";

const DEFAULT_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;

type CacheEntry = {
  value: ChainAnalysisFull;
  cachedAt: number;
  expiresAt: number;
};

const resultCache = new Map<string, CacheEntry>();
type InFlightEntry = { promise: Promise<ChainAnalysisFull>; generation: string };
const inFlight = new Map<string, InFlightEntry>();
const mintGeneration = new Map<string, number>();
let globalGeneration = 0;

function generationFor(mint: string): string {
  return `${globalGeneration}:${mintGeneration.get(mint) ?? 0}`;
}

export function chainRpcUrl(): string {
  return (
    process.env.SOLANA_RPC_URL?.trim()
    || process.env.NEXT_PUBLIC_HELIUS_RPC_URL?.trim()
    || process.env.NEXT_PUBLIC_RPC_URL?.trim()
    || "https://api.mainnet-beta.solana.com"
  );
}

function cacheTtlMs(): number {
  const raw = Number(process.env.CHAIN_FULL_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS);
  return Number.isFinite(raw) ? Math.max(10_000, raw) : DEFAULT_CACHE_TTL_MS;
}

function prune(now: number): void {
  for (const [key, value] of resultCache) {
    if (value.expiresAt <= now) resultCache.delete(key);
  }
  while (resultCache.size > MAX_CACHE_ENTRIES) {
    const key = resultCache.keys().next().value as string | undefined;
    if (!key) break;
    resultCache.delete(key);
  }
}

export type CachedChainAnalysis = {
  value: ChainAnalysisFull;
  cacheHit: boolean;
  cacheSource: "cache" | "inflight" | "fresh";
  cachedAt: number;
  ageMs: number;
};

export async function getChainAnalysisCached(
  mint: string,
  options: { refresh?: boolean; now?: number } = {},
): Promise<CachedChainAnalysis> {
  const startedAt = options.now ?? Date.now();
  prune(startedAt);

  if (!options.refresh) {
    const cached = resultCache.get(mint);
    if (cached && cached.expiresAt > startedAt) {
      return {
        value: cached.value,
        cacheHit: true,
        cacheSource: "cache",
        cachedAt: cached.cachedAt,
        ageMs: Math.max(0, startedAt - cached.cachedAt),
      };
    }
  }

  // A refresh bypasses the completed-result cache, but it must not fan out duplicate
  // RPC/provider work when another analysis for the same mint is already running.
  const existing = inFlight.get(mint);
  if (existing) {
    const value = await existing.promise;
    const cachedAt = resultCache.get(mint)?.cachedAt ?? Date.now();
    return {
      value,
      cacheHit: true,
      cacheSource: "inflight",
      cachedAt,
      ageMs: Math.max(0, Date.now() - cachedAt),
    };
  }

  const generation = generationFor(mint);
  let work!: Promise<ChainAnalysisFull>;
  work = analyzeChainFull(new HybridChainProvider(chainRpcUrl()), mint, startedAt)
    .then((value) => {
      const cachedAt = Date.now();
      if (generationFor(mint) === generation) {
        resultCache.set(mint, {
          value,
          cachedAt,
          expiresAt: cachedAt + cacheTtlMs(),
        });
      }
      return value;
    })
    .finally(() => {
      if (inFlight.get(mint)?.promise === work) inFlight.delete(mint);
    });

  inFlight.set(mint, { promise: work, generation });
  const value = await work;
  const cachedAt = resultCache.get(mint)?.cachedAt ?? Date.now();
  return { value, cacheHit: false, cacheSource: "fresh", cachedAt, ageMs: Math.max(0, Date.now() - cachedAt) };
}

export function clearChainAnalysisCache(mint?: string): void {
  if (mint) {
    resultCache.delete(mint);
    inFlight.delete(mint);
    mintGeneration.set(mint, (mintGeneration.get(mint) ?? 0) + 1);
    return;
  }
  resultCache.clear();
  inFlight.clear();
  mintGeneration.clear();
  globalGeneration += 1;
}
