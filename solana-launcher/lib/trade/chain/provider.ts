/**
 * Blockchain data providers.
 *
 * Invariants:
 * - unknown data never becomes a safe/zero fact;
 * - holder concentration is owner-level when a full token-account scan is available;
 * - early-buyer/sniper analytics are anchored to oldest-first chain history;
 * - Pump reserves are converted with explicit mint decimals, never magnitude heuristics;
 * - expensive enrichments are bounded, cached and carry provenance/coverage.
 */
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import type { ChainEvent, ClusterInfo, DevBehavior, HolderPoint, SafetyFacts } from "./full";
import type { TemporalSignalSnapshot } from "./quality-v3";
import type {
  ChainEvidenceCoverage,
  ChainQualityAnalytics,
  ChainQualityAnalyticsV3,
  ChainQualityInput,
  CreatorHistory,
  EvidenceStatus,
  FundingEdge,
  FundingGroup,
  MarketContext,
  PumpContext,
  TradeEvidenceStatus,
  WalletHistoryStats,
  WalletTokenHistory,
} from "./quality";
import {
  fetchEnrichedTxsForMintWithMeta,
  getWalletFirstSeen,
  txsToTrades,
  USDC_MINT,
  WRAPPED_SOL_MINT,
  type HeliusEnrichedTx,
  type RawTrade,
} from "../helius";
import { parseTransactions } from "../dev-helpers";
import {
  getDevTokensByCreator,
  getDevWallet,
  getPersistedCreatorForMint,
  getTokenTrades,
  getWalletStatsBatch,
  getWalletTokensBatch,
  listChainQualitySnapshots,
  listChainTemporalSnapshots,
  listChainWalletClusters,
  persistChainQualitySnapshot,
  persistChainTemporalSnapshot,
  upsertChainWalletClusters,
  persistTokenTrades,
} from "../db";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const DEFAULT_PUBKEY = "11111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMP_BONDING_CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96] as const;
const PUMP_POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188] as const;
const CACHE_TTL_MS = 60_000;
const WALLET_AGE_TTL_MS = 30 * 60_000;
const FUNDING_TTL_MS = 30 * 60_000;
const MAX_PROVIDER_CACHE_ENTRIES = (() => {
  const value = Number(process.env.CHAIN_PROVIDER_CACHE_MAX_ENTRIES || 5_000);
  return Number.isFinite(value) && value >= 100 ? Math.floor(value) : 5_000;
})();
const FUNDING_MIN_LAMPORTS = (() => {
  const value = Number(process.env.CHAIN_FUNDING_MIN_LAMPORTS || 100_000);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 100_000;
})();
const RPC_BATCH_SIZE = (() => {
  const value = Number(process.env.CHAIN_RPC_BATCH_SIZE || 20);
  return Number.isFinite(value) && value >= 1 ? Math.min(50, Math.floor(value)) : 20;
})();
const FALLBACK_CONCURRENCY = (() => {
  const value = Number(process.env.CHAIN_FALLBACK_CONCURRENCY || 6);
  return Number.isFinite(value) && value >= 1 ? Math.min(12, Math.floor(value)) : 6;
})();
const RPC_BATCH_CONCURRENCY = (() => {
  const value = Number(process.env.CHAIN_RPC_BATCH_CONCURRENCY || 2);
  return Number.isFinite(value) && value >= 1 ? Math.min(4, Math.floor(value)) : 2;
})();
const PARSE_TX_CONCURRENCY = (() => {
  const value = Number(process.env.CHAIN_PARSE_TX_CONCURRENCY || 3);
  return Number.isFinite(value) && value >= 1 ? Math.min(6, Math.floor(value)) : 3;
})();

export type MintInfo = Pick<SafetyFacts, "mintAuthority" | "freezeAuthority" | "upgradeable"> & {
  supply: number;
  /** Exact raw integer supply, used for concentration math without another RPC call. */
  rawSupply: string;
  decimals: number;
  tokenProgram: string | null;
  /** null means checked and absent; undefined is reserved for unavailable mint info. */
  permanentDelegate: string | null;
  transferHookProgramId: string | null;
  defaultAccountState: string | null;
  nonTransferable: boolean;
  /** 0 means checked and no transfer-fee extension. */
  transferFeePct: number | null;
};

export type LargestAccount = {
  address: string;
  tokenAccount?: string;
  tokenAccounts?: string[];
  amount?: number;
  pct: number;
  ownerResolved?: boolean;
  source?: "program_accounts" | "largest_accounts" | "fixture";
  holderSetComplete?: boolean;
  /** Exact owner count when getProgramAccounts owner aggregation succeeds. */
  totalHolderCount?: number | null;
};

export type ChainQualitySupplement = Pick<
  ChainQualityInput,
  | "trades"
  | "walletStats"
  | "walletTokenHistory"
  | "creator"
  | "creatorHistory"
  | "fundingEdges"
  | "fundingCheckedWallets"
  | "fundingGroups"
  | "market"
  | "pump"
  | "history"
  | "evidence"
> & {
  temporalHistory: TemporalSignalSnapshot[];
  walletClusterHistory: Array<{ clusterId: string; observations: number; firstSeenAt: number | null; lastSeenAt: number | null; updatedAt?: number | null; wallets?: string[] }>;
};

export type ChainProvider = {
  getMintInfo(mint: string): Promise<MintInfo | null>;
  getLargestAccounts(mint: string, limit?: number): Promise<LargestAccount[]>;
  getHoldersSeries(mint: string, hours: number): Promise<HolderPoint[]>;
  getLiquidity(mint: string): Promise<{ liquidityUsd: number | null; reserveTokens: number | null; vol24Usd: number | null }>;
  getLpLock(mint: string): Promise<{ lockedPct: number | null; burnedPct: number | null; concentrationPct: number | null }>;
  simulateSell(mint: string): Promise<boolean | null>;
  getTransferTax(mint: string): Promise<number | null>;
  getDev(mint: string): Promise<DevBehavior | null>;
  getClusters(mint: string): Promise<ClusterInfo | null>;
  getEvents(mint: string): Promise<ChainEvent[]>;
  getQualitySupplement?(mint: string, largest: LargestAccount[]): Promise<ChainQualitySupplement>;
  recordQualitySnapshot?(mint: string, quality: ChainQualityAnalytics, observedAt: number): Promise<void>;
  recordTemporalSnapshot?(mint: string, quality: ChainQualityAnalyticsV3, observedAt: number): Promise<void>;
};

type ParsedMintAccount = {
  value: {
    owner?: string;
    data?: { parsed?: { info?: Record<string, unknown> } } | null;
  } | null;
};

type ProgramAccountRow = {
  pubkey: string;
  account?: { data?: [string, string] | string };
};

type CacheEntry<T> = { expiresAt: number; value: Promise<T> };
const holderCache = new Map<string, CacheEntry<LargestAccount[]>>();
const marketCache = new Map<string, CacheEntry<MarketContext | null>>();
const pumpCache = new Map<string, CacheEntry<PumpContext | null>>();
const walletAgeCache = new Map<string, CacheEntry<number | null>>();

type FundingLookup = { edge: FundingEdge | null; historyComplete: boolean; source: string };
const fundingCache = new Map<string, CacheEntry<FundingLookup>>();

function pruneCache<T>(map: Map<string, CacheEntry<T>>, now: number): void {
  // Hot-path misses should not scan thousands of entries. Individual expired keys are
  // removed on lookup; a full expiry sweep is only needed when the bounded cache fills.
  if (map.size < MAX_PROVIDER_CACHE_ENTRIES) return;
  for (const [entryKey, entry] of map) {
    if (entry.expiresAt <= now) map.delete(entryKey);
  }
  while (map.size >= MAX_PROVIDER_CACHE_ENTRIES) {
    const oldestKey = map.keys().next().value as string | undefined;
    if (!oldestKey) break;
    map.delete(oldestKey);
  }
}

function memoTtl<T>(map: Map<string, CacheEntry<T>>, key: string, ttlMs: number, factory: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const cached = map.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) map.delete(key);
  pruneCache(map, now);
  const value = factory().catch((error) => {
    map.delete(key);
    throw error;
  });
  map.set(key, { expiresAt: now + ttlMs, value });
  return value;
}

function setResolvedCache<T>(map: Map<string, CacheEntry<T>>, key: string, ttlMs: number, value: T): void {
  const now = Date.now();
  pruneCache(map, now);
  map.set(key, { expiresAt: now + ttlMs, value: Promise.resolve(value) });
}

function nestedString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const row of value) {
      const hit = nestedString(row, key);
      if (hit) return hit;
    }
    return null;
  }
  const rec = value as Record<string, unknown>;
  if (key in rec && typeof rec[key] === "string" && rec[key]) return rec[key] as string;
  for (const child of Object.values(rec)) {
    const hit = nestedString(child, key);
    if (hit) return hit;
  }
  return null;
}

function extensionState(extensions: unknown, name: string): Record<string, unknown> | null {
  if (!Array.isArray(extensions)) return null;
  const row = extensions.find((item) => item && typeof item === "object" && String((item as Record<string, unknown>).extension || "") === name);
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  const state = record.state;
  return state && typeof state === "object" && !Array.isArray(state) ? state as Record<string, unknown> : record;
}

function numberField(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function transferFeeBpsForEpoch(state: Record<string, unknown> | null, currentEpoch: number | null): number | null {
  if (!state) return 0;
  const older = state.olderTransferFee && typeof state.olderTransferFee === "object" ? state.olderTransferFee as Record<string, unknown> : null;
  const newer = state.newerTransferFee && typeof state.newerTransferFee === "object" ? state.newerTransferFee as Record<string, unknown> : null;
  if (!older && !newer) {
    const direct = numberField(state, "transferFeeBasisPoints");
    return direct;
  }
  if (currentEpoch == null) return null;
  const newerEpoch = numberField(newer, "epoch");
  const selected = newer && newerEpoch != null && currentEpoch >= newerEpoch ? newer : older ?? newer;
  return numberField(selected, "transferFeeBasisPoints");
}

function readU64LEBigInt(bytes: Uint8Array, offset: number): bigint {
  if (bytes.length < offset + 8) return 0n;
  let value = 0n;
  for (let i = 0; i < 8; i++) value |= BigInt(bytes[offset + i]) << BigInt(8 * i);
  return value;
}

function ratioPct(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n || numerator <= 0n) return 0;
  const scale = 1_000_000_000n;
  return Number((numerator * 100n * scale) / denominator) / Number(scale);
}

function readI128LE(bytes: Uint8Array, offset: number): bigint | null {
  if (offset < 0 || offset + 16 > bytes.length) return null;
  let value = 0n;
  for (let i = 15; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i]);
  const signBit = 1n << 127n;
  return (value & signBit) !== 0n ? value - (1n << 128n) : value;
}

function bigintToUiAmount(raw: bigint, decimals: number): number {
  const scale = 10n ** BigInt(Math.max(0, decimals));
  const whole = raw / scale;
  const remainder = raw % scale;
  // Convert the bounded whole/fraction components separately; never coerce the raw i128
  // directly to Number before applying token decimals.
  return Number(whole) + Number(remainder) / Number(scale);
}

function pumpSwapVirtualQuoteRaw(account: { owner?: string; data?: [string, string] | string } | null): bigint | null {
  if (!account || account.owner !== PUMP_AMM_PROGRAM) return null;
  const raw = Array.isArray(account.data) ? account.data[0] : account.data;
  if (typeof raw !== "string") return null;
  const bytes = Uint8Array.from(Buffer.from(raw, "base64"));
  if (bytes.length < 8 || !PUMP_POOL_DISCRIMINATOR.every((value, index) => bytes[index] === value)) return null;
  // Pool.virtual_quote_reserves is not available in shorter/legacy account layouts.
  // Missing bytes are unknown, not a semantic zero.
  if (bytes.length < 261) return null;
  return readI128LE(bytes, 245);
}

type DecodedPumpCurve = {
  virtualTokenRaw: bigint;
  virtualQuoteRaw: bigint;
  realTokenRaw: bigint;
  realQuoteRaw: bigint;
  totalSupplyRaw: bigint;
  complete: boolean;
  creator: string | null;
  quoteMint: string;
};

function readPubkey(bytes: Uint8Array, offset: number): string | null {
  if (offset < 0 || offset + 32 > bytes.length) return null;
  const slice = bytes.slice(offset, offset + 32);
  if (slice.every((value) => value === 0)) return DEFAULT_PUBKEY;
  return bs58.encode(slice);
}

function decodePumpBondingCurve(account: { owner?: string; data?: [string, string] | string } | null): DecodedPumpCurve | null {
  if (!account || account.owner !== PUMP_PROGRAM) return null;
  const raw = Array.isArray(account.data) ? account.data[0] : account.data;
  if (typeof raw !== "string") return null;
  const bytes = Uint8Array.from(Buffer.from(raw, "base64"));
  if (bytes.length < 49 || !PUMP_BONDING_CURVE_DISCRIMINATOR.every((value, index) => bytes[index] === value)) return null;
  const creator = bytes.length >= 81 ? readPubkey(bytes, 49) : null;
  const quoteMint = bytes.length >= 115 ? readPubkey(bytes, 83) ?? DEFAULT_PUBKEY : DEFAULT_PUBKEY;
  return {
    virtualTokenRaw: readU64LEBigInt(bytes, 8),
    virtualQuoteRaw: readU64LEBigInt(bytes, 16),
    realTokenRaw: readU64LEBigInt(bytes, 24),
    realQuoteRaw: readU64LEBigInt(bytes, 32),
    totalSupplyRaw: readU64LEBigInt(bytes, 40),
    complete: bytes[48] === 1,
    creator: creator && creator !== DEFAULT_PUBKEY ? creator : null,
    quoteMint,
  };
}

function derivePumpAddresses(mint: string, tokenProgram: string | null, quoteMint: string): {
  bondingCurve: string;
  associatedBondingCurve: string | null;
  pumpSwapPool: string;
} | null {
  try {
    const mintKey = new PublicKey(mint);
    const pumpProgram = new PublicKey(PUMP_PROGRAM);
    const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mintKey.toBuffer()], pumpProgram);
    let associatedBondingCurve: string | null = null;
    if (tokenProgram) {
      const [ata] = PublicKey.findProgramAddressSync(
        [curve.toBuffer(), new PublicKey(tokenProgram).toBuffer(), mintKey.toBuffer()],
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
      );
      associatedBondingCurve = ata.toBase58();
    }
    // Canonical Pump migration uses a pool-authority PDA owned by the Pump program.
    // The resulting pool PDA itself is derived under the PumpSwap AMM program.
    const [poolAuthority] = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mintKey.toBuffer()], pumpProgram);
    const ammProgram = new PublicKey(PUMP_AMM_PROGRAM);
    const quoteKey = new PublicKey(quoteMint === DEFAULT_PUBKEY ? WRAPPED_SOL_MINT : quoteMint);
    const [pool] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), Buffer.from([0, 0]), poolAuthority.toBuffer(), mintKey.toBuffer(), quoteKey.toBuffer()],
      ammProgram,
    );
    return { bondingCurve: curve.toBase58(), associatedBondingCurve, pumpSwapPool: pool.toBase58() };
  } catch {
    return null;
  }
}



function accountBytes(row: ProgramAccountRow): Uint8Array | null {
  const data = row.account?.data;
  const encoded = Array.isArray(data) ? data[0] : typeof data === "string" ? data : null;
  if (!encoded) return null;
  try {
    return Uint8Array.from(Buffer.from(encoded, "base64"));
  } catch {
    return null;
  }
}

function evidenceStatus(source: string, available: boolean, complete: boolean, fetchedAt: number, coveragePct: number | null, note?: string): EvidenceStatus {
  return { source, available, complete, fetchedAt, coveragePct, ...(note ? { note } : {}) };
}

function tradeEvidence(
  source: string,
  available: boolean,
  complete: boolean,
  fetchedAt: number,
  coveragePct: number | null,
  extras: Partial<Pick<TradeEvidenceStatus, "launchSlot" | "launchBlockTime" | "earlyWindowMaxSlot" | "oldestRecentTimestamp" | "recentCoverageSec">> = {},
  note?: string,
): TradeEvidenceStatus {
  return {
    source,
    available,
    complete,
    fetchedAt,
    coveragePct,
    launchSlot: extras.launchSlot ?? null,
    launchBlockTime: extras.launchBlockTime ?? null,
    earlyWindowMaxSlot: extras.earlyWindowMaxSlot ?? null,
    oldestRecentTimestamp: extras.oldestRecentTimestamp ?? null,
    recentCoverageSec: extras.recentCoverageSec ?? null,
    ...(note ? { note } : {}),
  };
}

/** Deterministic Solana JSON-RPC provider. */
export class RpcChainProvider implements Partial<ChainProvider> {
  private readonly mintCache = new Map<string, Promise<MintInfo | null>>();

  constructor(protected readonly url: string, protected readonly timeoutMs = 8_000) {}

  protected async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`rpc HTTP ${response.status}`);
    const json = (await response.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? "rpc error");
    return json.result as T;
  }

  /** JSON-RPC batch helper. One HTTP round-trip can resolve many independent wallet lookups. */
  protected async rpcBatchSettled<T>(requests: Array<{ method: string; params: unknown[] }>): Promise<Array<{ ok: true; result: T } | { ok: false; error: string }>> {
    if (!requests.length) return [];
    const body = requests.map((request, index) => ({ jsonrpc: "2.0", id: index + 1, method: request.method, params: request.params }));
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`rpc batch HTTP ${response.status}`);
    const json = await response.json() as Array<{ id?: number; result?: T; error?: { message?: string } }>;
    if (!Array.isArray(json)) throw new Error("rpc batch response is not an array");
    const byId = new Map(json.map((row) => [Number(row.id), row]));
    return requests.map((_, index) => {
      const row = byId.get(index + 1);
      if (!row || row.error) return { ok: false as const, error: row?.error?.message || "missing rpc batch response" };
      return { ok: true as const, result: row.result as T };
    });
  }

  async getMintInfo(mint: string): Promise<MintInfo | null> {
    const cached = this.mintCache.get(mint);
    if (cached) return cached;
    const task = this.loadMintInfo(mint).catch((error) => {
      this.mintCache.delete(mint);
      throw error;
    });
    this.mintCache.set(mint, task);
    return task;
  }

  private async loadMintInfo(mint: string): Promise<MintInfo | null> {
    // Account extensions and token supply are independent; fetch them in one latency wave.
    const [account, supplyRaw] = await Promise.all([
      this.rpc<ParsedMintAccount>("getAccountInfo", [mint, { encoding: "jsonParsed" }]),
      this.rpc<{ value?: { amount?: string; decimals?: number } }>("getTokenSupply", [mint]),
    ]);
    const info = account?.value?.data?.parsed?.info as Record<string, unknown> | undefined;
    if (!info) return null;
    const decimals = Number(supplyRaw?.value?.decimals ?? 0);
    const rawSupply = String(supplyRaw?.value?.amount ?? "0");
    const supply = Number(rawSupply) / 10 ** decimals;
    const extensions = info.extensions;
    const transferFeeState = extensionState(extensions, "transferFeeConfig");
    const permanentDelegateState = extensionState(extensions, "permanentDelegate");
    const transferHookState = extensionState(extensions, "transferHook");
    const defaultState = extensionState(extensions, "defaultAccountState");
    const extensionNames = Array.isArray(extensions)
      ? extensions.map((row) => row && typeof row === "object" ? String((row as Record<string, unknown>).extension || "") : "")
      : [];
    let currentEpoch: number | null = null;
    if (transferFeeState) {
      try {
        const epochInfo = await this.rpc<{ epoch?: number }>("getEpochInfo", []);
        currentEpoch = Number.isFinite(Number(epochInfo?.epoch)) ? Number(epochInfo.epoch) : null;
      } catch {
        currentEpoch = null;
      }
    }
    const transferFeeBps = transferFeeBpsForEpoch(transferFeeState, currentEpoch);
    const defaultAccountState = nestedString(defaultState, "state") ?? nestedString(defaultState, "accountState");
    return {
      mintAuthority: info.mintAuthority == null ? null : String(info.mintAuthority),
      freezeAuthority: info.freezeAuthority == null ? null : String(info.freezeAuthority),
      upgradeable: null,
      supply,
      rawSupply,
      decimals,
      tokenProgram: account.value?.owner ? String(account.value.owner) : null,
      permanentDelegate: permanentDelegateState ? nestedString(permanentDelegateState, "delegate") : null,
      transferHookProgramId: transferHookState ? nestedString(transferHookState, "programId") : null,
      defaultAccountState,
      nonTransferable: extensionNames.includes("nonTransferable"),
      transferFeePct: transferFeeBps == null ? null : transferFeeBps / 100,
    };
  }

  private async scanOwners(mint: string, limit: number): Promise<LargestAccount[] | null> {
    const mintInfo = await this.getMintInfo(mint);
    const tokenProgram = mintInfo?.tokenProgram;
    if (!mintInfo || !tokenProgram || ![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(tokenProgram)) return null;
    const rows = await this.rpc<ProgramAccountRow[]>("getProgramAccounts", [tokenProgram, {
      encoding: "base64",
      // memcmp runs against the full account before dataSlice. Returning only owner+amount
      // cuts holder-scan payload from 72 to 40 bytes per token account.
      dataSlice: { offset: 32, length: 40 },
      filters: [{ memcmp: { offset: 0, bytes: mint } }],
    }]);
    const totalRaw = BigInt(mintInfo.rawSupply || "0");
    const owners = new Map<string, { amount: bigint; tokenAccounts: string[] }>();
    for (const row of rows || []) {
      const bytes = accountBytes(row);
      if (!bytes || bytes.length < 40) continue;
      const owner = bs58.encode(bytes.slice(0, 32));
      const amount = readU64LEBigInt(bytes, 32);
      if (amount <= 0n) continue;
      const current = owners.get(owner) || { amount: 0n, tokenAccounts: [] };
      current.amount += amount;
      current.tokenAccounts.push(row.pubkey);
      owners.set(owner, current);
    }
    return [...owners.entries()]
      .map(([address, row]) => ({
        address,
        tokenAccount: row.tokenAccounts[0],
        tokenAccounts: row.tokenAccounts,
        amount: bigintToUiAmount(row.amount, mintInfo.decimals),
        pct: ratioPct(row.amount, totalRaw),
        ownerResolved: true,
        source: "program_accounts" as const,
        holderSetComplete: owners.size <= Math.max(1, limit),
        totalHolderCount: owners.size,
      }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, Math.max(1, limit));
  }

  private async largestFallback(mint: string, limit: number): Promise<LargestAccount[]> {
    const [res, mintInfo] = await Promise.all([
      this.rpc<{ value?: Array<{ address: string; amount: string }> }>("getTokenLargestAccounts", [mint]),
      this.getMintInfo(mint),
    ]);
    const rows = (res?.value ?? []).slice(0, Math.min(20, Math.max(1, limit)));
    const totalRaw = BigInt(mintInfo?.rawSupply || "0");
    const decimals = mintInfo?.decimals ?? 0;
    if (!rows.length) return [];
    let owners: Array<string | null> = rows.map(() => null);
    try {
      const accounts = await this.rpc<{ value?: Array<{ data?: { parsed?: { info?: { owner?: string } } } | null } | null> }>(
        "getMultipleAccounts",
        [rows.map((row) => row.address), { encoding: "jsonParsed" }],
      );
      owners = rows.map((_, index) => accounts?.value?.[index]?.data?.parsed?.info?.owner || null);
    } catch {
      // Fallback remains explicitly incomplete and unresolved where necessary.
    }
    const aggregated = new Map<string, LargestAccount>();
    rows.forEach((row, index) => {
      const rawAmount = BigInt(String(row.amount || "0"));
      const amount = bigintToUiAmount(rawAmount, decimals);
      const owner = owners[index] || row.address;
      const existing = aggregated.get(owner);
      const pct = ratioPct(rawAmount, totalRaw);
      if (existing) {
        existing.amount = (existing.amount || 0) + amount;
        existing.pct += pct;
        existing.tokenAccounts = [...(existing.tokenAccounts || []), row.address];
      } else {
        aggregated.set(owner, {
          address: owner,
          tokenAccount: row.address,
          tokenAccounts: [row.address],
          amount,
          pct,
          ownerResolved: Boolean(owners[index]),
          source: "largest_accounts",
          holderSetComplete: false,
          totalHolderCount: null,
        });
      }
    });
    return [...aggregated.values()].sort((a, b) => b.pct - a.pct).slice(0, limit);
  }

  async getLargestAccounts(mint: string, limit = 50): Promise<LargestAccount[]> {
    const key = `${this.url}|${mint}|${limit}`;
    return memoTtl(holderCache, key, CACHE_TTL_MS, async () => {
      try {
        const full = await this.scanOwners(mint, limit);
        if (full) return full;
      } catch {
        // getProgramAccounts can be disabled on some RPC plans; fallback is clearly marked incomplete.
      }
      return this.largestFallback(mint, limit);
    });
  }

  async getHoldersSeries(_mint: string, _hours: number): Promise<HolderPoint[]> { return []; }
  async getLiquidity(_mint: string): Promise<{ liquidityUsd: number | null; reserveTokens: number | null; vol24Usd: number | null }> {
    return { liquidityUsd: null, reserveTokens: null, vol24Usd: null };
  }
  async getLpLock(_mint: string): Promise<{ lockedPct: number | null; burnedPct: number | null; concentrationPct: number | null }> {
    return { lockedPct: null, burnedPct: null, concentrationPct: null };
  }
  async simulateSell(_mint: string): Promise<boolean | null> { return null; }
  async getTransferTax(mint: string): Promise<number | null> { return (await this.getMintInfo(mint))?.transferFeePct ?? null; }
  async getDev(_mint: string): Promise<DevBehavior | null> { return null; }
  async getClusters(_mint: string): Promise<ClusterInfo | null> { return null; }
  async getEvents(_mint: string): Promise<ChainEvent[]> { return []; }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

type SignatureRow = { signature: string; blockTime: number | null };
type ParsedRpcTransaction = {
  blockTime?: number | null;
  transaction?: { message?: { instructions?: Array<{ program?: string; parsed?: { type?: string; info?: Record<string, unknown> } }> } };
};
type HeliusHistoryResult<T> = { data?: T[]; paginationToken?: string | null };
type HeliusSignatureHistoryRow = { signature?: string; blockTime?: number | null; slot?: number };
type HeliusTransferRow = {
  signature?: string;
  blockTime?: number | null;
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: string | number;
  uiAmount?: string | number;
  decimals?: number;
};

type TradeLoadResult = {
  trades: RawTrade[];
  recentEvidence: TradeEvidenceStatus;
  launchEvidence: TradeEvidenceStatus;
};


function mergeTrades(...groups: RawTrade[][]): RawTrade[] {
  const map = new Map<string, RawTrade>();
  for (const group of groups) for (const trade of group) if (trade.signature) map.set(trade.signature, trade);
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Production enrichment provider. */
export class HybridChainProvider extends RpcChainProvider implements ChainProvider {
  override async getLiquidity(mint: string): Promise<{ liquidityUsd: number | null; reserveTokens: number | null; vol24Usd: number | null }> {
    const market = await this.getMarket(mint);
    return {
      liquidityUsd: market?.liquidityUsd ?? null,
      reserveTokens: market?.reserveTokens ?? null,
      vol24Usd: market?.volume24hUsd ?? null,
    };
  }

  private async getPump(mint: string): Promise<PumpContext | null> {
    return memoTtl(pumpCache, mint, CACHE_TTL_MS, async () => {
      const mintInfo = await this.getMintInfo(mint);
      if (!mintInfo) return null;

      // The frontend endpoint is metadata-only best effort. All security-sensitive curve
      // state (reserves, complete, creator, quote mint) is overridden by the on-chain
      // BondingCurve account whenever it can be decoded.
      let data: Record<string, unknown> = {};
      try {
        const response = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) data = await response.json() as Record<string, unknown>;
      } catch {
        data = {};
      }

      const num = (...keys: string[]): number | null => {
        for (const keyName of keys) {
          if (data[keyName] == null) continue;
          const n = Number(data[keyName]);
          if (Number.isFinite(n)) return n;
        }
        return null;
      };
      const str = (...keys: string[]): string | null => {
        for (const keyName of keys) if (typeof data[keyName] === "string" && data[keyName]) return String(data[keyName]);
        return null;
      };

      // Bonding-curve PDA is quote-independent, so WSOL is safe for the initial derivation.
      const initialAddresses = derivePumpAddresses(mint, mintInfo.tokenProgram, WRAPPED_SOL_MINT);
      let decoded: DecodedPumpCurve | null = null;
      if (initialAddresses?.bondingCurve) {
        try {
          const account = await this.rpc<{ value?: { owner?: string; data?: [string, string] | string } | null }>(
            "getAccountInfo",
            [initialAddresses.bondingCurve, { encoding: "base64" }],
          );
          decoded = decodePumpBondingCurve(account?.value ?? null);
        } catch {
          decoded = null;
        }
      }

      const apiQuoteMint = str("quote_mint", "quoteMint");
      const rawQuoteMint = decoded?.quoteMint ?? apiQuoteMint ?? DEFAULT_PUBKEY;
      const quoteIsNativeSol = rawQuoteMint === DEFAULT_PUBKEY || rawQuoteMint === WRAPPED_SOL_MINT;
      const quoteMint = quoteIsNativeSol ? WRAPPED_SOL_MINT : rawQuoteMint;
      let quoteDecimals: number | null = quoteIsNativeSol ? 9 : null;
      if (!quoteIsNativeSol) {
        try { quoteDecimals = (await this.getMintInfo(quoteMint))?.decimals ?? null; }
        catch { quoteDecimals = null; }
      }
      const addresses = derivePumpAddresses(mint, mintInfo.tokenProgram, quoteMint) ?? initialAddresses;

      // If neither chain state nor Pump metadata recognizes the mint, do not fabricate a
      // Pump context merely because a PDA can always be derived mathematically.
      if (!decoded && Object.keys(data).length === 0) return null;

      const toBaseUiNumber = (raw: number | null) => raw == null ? null : raw / 10 ** mintInfo.decimals;
      const toQuoteUiNumber = (raw: number | null) => raw == null || quoteDecimals == null ? null : raw / 10 ** quoteDecimals;
      const virtualToken = decoded ? bigintToUiAmount(decoded.virtualTokenRaw, mintInfo.decimals) : toBaseUiNumber(num("virtual_token_reserves"));
      const realToken = decoded ? bigintToUiAmount(decoded.realTokenRaw, mintInfo.decimals) : toBaseUiNumber(num("real_token_reserves"));
      const totalSupply = decoded ? bigintToUiAmount(decoded.totalSupplyRaw, mintInfo.decimals) : toBaseUiNumber(num("total_supply", "token_total_supply"));
      const virtualQuote = decoded && quoteDecimals != null
        ? bigintToUiAmount(decoded.virtualQuoteRaw, quoteDecimals)
        : toQuoteUiNumber(num("virtual_quote_reserves", "virtual_sol_reserves"));
      const realQuote = decoded && quoteDecimals != null
        ? bigintToUiAmount(decoded.realQuoteRaw, quoteDecimals)
        : toQuoteUiNumber(num("real_quote_reserves", "real_sol_reserves"));
      const complete = decoded?.complete ?? (typeof data.complete === "boolean" ? data.complete : null);
      const progressRaw = num("bonding_curve_progress", "bondingCurveProgress", "progress");
      const apiPumpSwapPool = str("pump_swap_pool", "pump_swap_pool_address", "pumpSwapPool");
      const derivedPool = addresses?.pumpSwapPool ?? null;
      const pumpSwapPool = complete === true ? (derivedPool || apiPumpSwapPool) : apiPumpSwapPool;
      const legacyRaydiumPool = str("raydium_pool", "raydiumPool");

      return {
        creator: decoded?.creator ?? str("creator", "dev_wallet"),
        complete,
        bondingCurve: addresses?.bondingCurve ?? str("bonding_curve", "bondingCurve"),
        associatedBondingCurve: addresses?.associatedBondingCurve ?? str("associated_bonding_curve", "associatedBondingCurve"),
        quoteMint,
        quoteDecimals,
        quoteSymbol: quoteIsNativeSol ? "SOL" : quoteMint === USDC_MINT ? "USDC" : str("quote_symbol", "quoteSymbol"),
        quoteIsNativeSol,
        virtualQuoteReserves: virtualQuote,
        virtualTokenReserves: virtualToken,
        realQuoteReserves: realQuote,
        realTokenReserves: realToken,
        totalSupply,
        bondingCurveProgressPct: progressRaw == null ? (complete === true ? 100 : null) : progressRaw <= 1 ? progressRaw * 100 : progressRaw,
        pumpSwapPool,
        createdAt: num("created_timestamp", "created_at", "createdAt"),
        source: decoded ? "rpc:pump-bonding-curve" : "pumpfun:frontend-api-fallback",
        virtualSolReserves: quoteIsNativeSol ? virtualQuote : null,
        realSolReserves: quoteIsNativeSol ? realQuote : null,
        raydiumPool: legacyRaydiumPool,
      };
    });
  }

  private async getPumpSwapVirtualQuote(pool: string, quoteMint: string | null): Promise<number | null> {
    try {
      const response = await this.rpc<{ value?: { owner?: string; data?: [string, string] | string } | null }>(
        "getAccountInfo",
        [pool, { encoding: "base64" }],
      );
      const raw = pumpSwapVirtualQuoteRaw(response?.value ?? null);
      if (raw == null) return null;
      let decimals = quoteMint === WRAPPED_SOL_MINT || quoteMint === DEFAULT_PUBKEY ? 9 : null;
      if (decimals == null && quoteMint) decimals = (await this.getMintInfo(quoteMint))?.decimals ?? null;
      if (decimals == null) return null;
      return bigintToUiAmount(raw, decimals);
    } catch {
      return null;
    }
  }

  private async getMarket(mint: string): Promise<MarketContext | null> {
    return memoTtl(marketCache, mint, CACHE_TTL_MS, async () => {
      try {
        const [pump, response] = await Promise.all([
          this.getPump(mint),
          fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: AbortSignal.timeout(5_000),
          }),
        ]);
        if (!response.ok) return null;
        const json = await response.json() as {
          pairs?: Array<{
            dexId?: string;
            pairAddress?: string;
            labels?: string[];
            priceNative?: string | number;
            priceUsd?: string | number;
            pairCreatedAt?: number;
            baseToken?: { address?: string; symbol?: string };
            quoteToken?: { address?: string; symbol?: string };
            liquidity?: { usd?: number; base?: number; quote?: number };
            volume?: { h24?: number };
          }>;
        };
        const pairs = (json.pairs || []).filter((pair) => pair.baseToken?.address === mint || pair.quoteToken?.address === mint);
        const canonicalAddress = pump?.pumpSwapPool || null;
        const exactCanonical = canonicalAddress ? pairs.find((pair) => pair.pairAddress === canonicalAddress) : null;
        const pair = exactCanonical || [...pairs].sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
        if (!pair) return null;
        const tokenIsBase = pair.baseToken?.address === mint;
        const tokenReserve = tokenIsBase ? Number(pair.liquidity?.base ?? NaN) : Number(pair.liquidity?.quote ?? NaN);
        const quoteReserve = tokenIsBase ? Number(pair.liquidity?.quote ?? NaN) : Number(pair.liquidity?.base ?? NaN);
        const pairBasePriceUsd = Number(pair.priceUsd ?? NaN);
        const priceNative = Number(pair.priceNative ?? NaN); // quote tokens per base token
        const tokenPriceUsd = tokenIsBase
          ? pairBasePriceUsd
          : Number.isFinite(pairBasePriceUsd) && Number.isFinite(priceNative) && priceNative > 0 ? pairBasePriceUsd / priceNative : NaN;
        const quotePriceUsd = tokenIsBase
          ? Number.isFinite(pairBasePriceUsd) && Number.isFinite(priceNative) && priceNative > 0 ? pairBasePriceUsd / priceNative : NaN
          : pairBasePriceUsd;
        const labels = (pair.labels || []).map((label) => label.toLowerCase());
        const dex = String(pair.dexId || "").toLowerCase();
        const isCanonicalMigrationPool = Boolean(canonicalAddress && pair.pairAddress === canonicalAddress);
        const quoteMintAddress = tokenIsBase ? pair.quoteToken?.address || null : pair.baseToken?.address || null;
        const virtualQuoteReserves = isCanonicalMigrationPool && pair.pairAddress
          ? await this.getPumpSwapVirtualQuote(pair.pairAddress, quoteMintAddress)
          : null;
        let ammModel: MarketContext["ammModel"] = "unknown";
        if (isCanonicalMigrationPool && (dex.includes("pump") || pump?.complete)) ammModel = "constant_product";
        else if (labels.some((label) => label.includes("clmm"))) ammModel = "clmm";
        else if (labels.some((label) => label.includes("dlmm")) || dex.includes("meteora")) ammModel = "dlmm";
        else if (labels.some((label) => label.includes("cpmm"))) ammModel = "constant_product";
        return {
          dexId: pair.dexId || null,
          pairAddress: pair.pairAddress || null,
          baseTokenAddress: pair.baseToken?.address || null,
          quoteTokenAddress: quoteMintAddress,
          quoteSymbol: tokenIsBase ? pair.quoteToken?.symbol || null : pair.baseToken?.symbol || null,
          priceUsd: Number.isFinite(tokenPriceUsd) ? tokenPriceUsd : null,
          quotePriceUsd: Number.isFinite(quotePriceUsd) ? quotePriceUsd : null,
          liquidityUsd: Number.isFinite(Number(pair.liquidity?.usd)) ? Number(pair.liquidity?.usd) : null,
          reserveTokens: Number.isFinite(tokenReserve) && tokenReserve > 0 ? tokenReserve : null,
          reserveQuote: Number.isFinite(quoteReserve) && quoteReserve > 0 ? quoteReserve : null,
          virtualQuoteReserves,
          volume24hUsd: Number.isFinite(Number(pair.volume?.h24)) ? Number(pair.volume?.h24) : null,
          pairCreatedAt: Number.isFinite(Number(pair.pairCreatedAt)) ? Number(pair.pairCreatedAt) : null,
          ammModel,
          isCanonicalMigrationPool,
          // Pump/PumpSwap fees are dynamic and materially affect net exit proceeds.
          // Reserves alone are enough for gross curve-impact diagnostics, but not for a
          // decision-grade net exit simulation. Keep the scored model disabled until
          // the active fee schedule is fetched and verified for this pool.
          exitModelVerified: false,
        };
      } catch {
        return null;
      }
    });
  }

  private async launchTrades(mint: string, now: number): Promise<{ trades: RawTrade[]; evidence: TradeEvidenceStatus }> {
    try {
      const history = await this.rpc<HeliusHistoryResult<HeliusSignatureHistoryRow>>("getTransactionsForAddress", [
        mint,
        { transactionDetails: "signatures", sortOrder: "asc", limit: 1000, filters: { status: "succeeded" } },
      ]);
      const rows = (history?.data || []).filter((row) => row.signature && Number.isFinite(Number(row.slot)));
      if (!rows.length) {
        return { trades: [], evidence: tradeEvidence("helius:getTransactionsForAddress+parseTransactions", true, true, now, 100, {}, "No successful mint-address history returned.") };
      }
      const launchSlot = Number(rows[0].slot);
      const launchBlockTime = rows[0].blockTime ?? null;
      const wanted = rows.filter((row) => Number(row.slot) <= launchSlot + 100);
      const signatures = wanted.map((row) => row.signature as string);
      const chunks: string[][] = [];
      for (let i = 0; i < signatures.length; i += 100) chunks.push(signatures.slice(i, i + 100));
      const parsedChunks = await mapLimit(chunks, PARSE_TX_CONCURRENCY, async (chunk) => {
        try {
          const out = await parseTransactions<HeliusEnrichedTx[]>(chunk);
          return Array.isArray(out) ? out : [];
        } catch {
          return [];
        }
      });
      const parsed = parsedChunks.flat();
      const parsedSet = new Set(parsed.map((tx) => tx.signature));
      const parsedCoverage = signatures.length ? (signatures.filter((signature) => parsedSet.has(signature)).length / signatures.length) * 100 : 100;
      const maxFetchedSlot = wanted.length ? Math.max(...wanted.map((row) => Number(row.slot))) : launchSlot;
      const spansHundredSlots = maxFetchedSlot >= launchSlot + 99;
      const addressHistoryExhausted = !history.paginationToken;
      const complete = parsedCoverage >= 99 && (spansHundredSlots || addressHistoryExhausted);
      return {
        trades: txsToTrades(parsed, mint),
        evidence: tradeEvidence(
          "helius:getTransactionsForAddress+parseTransactions",
          true,
          complete,
          now,
          parsedCoverage,
          { launchSlot, launchBlockTime, earlyWindowMaxSlot: maxFetchedSlot },
          complete ? "Oldest-first launch window parsed." : "Launch anchor is authoritative, but the first 100 slots are not fully covered.",
        ),
      };
    } catch {
      return {
        trades: [],
        evidence: tradeEvidence("helius:getTransactionsForAddress+parseTransactions", false, false, now, 0, {}, "Oldest-first launch history unavailable."),
      };
    }
  }

  private async getTrades(mint: string): Promise<TradeLoadResult> {
    const now = Date.now();
    const [launch, recentResult] = await Promise.all([
      this.launchTrades(mint, now),
      fetchEnrichedTxsForMintWithMeta(mint, 600).catch(() => null),
    ]);
    let recentTrades: RawTrade[] = [];
    let recentEvidence: TradeEvidenceStatus;
    if (recentResult) {
      recentTrades = txsToTrades(recentResult.transactions, mint);
      const oldest = recentResult.oldestTimestamp;
      const coverageSec = oldest == null ? null : Math.max(0, now / 1000 - oldest);
      recentEvidence = tradeEvidence(
        "helius:enhanced-transactions",
        true,
        recentResult.exhausted,
        now,
        recentResult.exhausted ? 100 : null,
        { oldestRecentTimestamp: oldest, recentCoverageSec: coverageSec },
        recentResult.truncated ? "Recent history hit the bounded 600-transaction cap." : "Recent history exhausted for the mint address.",
      );
    } else {
      recentEvidence = tradeEvidence("helius:enhanced-transactions", false, false, now, 0, {}, "Enhanced recent history unavailable.");
    }

    let trades = mergeTrades(launch.trades, recentTrades);
    if (trades.length) {
      persistTokenTrades(mint, trades.map((trade) => ({
        signature: trade.signature,
        timestamp: trade.timestamp,
        trader: trade.trader,
        type: trade.type,
        amountSol: trade.amountSol,
        amountTokens: trade.amountTokens,
        priceSol: trade.priceSol,
        quoteMint: trade.quoteMint,
        quoteAmount: trade.quoteAmount,
        quoteDecimals: trade.quoteDecimals,
        quoteUsdValue: trade.quoteUsdValue,
        slot: trade.slot,
        fee: trade.fee,
        jitoTipLamports: trade.jitoTipLamports,
        source: trade.source,
      })));
    } else {
      const stored = getTokenTrades(mint, 10_000).map((row) => ({
        signature: row.signature,
        timestamp: row.timestamp,
        slot: row.slot ?? undefined,
        trader: row.trader,
        type: row.type as RawTrade["type"],
        amountSol: row.amountSol,
        amountTokens: row.amountTokens,
        priceSol: row.priceSol,
        quoteMint: row.quoteMint ?? undefined,
        quoteAmount: row.quoteAmount ?? undefined,
        quoteDecimals: row.quoteDecimals ?? undefined,
        quoteUsdValue: row.quoteUsdValue ?? undefined,
        fee: row.fee ?? undefined,
        jitoTipLamports: row.jitoTipLamports ?? undefined,
        source: row.source || undefined,
      }));
      trades = stored;
    }
    return { trades, recentEvidence, launchEvidence: launch.evidence };
  }

  private async walletFirstSeenBatch(addresses: string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    const unresolved: string[] = [];
    const now = Date.now();
    for (const address of addresses) {
      const cached = walletAgeCache.get(address);
      if (cached && cached.expiresAt > now) {
        try { out.set(address, await cached.value); } catch { unresolved.push(address); }
      } else {
        if (cached) walletAgeCache.delete(address);
        unresolved.push(address);
      }
    }

    const fallback: string[] = [];
    const chunks: string[][] = [];
    for (let i = 0; i < unresolved.length; i += RPC_BATCH_SIZE) chunks.push(unresolved.slice(i, i + RPC_BATCH_SIZE));
    await mapLimit(chunks, RPC_BATCH_CONCURRENCY, async (chunk) => {
      try {
        const rows = await this.rpcBatchSettled<HeliusHistoryResult<HeliusSignatureHistoryRow>>(
          chunk.map((address) => ({
            method: "getTransactionsForAddress",
            params: [address, { transactionDetails: "signatures", sortOrder: "asc", limit: 1 }],
          })),
        );
        rows.forEach((row, index) => {
          const address = chunk[index];
          if (!row.ok) { fallback.push(address); return; }
          const first = row.result?.data?.[0];
          const blockTimeNum = first ? Number(first.blockTime) : NaN;
          if (first?.signature && (!Number.isFinite(blockTimeNum) || blockTimeNum <= 0)) {
            // Фикс V3.4: null/0 blockTime не является доказанным временем первого появления.
            // Не кэшируем ложный epoch и разрешаем enriched-history fallback.
            fallback.push(address);
            return;
          }
          const value = first && Number.isFinite(blockTimeNum) && blockTimeNum > 0 ? blockTimeNum : null;
          out.set(address, value);
          setResolvedCache(walletAgeCache, address, WALLET_AGE_TTL_MS, value);
        });
      } catch {
        fallback.push(...chunk);
      }
      return null;
    });

    const fallbackValues = await mapLimit([...new Set(fallback)], FALLBACK_CONCURRENCY, async (address) => {
      try { return await getWalletFirstSeen(address); } catch { return null; }
    });
    [...new Set(fallback)].forEach((address, index) => {
      const value = fallbackValues[index] ?? null;
      out.set(address, value);
      setResolvedCache(walletAgeCache, address, WALLET_AGE_TTL_MS, value);
    });
    return out;
  }

  private async walletStats(addresses: string[]): Promise<{ rows: WalletHistoryStats[]; evidence: EvidenceStatus }> {
    const cached = getWalletStatsBatch(addresses);
    const needRemote = addresses.filter((address) => cached.get(address)?.firstSeen == null);
    const remoteFirstSeen = needRemote.length ? await this.walletFirstSeenBatch(needRemote) : new Map<string, number | null>();
    const rows = addresses.map((address) => {
      const row = cached.get(address);
      return {
        address,
        firstSeen: row?.firstSeen ?? remoteFirstSeen.get(address) ?? null,
        totalVolumeSol: row?.totalVolumeSol ?? 0,
        totalPnlSol: row?.totalPnlSol ?? 0,
        tokensTraded: row?.tokensTraded ?? 0,
        totalBuys: row?.totalBuys ?? 0,
        totalSells: row?.totalSells ?? 0,
      };
    });
    const known = rows.filter((row) => row.firstSeen != null).length;
    return {
      rows,
      evidence: evidenceStatus("local:wallet-stats+helius:oldest-first-batch", known > 0, known === rows.length && rows.length > 0, Date.now(), rows.length ? (known / rows.length) * 100 : 0),
    };
  }

  private creatorHistory(address: string | null): CreatorHistory | null {
    if (!address) return null;
    try {
      const row = getDevWallet(address);
      const tokens = getDevTokensByCreator(address, 500);
      if (!row && !tokens.length) return null;
      return {
        address,
        totalTokens: row?.totalTokens ?? tokens.length,
        migratedCount: row?.migratedCount ?? tokens.filter((token) => token.isMigrated).length,
        migrationRate: row?.migrationRate ?? (tokens.length ? tokens.filter((token) => token.isMigrated).length / tokens.length : null),
        reached300kCount: row?.reached300kCount ?? tokens.filter((token) => token.reached300k).length,
        rate300k: row?.rate300k ?? (tokens.length ? tokens.filter((token) => token.reached300k).length / tokens.length : null),
        totalVolumeSol: row?.totalVolumeSol ?? null,
        avgMcUsd: row?.avgMcUsd ?? null,
        maxMcUsd: row?.maxMcUsd ?? null,
        previousTokens: tokens.map((token) => ({
          mint: token.mint,
          createdAt: token.createdAt,
          marketCapUsd: token.marketCapUsd,
          athUsd: token.athUsd,
          isMigrated: token.isMigrated,
          reached300k: token.reached300k,
        })),
      };
    } catch {
      return null;
    }
  }

  private async verifyInitialFundingUncached(wallet: string, skipArchival = false): Promise<FundingLookup> {
    if (!skipArchival) try {
      // getTransfersByAddress is already oldest-first archival evidence; fetching a second
      // oldest transaction solely for fallback blockTime doubled funding RPC cost.
      const transfers = await this.rpc<HeliusHistoryResult<HeliusTransferRow>>("getTransfersByAddress", [
        wallet,
        {
          direction: "in",
          mint: WRAPPED_SOL_MINT,
          solMode: "merged",
          sortOrder: "asc",
          limit: 1,
          filters: { amount: { gte: FUNDING_MIN_LAMPORTS }, status: "succeeded" },
        },
      ]);
      const firstTransfer = transfers?.data?.[0];
      if (!firstTransfer?.signature) return { edge: null, historyComplete: true, source: "helius:archival" };
      if (firstTransfer?.signature) {
        const source = String(firstTransfer.fromUserAccount || "");
        const target = String(firstTransfer.toUserAccount || wallet);
        const decimals = Number(firstTransfer.decimals ?? 9);
        const rawAmount = Number(firstTransfer.amount ?? NaN);
        const uiAmount = Number(firstTransfer.uiAmount ?? NaN);
        const lamports = Number.isFinite(rawAmount) ? rawAmount : Number.isFinite(uiAmount) ? Math.round(uiAmount * 10 ** decimals) : 0;
        if (!source || target !== wallet || lamports < FUNDING_MIN_LAMPORTS) throw new Error("malformed archival funding row");
        return {
          edge: {
            source,
            target: wallet,
            signature: firstTransfer.signature,
            lamports,
            blockTime: firstTransfer.blockTime ?? null,
            historyComplete: true,
            confidence: 0.96,
          },
          historyComplete: true,
          source: "helius:archival",
        };
      }
      // getTransfersByAddress applies the amount filter server-side across archival
      // history, so an empty result is a valid negative for meaningful SOL funding.
      return { edge: null, historyComplete: true, source: "helius:archival" };
    } catch {
      // Portable fallback below is deliberately bounded to avoid request amplification.
    }

    const signatures: SignatureRow[] = [];
    let before: string | undefined;
    let historyComplete = false;
    for (let page = 0; page < 2; page++) {
      const params: unknown[] = [wallet, { limit: 100, ...(before ? { before } : {}) }];
      let rows: SignatureRow[];
      try { rows = await this.rpc<SignatureRow[]>("getSignaturesForAddress", params); }
      catch { return { edge: null, historyComplete: false, source: "rpc:fallback" }; }
      if (!rows.length) { historyComplete = true; break; }
      signatures.push(...rows);
      before = rows[rows.length - 1]?.signature;
      if (rows.length < 100) { historyComplete = true; break; }
    }
    if (!historyComplete || !signatures.length) return { edge: null, historyComplete, source: "rpc:fallback" };
    const oldest = [...signatures].reverse().slice(0, 16);
    const parsedOldest = await mapLimit(oldest, FALLBACK_CONCURRENCY, async (signature) => {
      try {
        const tx = await this.rpc<ParsedRpcTransaction | null>("getTransaction", [signature.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
        return { signature, tx };
      } catch {
        return { signature, tx: null };
      }
    });
    for (const { signature, tx } of parsedOldest) {
      for (const instruction of tx?.transaction?.message?.instructions || []) {
        const parsed = instruction.parsed;
        const info = parsed?.info || {};
        if (instruction.program !== "system" || !String(parsed?.type || "").startsWith("transfer")) continue;
        const destination = String(info.destination || "");
        const source = String(info.source || "");
        const lamports = Number(info.lamports || 0);
        if (destination !== wallet || !source || !Number.isFinite(lamports) || lamports < FUNDING_MIN_LAMPORTS) continue;
        return {
          edge: {
            source,
            target: wallet,
            signature: signature.signature,
            lamports,
            blockTime: tx?.blockTime ?? signature.blockTime ?? null,
            historyComplete: true,
            confidence: 0.95,
          },
          historyComplete: true,
          source: "rpc:fallback",
        };
      }
    }
    // We intentionally inspect only a bounded subset of old transactions. If no
    // funding edge was found, that is not an exhaustive negative even when the
    // signature list itself was exhausted. Keep the result unknown.
    return { edge: null, historyComplete: false, source: "rpc:fallback" };
  }

  private verifyInitialFunding(wallet: string): Promise<FundingLookup> {
    return memoTtl(fundingCache, `${this.url}|${wallet}`, FUNDING_TTL_MS, () => this.verifyInitialFundingUncached(wallet));
  }

  private async initialFundingBatch(addresses: string[]): Promise<FundingLookup[]> {
    const out = new Array<FundingLookup | undefined>(addresses.length);
    const unresolved: Array<{ address: string; index: number }> = [];
    const now = Date.now();
    for (let index = 0; index < addresses.length; index++) {
      const address = addresses[index];
      const key = `${this.url}|${address}`;
      const cached = fundingCache.get(key);
      if (cached && cached.expiresAt > now) {
        try { out[index] = await cached.value; } catch { unresolved.push({ address, index }); }
      } else {
        if (cached) fundingCache.delete(key);
        unresolved.push({ address, index });
      }
    }

    const fallback: Array<{ address: string; index: number }> = [];
    for (let i = 0; i < unresolved.length; i += RPC_BATCH_SIZE) {
      const chunk = unresolved.slice(i, i + RPC_BATCH_SIZE);
      try {
        const rows = await this.rpcBatchSettled<HeliusHistoryResult<HeliusTransferRow>>(
          chunk.map(({ address }) => ({
            method: "getTransfersByAddress",
            params: [address, {
              direction: "in",
              mint: WRAPPED_SOL_MINT,
              solMode: "merged",
              sortOrder: "asc",
              limit: 1,
              filters: { amount: { gte: FUNDING_MIN_LAMPORTS }, status: "succeeded" },
            }],
          })),
        );
        rows.forEach((row, rowIndex) => {
          const target = chunk[rowIndex];
          if (!row.ok) { fallback.push(target); return; }
          const transfer = row.result?.data?.[0];
          let lookup: FundingLookup = { edge: null, historyComplete: true, source: "helius:archival-batch" };
          if (transfer?.signature) {
            const source = String(transfer.fromUserAccount || "");
            const targetAddress = String(transfer.toUserAccount || target.address);
            const decimals = Number(transfer.decimals ?? 9);
            const rawAmount = Number(transfer.amount ?? NaN);
            const uiAmount = Number(transfer.uiAmount ?? NaN);
            const lamports = Number.isFinite(rawAmount) ? rawAmount : Number.isFinite(uiAmount) ? Math.round(uiAmount * 10 ** decimals) : 0;
            if (!source || targetAddress !== target.address || lamports < FUNDING_MIN_LAMPORTS) {
              // A row that passed the server-side filter but cannot be validated locally is
              // malformed/ambiguous evidence, not proof that funding was absent.
              fallback.push(target);
              return;
            }
            lookup = {
              edge: { source, target: target.address, signature: transfer.signature, lamports, blockTime: transfer.blockTime ?? null, historyComplete: true, confidence: 0.96 },
              historyComplete: true,
              source: "helius:archival-batch",
            };
          }
          out[target.index] = lookup;
          setResolvedCache(fundingCache, `${this.url}|${target.address}`, FUNDING_TTL_MS, lookup);
        });
      } catch {
        fallback.push(...chunk);
      }
    }

    const uniqueFallback = [...new Map(fallback.map((item) => [item.address, item])).values()];
    const fallbackRows = await mapLimit(uniqueFallback, FALLBACK_CONCURRENCY, async ({ address }) => {
      // Batch failure already told us the archival method is unavailable/invalid for this
      // lookup; go straight to the portable fallback instead of retrying the same RPC.
      const lookup = await this.verifyInitialFundingUncached(address, true);
      setResolvedCache(fundingCache, `${this.url}|${address}`, FUNDING_TTL_MS, lookup);
      return lookup;
    });
    uniqueFallback.forEach((item, index) => { out[item.index] = fallbackRows[index]; });
    return out.map((row) => row ?? { edge: null, historyComplete: false, source: "funding:unknown" });
  }

  private async fundingGraph(addresses: string[]): Promise<{ edges: FundingEdge[]; checkedWallets: string[]; groups: FundingGroup[]; evidence: EvidenceStatus }> {
    const lookups = await this.initialFundingBatch(addresses);
    const edges = lookups.map((lookup) => lookup.edge).filter((edge): edge is FundingEdge => edge != null && edge.historyComplete);
    const checkedWallets = addresses.filter((_, index) => lookups[index]?.historyComplete);
    const completeChecks = checkedWallets.length;
    const byFunder = new Map<string, string[]>();
    for (const edge of edges) {
      const wallets = byFunder.get(edge.source) || [];
      wallets.push(edge.target);
      byFunder.set(edge.source, wallets);
    }
    const groups = [...byFunder.entries()]
      .map(([funder, wallets]) => ({ funder, wallets: [...new Set(wallets)] }))
      .filter((group) => group.wallets.length >= 2);
    return {
      edges,
      checkedWallets,
      groups,
      evidence: evidenceStatus(
        [...new Set(lookups.map((lookup) => lookup.source))].join("+") || "funding:unknown",
        completeChecks > 0,
        addresses.length > 0 && completeChecks === addresses.length,
        Date.now(),
        addresses.length ? (completeChecks / addresses.length) * 100 : 0,
        "Only fully exhausted/archival oldest-history checks are promoted to verified funding edges.",
      ),
    };
  }

  async getQualitySupplement(mint: string, largest: LargestAccount[]): Promise<ChainQualitySupplement> {
    const fetchedAt = Date.now();
    // Start independent network branches together. getMarket() shares the in-flight Pump
    // promise via memoTtl, so this overlaps DexScreener with trade-history loading.
    const [tradeLoad, pump, market] = await Promise.all([this.getTrades(mint), this.getPump(mint), this.getMarket(mint)]);
    const persistedCreator = (() => { try { return getPersistedCreatorForMint(mint); } catch { return null; } })();
    const pumpOnChainVerified = pump?.source === "rpc:pump-bonding-curve";
    // Creator linkage drives insider/funding risk, so do not promote a mutable frontend
    // metadata value to an on-chain identity. Local history may still use the persisted
    // address as best-effort context, but the risk graph only receives a chain-verified creator.
    const creator = pumpOnChainVerified ? pump?.creator || null : null;
    const creatorHistoryAddress = creator || persistedCreator || null;
    const holderAddresses = largest.map((row) => row.address).filter(Boolean).slice(0, 30);
    const analysisWallets = [...new Set([...holderAddresses, ...(creator ? [creator] : [])])];
    const fundingTargets = [...new Set([...holderAddresses.slice(0, 8), ...(creator ? [creator] : [])])];
    const [walletStatsResult, funding] = await Promise.all([
      this.walletStats(analysisWallets),
      this.fundingGraph(fundingTargets),
    ]);
    const walletTokenHistory: Record<string, WalletTokenHistory[]> = {};
    let walletsWithHistory = 0;
    const historyAddresses = holderAddresses.slice(0, 20);
    try {
      const batch = getWalletTokensBatch(historyAddresses);
      for (const address of historyAddresses) {
        const rows = batch.get(address) || [];
        walletTokenHistory[address] = rows;
        if (rows.length) walletsWithHistory++;
      }
    } catch {
      for (const address of historyAddresses) walletTokenHistory[address] = [];
    }
    const creatorHistory = this.creatorHistory(creatorHistoryAddress);
    const holderCoverage = largest.reduce((acc, row) => acc + Math.max(0, row.pct), 0);
    const holderComplete = largest.length === 0 ? false : largest.every((row) => row.holderSetComplete === true);
    const holderUsesFullScan = largest[0]?.source === "program_accounts";
    const holderSource = holderUsesFullScan ? "rpc:getProgramAccounts-owner-aggregation" : "rpc:getTokenLargestAccounts-partial";
    const holderNote = holderComplete
      ? "Full token-account scan aggregated by owner; returned holder set is complete."
      : holderUsesFullScan
        ? "Full token-account scan was aggregated by owner before ranking; returned Top-N owners are exact, but the long tail is omitted."
        : "Fallback is limited to getTokenLargestAccounts token accounts and is not an exhaustive owner ranking.";
    const marketSource = market?.isCanonicalMigrationPool && market.virtualQuoteReserves != null
      ? "dexscreener:pairs+rpc:pumpswap-pool"
      : "dexscreener:pairs";
    const evidence: ChainEvidenceCoverage = {
      holders: evidenceStatus(holderSource, largest.length > 0, holderComplete, fetchedAt, holderComplete ? 100 : Math.min(100, holderCoverage), holderNote),
      recentTrades: tradeLoad.recentEvidence,
      launchHistory: tradeLoad.launchEvidence,
      walletAge: walletStatsResult.evidence,
      funding: funding.evidence,
      market: evidenceStatus(marketSource, market != null, market != null, fetchedAt, market ? 100 : 0, market?.isCanonicalMigrationPool ? "Canonical PumpSwap migration pool matched; virtual quote reserve was decoded on-chain when available." : "Market may be a secondary pool; migration/exit logic remains conservative."),
      pump: evidenceStatus(
        pump?.source || "pumpfun:unavailable",
        pump != null,
        pumpOnChainVerified,
        fetchedAt,
        pumpOnChainVerified ? 100 : pump ? 35 : 0,
        pumpOnChainVerified
          ? "Pump bonding-curve state decoded directly from the on-chain account."
          : pump ? "Frontend Pump metadata is best-effort only and is not promoted to complete on-chain evidence." : "Pump state unavailable.",
      ),
      creatorHistory: evidenceStatus("local:creator-history", creatorHistory != null, creatorHistory != null, fetchedAt, creatorHistory ? 100 : 0),
      walletHistory: evidenceStatus("local:wallet-token-history", walletsWithHistory > 0, false, fetchedAt, holderAddresses.length ? (walletsWithHistory / Math.min(20, holderAddresses.length)) * 100 : 0, "Local historical coverage is not assumed to be exhaustive chain history."),
    };
    return {
      trades: tradeLoad.trades,
      walletStats: walletStatsResult.rows,
      walletTokenHistory,
      creator,
      creatorHistory,
      fundingEdges: funding.edges,
      fundingCheckedWallets: funding.checkedWallets,
      fundingGroups: funding.groups,
      market,
      pump,
      history: (() => {
        try { return listChainQualitySnapshots(mint, Date.now() - 72 * 3_600_000, 2_000); }
        catch { return []; }
      })(),
      temporalHistory: (() => {
        try { return listChainTemporalSnapshots(mint, Date.now() - 7 * 24 * 3_600_000, 10_500); }
        catch { return []; }
      })(),
      walletClusterHistory: (() => {
        try { return listChainWalletClusters(mint, 500).map((row) => ({ clusterId: row.clusterId, observations: row.observations, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, updatedAt: row.updatedAt, wallets: row.wallets })); }
        catch { return []; }
      })(),
      evidence,
    };
  }

  async recordQualitySnapshot(mint: string, quality: ChainQualityAnalytics, observedAt: number): Promise<void> {
    try {
      persistChainQualitySnapshot(mint, {
        observedAt,
        holderCount: quality.concentration.totalHolderCount,
        top10Pct: quality.concentration.top10Pct,
        adjustedTop10Pct: quality.concentration.adjustedTop10Pct,
        fresh24SupplyPct: quality.walletAge.freshLt24hSupplyPct,
        insiderSupplyPct: quality.insiders.candidateSupplyPct,
        bundleSupplyPct: quality.bundles.currentSupplyPct,
        washWalletPct: quality.wash.walletSharePct,
        smartInflowSol: quality.smartMoney.netInflowSol,
        liquidityUsd: quality.exitLiquidity.liquidityUsd,
        evidenceCompleteness: quality.evidenceCompletenessPct,
      });
    } catch {
      // Response remains available even if local history persistence fails.
    }
  }

  async recordTemporalSnapshot(mint: string, quality: ChainQualityAnalyticsV3, observedAt: number): Promise<void> {
    try {
      persistChainTemporalSnapshot(mint, quality.snapshot);
      upsertChainWalletClusters(mint, quality.walletClusters, observedAt);
    } catch {
      // Temporal persistence is enrichment-only and must never break chain-full.
    }
  }
}

function mockEvidence(now = Date.now()): ChainEvidenceCoverage {
  const full = evidenceStatus("fixture", true, true, now, 100);
  const trade = tradeEvidence("fixture", true, true, now, 100, { launchSlot: 1, launchBlockTime: Math.floor(now / 1000), earlyWindowMaxSlot: 101, oldestRecentTimestamp: Math.floor(now / 1000) - 3600, recentCoverageSec: 3600 });
  return {
    holders: full,
    recentTrades: trade,
    launchHistory: trade,
    walletAge: full,
    funding: full,
    market: full,
    pump: full,
    creatorHistory: full,
    walletHistory: full,
  };
}

/** Fixture provider for deterministic tests. */
export class MockChainProvider implements ChainProvider {
  constructor(private readonly fixture: {
    mint: MintInfo;
    largest: LargestAccount[];
    holders: HolderPoint[];
    liquidity: { liquidityUsd: number | null; reserveTokens: number | null; vol24Usd: number | null };
    lp: { lockedPct: number | null; burnedPct: number | null; concentrationPct: number | null };
    sellOk: boolean | null;
    tax: number | null;
    dev: DevBehavior;
    clusters: ClusterInfo;
    events: ChainEvent[];
    quality?: ChainQualitySupplement;
  }) {}
  async getMintInfo(): Promise<MintInfo> { return this.fixture.mint; }
  async getLargestAccounts(): Promise<LargestAccount[]> { return this.fixture.largest; }
  async getHoldersSeries(): Promise<HolderPoint[]> { return this.fixture.holders; }
  async getLiquidity(): Promise<{ liquidityUsd: number | null; reserveTokens: number | null; vol24Usd: number | null }> { return this.fixture.liquidity; }
  async getLpLock(): Promise<{ lockedPct: number | null; burnedPct: number | null; concentrationPct: number | null }> { return this.fixture.lp; }
  async simulateSell(): Promise<boolean | null> { return this.fixture.sellOk; }
  async getTransferTax(): Promise<number | null> { return this.fixture.tax; }
  async getDev(): Promise<DevBehavior> { return this.fixture.dev; }
  async getClusters(): Promise<ClusterInfo> { return this.fixture.clusters; }
  async getEvents(): Promise<ChainEvent[]> { return this.fixture.events; }
  async getQualitySupplement(): Promise<ChainQualitySupplement> {
    return this.fixture.quality ?? {
      trades: [], walletStats: [], walletTokenHistory: {}, creator: null, creatorHistory: null,
      fundingEdges: [], fundingCheckedWallets: [], fundingGroups: [], market: null, pump: null, history: [], temporalHistory: [], walletClusterHistory: [], evidence: mockEvidence(),
    };
  }
  async recordQualitySnapshot(): Promise<void> {}
  async recordTemporalSnapshot(): Promise<void> {}
}
