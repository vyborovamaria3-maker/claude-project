import bs58 from "bs58";
import type {
  KolEvidence,
  KolListResponse,
  KolProfile,
  KolSourceStatus,
  KolWallet,
  KolWalletMetrics,
} from "@/lib/kols/types";

const KOLSCAN_DATASET_URL =
  "https://raw.githubusercontent.com/nirholas/kol-quest/main/output/kolscan-leaderboard.json";
const FIREFLY_PROFILE_URL = "https://api.firefly.land/v2/wallet/profile";
const NEXT_ID_PROOF_URL = "https://proof-service.next.id/v1/proof";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 POTAPoff-KOL-Resolver/1.0";

interface KolscanRow {
  wallet_address?: string;
  name?: string;
  telegram?: string | null;
  twitter?: string | null;
  profit?: number;
  wins?: number;
  losses?: number;
  timeframe?: number;
}

interface FireflyVerifiedSource {
  source?: string;
  provider?: string;
  verifiedText?: string;
}

interface FireflyWalletProfile {
  address?: string;
  blockchain?: string;
  is_connected?: boolean;
  verifiedSources?: FireflyVerifiedSource[];
}

interface FireflyResponse {
  code?: number;
  data?: {
    walletProfiles?: FireflyWalletProfile[];
    solanaWalletProfiles?: FireflyWalletProfile[];
    twitterProfiles?: Array<{ handle?: string }>;
    account?: { displayName?: string; avatar?: string } | null;
  };
}

interface NextIdProof {
  platform?: string;
  identity?: string;
  is_valid?: boolean;
  invalid_reason?: string;
}

interface NextIdResponse {
  ids?: Array<{
    proofs?: NextIdProof[];
  }>;
}

function clampConfidence(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function normalizeTwitterHandle(value: string) {
  let handle = value.trim();
  handle = handle.replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, "");
  handle = handle.replace(/^@/, "");
  handle = handle.split(/[/?#]/)[0] ?? handle;
  return handle.trim();
}

function handleFromUrl(value?: string | null) {
  return value ? normalizeTwitterHandle(value) : "";
}

function isValidEthereumAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function isValidSolanaAddress(value: string) {
  const trimmed = value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return false;
  try {
    return bs58.decode(trimmed).length === 32;
  } catch {
    return false;
  }
}

function isValidWalletAddress(address: string, chain: "solana" | "ethereum") {
  return chain === "ethereum"
    ? isValidEthereumAddress(address)
    : isValidSolanaAddress(address);
}

function walletAddressEquals(left: string, right: string, chain: "solana" | "ethereum") {
  return chain === "solana"
    ? left === right
    : left.toLowerCase() === right.toLowerCase();
}

function createProfile(handle: string, name?: string | null): KolProfile {
  return {
    handle,
    name: name?.trim() || `@${handle}`,
    avatar: null,
    twitterUrl: `https://x.com/${encodeURIComponent(handle)}`,
    telegramUrl: null,
    confidence: 0,
    verified: false,
    wallets: [],
    sources: [],
  };
}

function mergeMetrics(base: KolWalletMetrics, incoming: KolWalletMetrics): KolWalletMetrics {
  return {
    pnl1dSol: incoming.pnl1dSol ?? base.pnl1dSol,
    pnl7dSol: incoming.pnl7dSol ?? base.pnl7dSol,
    pnl30dSol: incoming.pnl30dSol ?? base.pnl30dSol,
    realizedPnl1dUsd: incoming.realizedPnl1dUsd ?? base.realizedPnl1dUsd,
    realizedPnl7dUsd: incoming.realizedPnl7dUsd ?? base.realizedPnl7dUsd,
    realizedPnl30dUsd: incoming.realizedPnl30dUsd ?? base.realizedPnl30dUsd,
    wins1d: incoming.wins1d ?? base.wins1d,
    losses1d: incoming.losses1d ?? base.losses1d,
    winRate1d: incoming.winRate1d ?? base.winRate1d,
    wins7d: incoming.wins7d ?? base.wins7d,
    losses7d: incoming.losses7d ?? base.losses7d,
    winRate7d: incoming.winRate7d ?? base.winRate7d,
    wins30d: incoming.wins30d ?? base.wins30d,
    losses30d: incoming.losses30d ?? base.losses30d,
    winRate30d: incoming.winRate30d ?? base.winRate30d,
    wins: incoming.wins ?? base.wins,
    losses: incoming.losses ?? base.losses,
    winRate: incoming.winRate ?? base.winRate,
    lastTradeAt: incoming.lastTradeAt ?? base.lastTradeAt,
    internalSource: incoming.internalSource ?? base.internalSource,
  };
}

function recalcWallet(wallet: KolWallet) {
  const uniqueSources = new Set(wallet.evidence.map((item) => item.source)).size;
  const strongest = wallet.evidence.reduce((max, item) => Math.max(max, item.confidence), 0);
  const sourceBoost = Math.max(0, uniqueSources - 1) * 4;
  wallet.confidence = clampConfidence(strongest + sourceBoost);
  wallet.verified = wallet.evidence.some((item) => item.verified) && wallet.confidence >= 90;
}

function recalcProfile(profile: KolProfile) {
  profile.sources = Array.from(
    new Set(profile.wallets.flatMap((wallet) => wallet.evidence.map((item) => item.source))),
  ).sort();
  profile.confidence = profile.wallets.reduce(
    (max, wallet) => Math.max(max, wallet.confidence),
    0,
  );
  profile.verified = profile.wallets.some((wallet) => wallet.verified);
}

function mergeWallet(profile: KolProfile, incoming: KolWallet) {
  if (!isValidWalletAddress(incoming.address, incoming.chain)) return;
  const existing = profile.wallets.find(
    (wallet) =>
      wallet.chain === incoming.chain &&
      walletAddressEquals(wallet.address, incoming.address, incoming.chain),
  );

  if (!existing) {
    recalcWallet(incoming);
    profile.wallets.push(incoming);
    recalcProfile(profile);
    return;
  }

  const evidenceKeys = new Set(
    existing.evidence.map((item) => `${item.source}:${item.kind}:${item.detail}`),
  );
  for (const evidence of incoming.evidence) {
    const key = `${evidence.source}:${evidence.kind}:${evidence.detail}`;
    if (!evidenceKeys.has(key)) {
      existing.evidence.push(evidence);
      evidenceKeys.add(key);
    }
  }
  existing.metrics = mergeMetrics(existing.metrics, incoming.metrics);
  recalcWallet(existing);
  recalcProfile(profile);
}

function addKolscanRow(profile: KolProfile, row: KolscanRow) {
  const address = row.wallet_address?.trim();
  if (!address || !isValidSolanaAddress(address)) return;

  const wins = Number.isFinite(row.wins) ? Number(row.wins) : undefined;
  const losses = Number.isFinite(row.losses) ? Number(row.losses) : undefined;
  const total = (wins ?? 0) + (losses ?? 0);
  const winRate = total > 0 ? ((wins ?? 0) / total) * 100 : undefined;
  const timeframe = row.timeframe === 7 || row.timeframe === 30 ? row.timeframe : 1;
  const metrics: KolWalletMetrics = {};
  if (timeframe === 30) {
    metrics.wins30d = wins;
    metrics.losses30d = losses;
    metrics.winRate30d = winRate;
  } else if (timeframe === 7) {
    metrics.wins7d = wins;
    metrics.losses7d = losses;
    metrics.winRate7d = winRate;
  } else {
    metrics.wins1d = wins;
    metrics.losses1d = losses;
    metrics.winRate1d = winRate;
  }

  const profit = Number(row.profit);
  if (Number.isFinite(profit)) {
    if (timeframe === 30) metrics.pnl30dSol = profit;
    else if (timeframe === 7) metrics.pnl7dSol = profit;
    else metrics.pnl1dSol = profit;
  }

  const evidence: KolEvidence = {
    source: "KOL Quest / KolScan",
    kind: "curated_label",
    confidence: 70,
    verified: false,
    detail: "Wallet appears in the public KolScan KOL leaderboard dataset.",
    url: "https://github.com/nirholas/kol-quest",
  };

  mergeWallet(profile, {
    address,
    chain: "solana",
    confidence: 70,
    verified: false,
    evidence: [evidence],
    metrics,
  });

  if (!profile.telegramUrl && row.telegram) profile.telegramUrl = row.telegram;
  if (row.name?.trim() && profile.name.startsWith("@")) profile.name = row.name.trim();
}

async function fetchKolscanRows(): Promise<KolscanRow[]> {
  const response = await fetch(KOLSCAN_DATASET_URL, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    next: { revalidate: 1800 },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`KOL dataset HTTP ${response.status}`);
  const data: unknown = await response.json();
  return Array.isArray(data) ? (data as KolscanRow[]) : [];
}

async function enrichFromFirefly(handle: string, profile: KolProfile) {
  const url = new URL(FIREFLY_PROFILE_URL);
  url.searchParams.set("twitterHandle", handle);
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) throw new Error(`Firefly HTTP ${response.status}`);

  const payload = (await response.json()) as FireflyResponse;
  const data = payload.data;
  if (!data) return;

  if (data.account?.displayName) profile.name = data.account.displayName;
  if (data.account?.avatar) profile.avatar = data.account.avatar;

  const ingest = (wallet: FireflyWalletProfile, chain: "solana" | "ethereum") => {
    const address = wallet.address?.trim();
    if (!address || !isValidWalletAddress(address, chain)) return;
    const sources = Array.isArray(wallet.verifiedSources) ? wallet.verifiedSources : [];
    const hasVerifiedSource = sources.length > 0;
    const connected = wallet.is_connected === true;
    const confidence = hasVerifiedSource ? 96 : connected ? 90 : 82;
    const verified = hasVerifiedSource || connected;
    const sourceText = sources
      .map((source) => source.verifiedText || source.provider || source.source)
      .filter(Boolean)
      .join(", ");

    mergeWallet(profile, {
      address,
      chain,
      confidence,
      verified,
      evidence: [
        {
          source: "Firefly",
          kind: "connected_profile",
          confidence,
          verified,
          detail: sourceText || (connected ? "Wallet connected to the Firefly identity." : "Wallet returned for the X identity."),
          url: `https://firefly.social/profile/twitter/${encodeURIComponent(handle)}`,
        },
      ],
      metrics: {},
    });
  };

  for (const wallet of data.walletProfiles ?? []) ingest(wallet, "ethereum");
  for (const wallet of data.solanaWalletProfiles ?? []) ingest(wallet, "solana");
}

async function enrichFromNextId(handle: string, profile: KolProfile) {
  const url = new URL(NEXT_ID_PROOF_URL);
  url.searchParams.set("platform", "twitter");
  url.searchParams.set("identity", handle);
  url.searchParams.set("exact", "true");
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    next: { revalidate: 900 },
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) throw new Error(`Next.ID HTTP ${response.status}`);
  const payload = (await response.json()) as NextIdResponse;

  for (const identity of payload.ids ?? []) {
    const proofs = (identity.proofs ?? []).filter((proof) => proof.is_valid === true);
    const twitterProof = proofs.find(
      (proof) =>
        proof.platform?.toLowerCase() === "twitter" &&
        normalizeTwitterHandle(proof.identity ?? "").toLowerCase() === handle.toLowerCase(),
    );
    if (!twitterProof) continue;

    for (const proof of proofs) {
      const platform = proof.platform?.toLowerCase();
      if (platform !== "solana" && platform !== "ethereum") continue;
      const address = proof.identity?.trim();
      if (!address || !isValidWalletAddress(address, platform)) continue;
      mergeWallet(profile, {
        address,
        chain: platform,
        confidence: 100,
        verified: true,
        evidence: [
          {
            source: "Next.ID",
            kind: "signed_proof",
            confidence: 100,
            verified: true,
            detail: "Cryptographic proof chain links this wallet to the X identity.",
            url: "https://next.id/",
          },
        ],
        metrics: {},
      });
    }
  }
}

function metricForTimeframe(wallet: KolWallet, timeframe: 1 | 7 | 30): number | null {
  if (timeframe === 30) return wallet.metrics.pnl30dSol ?? null;
  if (timeframe === 7) return wallet.metrics.pnl7dSol ?? null;
  return wallet.metrics.pnl1dSol ?? null;
}

function profileMetric(profile: KolProfile, timeframe: 1 | 7 | 30): number | null {
  const values = profile.wallets
    .map((wallet) => metricForTimeframe(wallet, timeframe))
    .filter((value): value is number => value != null && Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function looksLikeWallet(value: string) {
  const trimmed = value.trim();
  return isValidEthereumAddress(trimmed) || isValidSolanaAddress(trimmed);
}

export async function getKols(options: {
  query?: string;
  limit?: number;
  timeframe?: 1 | 7 | 30;
  verifiedOnly?: boolean;
  minConfidence?: number;
}): Promise<KolListResponse> {
  const query = options.query?.trim() ?? "";
  const timeframe = options.timeframe ?? 7;
  const limit = Math.max(1, Math.min(200, options.limit ?? 100));
  const minConfidence = Math.max(0, Math.min(100, options.minConfidence ?? 0));
  const sourceStatus: KolSourceStatus[] = [];
  const profiles = new Map<string, KolProfile>();

  try {
    const rows = await fetchKolscanRows();
    for (const row of rows) {
      const handle = handleFromUrl(row.twitter);
      if (!handle) continue;
      const key = handle.toLowerCase();
      const profile = profiles.get(key) ?? createProfile(handle, row.name);
      addKolscanRow(profile, row);
      profiles.set(key, profile);
    }
    sourceStatus.push({ source: "KOL Quest / KolScan", ok: true, detail: `${profiles.size} X identities loaded` });
  } catch (error) {
    sourceStatus.push({ source: "KOL Quest / KolScan", ok: false, detail: error instanceof Error ? error.message : "dataset unavailable" });
  }

  const normalizedHandle = normalizeTwitterHandle(query);
  const exactKey = normalizedHandle.toLowerCase();
  const shouldResolveIdentity = Boolean(query) && !looksLikeWallet(query) && /^[A-Za-z0-9_]{1,15}$/.test(normalizedHandle);

  if (shouldResolveIdentity) {
    const profile = profiles.get(exactKey) ?? createProfile(normalizedHandle);
    const results = await Promise.allSettled([
      enrichFromFirefly(normalizedHandle, profile),
      enrichFromNextId(normalizedHandle, profile),
    ]);
    sourceStatus.push({
      source: "Firefly",
      ok: results[0].status === "fulfilled",
      detail: results[0].status === "rejected" ? String(results[0].reason) : "identity lookup complete",
    });
    sourceStatus.push({
      source: "Next.ID",
      ok: results[1].status === "fulfilled",
      detail: results[1].status === "rejected" ? String(results[1].reason) : "proof lookup complete",
    });
    recalcProfile(profile);
    if (profile.wallets.length > 0 || profiles.has(exactKey)) profiles.set(exactKey, profile);
  }

  const queryText = query.trim();
  const queryLower = queryText.toLowerCase();
  let items = Array.from(profiles.values()).filter((profile) => {
    if (!queryText) return true;
    if (looksLikeWallet(queryText)) {
      const chain = isValidEthereumAddress(queryText) ? "ethereum" : "solana";
      return profile.wallets.some(
        (wallet) => wallet.chain === chain && walletAddressEquals(wallet.address, queryText, chain),
      );
    }
    return (
      profile.handle.toLowerCase().includes(exactKey) ||
      profile.name.toLowerCase().includes(queryLower) ||
      profile.wallets.some((wallet) =>
        wallet.chain === "ethereum"
          ? wallet.address.toLowerCase().includes(queryLower)
          : wallet.address.includes(queryText),
      )
    );
  });

  if (options.verifiedOnly) items = items.filter((profile) => profile.verified);
  if (minConfidence > 0) items = items.filter((profile) => profile.confidence >= minConfidence);

  items.sort((a, b) => {
    const aMetric = profileMetric(a, timeframe);
    const bMetric = profileMetric(b, timeframe);
    const aHasMetric = aMetric != null && Number.isFinite(aMetric);
    const bHasMetric = bMetric != null && Number.isFinite(bMetric);
    if (aHasMetric !== bHasMetric) return bHasMetric ? 1 : -1;
    if (aHasMetric && bHasMetric && aMetric !== bMetric) return (bMetric as number) - (aMetric as number);
    return b.confidence - a.confidence || a.handle.localeCompare(b.handle);
  });

  const total = items.length;
  items = items.slice(0, limit);

  return {
    items,
    total,
    timeframe,
    generatedAt: new Date().toISOString(),
    sourceStatus,
  };
}
