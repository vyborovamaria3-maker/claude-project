import { buildDevHistoryReport } from "../dev-history-server";
import { buildBlockchainAiSnapshot, compactBlockchainSnapshotForAi } from "./ai-snapshot";
import { getChainAnalysisCached } from "./service";

const DEFAULT_DEV_HISTORY_SNAPSHOT_TIMEOUT_MS = 8_000;

function devHistorySnapshotTimeoutMs(): number {
  const configured = Number(process.env.BLOCKCHAIN_DEV_HISTORY_SNAPSHOT_TIMEOUT_MS || DEFAULT_DEV_HISTORY_SNAPSHOT_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_DEV_HISTORY_SNAPSHOT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(20_000, Math.floor(configured)));
}

async function withTimeoutFallback<T>(task: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function getBlockchainAiSnapshot(
  mint: string,
  options: { refresh?: boolean; nowMs?: number } = {},
) {
  const nowMs = options.nowMs ?? Date.now();
  const devTimeoutMs = devHistorySnapshotTimeoutMs();
  const devTask = withTimeoutFallback(
    buildDevHistoryReport({ mint, refresh: options.refresh, nowMs }).catch((error) => {
      console.error("[blockchain-ai] DEV history failed; continuing with chain evidence", error);
      return {
        available: false as const,
        creator: null,
        mint,
        reason: "DEV history unavailable",
        status: 502,
      } as Awaited<ReturnType<typeof buildDevHistoryReport>>;
    }),
    devTimeoutMs,
    () => {
      console.warn(`[blockchain-ai] DEV history exceeded ${devTimeoutMs}ms; returning chain evidence without DEV history`);
      return {
        available: false as const,
        creator: null,
        mint,
        reason: "DEV history timed out",
        status: 504,
        sourceStatus: "timeout",
      } as Awaited<ReturnType<typeof buildDevHistoryReport>>;
    },
  );
  const [chainResult, devHistory] = await Promise.all([
    getChainAnalysisCached(mint, { refresh: options.refresh, now: nowMs }),
    devTask,
  ]);

  const snapshot = buildBlockchainAiSnapshot({
    mint,
    chain: chainResult.value,
    devHistory,
    generatedAt: Date.now(),
    chainCacheHit: chainResult.cacheHit,
    chainCacheSource: chainResult.cacheSource,
    chainCacheAgeMs: chainResult.ageMs,
  });

  return {
    snapshot,
    compact: compactBlockchainSnapshotForAi(snapshot),
    cacheHit: chainResult.cacheHit,
    cacheAgeMs: chainResult.ageMs,
  };
}
