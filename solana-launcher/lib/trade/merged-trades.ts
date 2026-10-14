import { parseTransactions } from "./dev-helpers";
import { fetchEnrichedTxsForMint, txsToTrades, type RawTrade } from "./helius";

const SOLSCAN_API_TOKEN = process.env.SOLSCAN_API_TOKEN || "";
const HELIUS_FAST_ENOUGH_TRADES = 100;
const SOLSCAN_SIGNATURE_LIMIT = 300;

type EnrichedTxInput = Parameters<typeof txsToTrades>[0];

type ParsedHeliusTx = {
  signature: string;
  timestamp: number;
  type?: string;
  source?: string;
  feePayer?: string;
  fee?: number;
  tokenTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    mint: string;
    tokenAmount: number;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount: number;
  }>;
  events?: {
    swap?: {
      nativeInput?: { account: string; amount: string };
      nativeOutput?: { account: string; amount: string };
      tokenInputs?: Array<{
        userAccount: string;
        mint: string;
        rawTokenAmount: { tokenAmount: string; decimals: number };
      }>;
      tokenOutputs?: Array<{
        userAccount: string;
        mint: string;
        rawTokenAmount: { tokenAmount: string; decimals: number };
      }>;
    };
  };
};

type SolscanTxListItem = {
  txHash?: string;
  status?: string;
};

type SolscanProTxListItem = {
  trans_id?: string;
  status?: string;
};

async function solscanApi<T>(endpoint: string, usePro = false): Promise<T | null> {
  if (!SOLSCAN_API_TOKEN) return null;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);

  try {
    const base = usePro ? "https://pro-api.solscan.io/v2.0" : "https://api.solscan.io";
    const headers: Record<string, string> = usePro
      ? { token: SOLSCAN_API_TOKEN, Accept: "application/json" }
      : { Authorization: `Bearer ${SOLSCAN_API_TOKEN}`, Accept: "application/json" };

    const r = await fetch(`${base}${endpoint}`, {
      headers,
      signal: ctrl.signal,
      cache: "no-store",
    });

    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const SOLSCAN_CONCURRENCY = (() => {
  const value = Number(process.env.SOLSCAN_FETCH_CONCURRENCY || 3);
  return Number.isFinite(value) ? Math.max(1, Math.min(4, Math.floor(value))) : 3;
})();
const PARSE_CONCURRENCY = (() => {
  const value = Number(process.env.SOLSCAN_PARSE_CONCURRENCY || 4);
  return Number.isFinite(value) ? Math.max(1, Math.min(6, Math.floor(value))) : 4;
})();

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

async function fetchSolscanSignaturesForMint(mint: string, maxTrades: number): Promise<string[]> {
  if (!SOLSCAN_API_TOKEN) return [];

  const limit = Math.min(maxTrades, SOLSCAN_SIGNATURE_LIMIT);
  const pageSize = 40;
  const maxPages = Math.max(1, Math.min(8, Math.ceil(limit / pageSize)));
  const signatures: string[] = [];
  const seen = new Set<string>();

  const getPage = async (pageIndex: number): Promise<Array<{ signature?: string; status?: string }>> => {
    const offset = pageIndex * pageSize;
    const endpoint = `/account/transactions?address=${mint}&limit=${pageSize}&offset=${offset}`;
    const page = await solscanApi<{ success?: boolean; data?: SolscanTxListItem[] }>(endpoint);
    const proPage = page?.data?.length
      ? null
      : await solscanApi<{ success?: boolean; data?: SolscanProTxListItem[] }>(endpoint, true);
    return [
      ...(page?.data ?? []).map((item) => ({ signature: item.txHash, status: item.status })),
      ...(proPage?.data ?? []).map((item) => ({ signature: item.trans_id, status: item.status })),
    ];
  };

  // Offsets are independent: bounded parallel pages cut high-latency fallback
  // time without creating an unbounded burst of provider requests.
  for (let first = 0; first < maxPages && signatures.length < limit; first += SOLSCAN_CONCURRENCY) {
    const indexes = Array.from(
      { length: Math.min(SOLSCAN_CONCURRENCY, maxPages - first) },
      (_, offset) => first + offset,
    );
    const pages = await Promise.all(indexes.map(getPage));
    let endReached = false;
    for (const rows of pages) {
      for (const row of rows) {
        if (!row.signature || row.status === "Fail" || seen.has(row.signature)) continue;
        seen.add(row.signature);
        signatures.push(row.signature);
        if (signatures.length >= limit) break;
      }
      if (rows.length < pageSize) endReached = true;
      if (signatures.length >= limit || endReached) break;
    }
    if (endReached) break;
  }
  return signatures;
}

async function fetchParsedTransactions(signatures: string[]): Promise<ParsedHeliusTx[]> {
  if (signatures.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < signatures.length; i += 100) chunks.push(signatures.slice(i, i + 100));
  const responses = await mapConcurrent(chunks, PARSE_CONCURRENCY, async (chunk) => {
    try {
      const parsed = await parseTransactions<ParsedHeliusTx[]>(chunk);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  return responses.flat();
}

function isUsableTrade(trade: RawTrade): boolean {
  return !!trade.signature && !!trade.trader && trade.amountSol > 0 && trade.amountTokens > 0 && Number.isFinite(trade.timestamp) && (trade.type === "buy" || trade.type === "sell");
}

function scoreTrade(trade: RawTrade): number {
  let score = 0;
  if (trade.trader) score += 2;
  if (trade.amountSol > 0) score += 2;
  if (trade.amountTokens > 0) score += 2;
  if (trade.source) score += 1;
  if (typeof trade.fee === "number") score += 1;
  return score;
}

function mergeTrades(...groups: RawTrade[][]): RawTrade[] {
  const bySignature = new Map<string, RawTrade>();

  for (const group of groups) {
    for (const trade of group) {
      if (!isUsableTrade(trade)) continue;
      const existing = bySignature.get(trade.signature);
      if (!existing || scoreTrade(trade) >= scoreTrade(existing)) {
        bySignature.set(trade.signature, trade);
      }
    }
  }

  return [...bySignature.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export async function fetchMergedTradesForMint(
  mint: string,
  maxTrades: number = 1000,
  onProgress?: (info: { fetched: number; page: number }) => void
): Promise<RawTrade[]> {
  let heliusTxs: EnrichedTxInput = [];
  let solscanTxs: ParsedHeliusTx[] = [];
  let heliusError: Error | null = null;
  let solscanError: Error | null = null;

  try {
    heliusTxs = await fetchEnrichedTxsForMint(mint, maxTrades);
    onProgress?.({
      fetched: Math.min(maxTrades, heliusTxs.length),
      page: Math.max(1, Math.ceil(heliusTxs.length / 100)),
    });
  } catch (error) {
    heliusError = error as Error;
  }

  const heliusTrades = txsToTrades(heliusTxs, mint);
  if (heliusTrades.length >= HELIUS_FAST_ENOUGH_TRADES) {
    const fastTrades = mergeTrades(heliusTrades);
    console.log(
      `[fetchMergedTradesForMint] mint=${mint.slice(0, 8)}... helius=${heliusTxs.length} solscan=skipped merged=${fastTrades.length}`
    );
    return fastTrades.slice(0, maxTrades);
  }

  try {
    const existingSignatures = new Set(heliusTxs.map((tx) => tx.signature));
    const solscanSignatures = await fetchSolscanSignaturesForMint(mint, maxTrades);
    const missingSignatures = solscanSignatures.filter((signature) => !existingSignatures.has(signature));

    if (missingSignatures.length > 0) {
      solscanTxs = await fetchParsedTransactions(missingSignatures.slice(0, maxTrades));
      onProgress?.({
        fetched: Math.min(maxTrades, heliusTxs.length + solscanTxs.length),
        page: Math.max(1, Math.ceil((heliusTxs.length + solscanTxs.length) / 100)),
      });
    }
  } catch (error) {
    solscanError = error as Error;
  }

  const merged = mergeTrades(
    heliusTrades,
    txsToTrades(solscanTxs as EnrichedTxInput, mint)
  );

  console.log(
    `[fetchMergedTradesForMint] mint=${mint.slice(0, 8)}... helius=${heliusTxs.length} solscan=${solscanTxs.length} merged=${merged.length}`
  );

  if (merged.length > 0) return merged.slice(0, maxTrades);
  if (heliusError) throw heliusError;
  if (solscanError) throw solscanError;
  return [];
}
