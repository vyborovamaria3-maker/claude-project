import type { TwitterStats } from "@/app/api/trade/dev-twitter/route";
import type { WalletRowData } from "@/components/trade/WalletRow";

export type AnalysisChainInput = {
  mint: string;
  summary?: {
    totalVolumeSol?: number | null;
    totalTrades?: number | null;
    uniqueWallets?: number | null;
    historyTruncated?: boolean | null;
    totalRawTrades?: number | null;
  } | null;
  wallets?: WalletRowData[] | null;
  bundles?: Array<{ totalVolumeSol?: number | null; wallets?: string[] | null }> | null;
  truncated?: boolean | null;
};

export type TokenSocialMeta = {
  symbol?: string | null;
  name?: string | null;
  socials?: {
    twitter?: string | null;
    telegram?: string | null;
    website?: string | null;
  } | null;
};

export type UnifiedTradeScore = {
  score: number | null;
  risk: number | null;
  confidence: number;
  action: "buy" | "wait" | "avoid" | "insufficient";
  title: string;
  oneLiner: string;
  reasonsFor: string[];
  reasonsAgainst: string[];
  missing: string[];
  blockers: string[];
  safeEntryThesis: string;
  provenance: {
    available: boolean;
    risk: number | null;
    notes: string[];
  };
  firstCall: {
    available: boolean;
    risk: number | null;
    notes: string[];
  };
  sources: {
    chain: boolean;
    x: boolean;
    telegramFirstCall: boolean;
    provenance: boolean;
  };
};

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function num(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function weighted(values: Array<{ value: number | null; weight: number }>) {
  const present = values.filter((item): item is { value: number; weight: number } => item.value != null);
  const weight = present.reduce((sum, item) => sum + item.weight, 0);
  if (!weight) return null;
  return clamp(present.reduce((sum, item) => sum + item.value * item.weight, 0) / weight);
}

function scoreText(value: number | null) {
  return value == null ? "—" : `${Math.round(value)}/100`;
}

function socialPresence(meta: TokenSocialMeta | null) {
  return {
    twitter: Boolean(meta?.socials?.twitter),
    telegram: Boolean(meta?.socials?.telegram),
    website: Boolean(meta?.socials?.website),
  };
}

function deriveChain(chain: AnalysisChainInput | null) {
  const wallets = chain?.wallets ?? [];
  const bundles = chain?.bundles ?? [];
  const totalVolume = num(chain?.summary?.totalVolumeSol);
  const totalTrades = num(chain?.summary?.totalTrades);
  const topVolume = wallets
    .map((wallet) => Math.max(0, num(wallet.volumeSol)))
    .sort((left, right) => right - left)
    .slice(0, 5)
    .reduce((sum, value) => sum + value, 0);
  const concentration = totalVolume > 0 && wallets.length >= 4 ? clamp((topVolume / totalVolume) * 100) : null;
  const washWallets = wallets.filter((wallet) => wallet.isWashTrader).length;
  const washRisk = wallets.length >= 3 ? clamp((washWallets / wallets.length) * 100) : null;
  const bundleVolume = bundles.reduce((sum, bundle) => sum + Math.max(0, num(bundle.totalVolumeSol)), 0);
  const bundleRisk = totalVolume > 0 ? clamp((bundleVolume / totalVolume) * 100) : null;
  const buyCount = wallets.reduce((sum, wallet) => sum + Math.max(0, num(wallet.buys)), 0);
  const sellCount = wallets.reduce((sum, wallet) => sum + Math.max(0, num(wallet.sells)), 0);
  const sellability = buyCount + sellCount >= 20 ? clamp((sellCount / (buyCount + sellCount)) * 250) : null;
  const smartWallets = wallets.filter((wallet) => wallet.isSmart).length;
  const smartScore = wallets.length >= 3 ? clamp((smartWallets / wallets.length) * 300) : null;
  const freshWallets = wallets.filter((wallet) => wallet.isFresh).length;
  const freshRisk = wallets.length >= 3 ? clamp((freshWallets / wallets.length) * 100) : null;

  const risk = weighted([
    { value: concentration, weight: 0.3 },
    { value: washRisk, weight: 0.25 },
    { value: bundleRisk, weight: 0.25 },
    { value: freshRisk, weight: 0.2 },
  ]);
  const quality = weighted([
    { value: concentration == null ? null : 100 - concentration, weight: 0.28 },
    { value: washRisk == null ? null : 100 - washRisk, weight: 0.22 },
    { value: bundleRisk == null ? null : 100 - bundleRisk, weight: 0.2 },
    { value: sellability, weight: 0.18 },
    { value: smartScore, weight: 0.12 },
  ]);

  return {
    available: wallets.length > 0 || totalTrades > 0,
    quality,
    risk,
    concentration,
    washRisk,
    washWallets,
    bundleRisk,
    bundleCount: bundles.length,
    sellability,
    totalTrades,
    walletCount: wallets.length,
    truncated: Boolean(chain?.truncated || chain?.summary?.historyTruncated),
  };
}

function deriveX(x: TwitterStats | null) {
  if (!x || (x.totalTweets <= 0 && x.topTweets.length <= 0)) {
    return { available: false, quality: null, risk: null };
  }
  const botRisk = clamp(num((x as any).riskUniverse?.botRiskScore ?? x.botRiskScore));
  const authorDiffusion = x.totalTweets > 0 ? clamp((x.uniqueMentioners / x.totalTweets) * 100) : null;
  const engagement = x.totalViews > 0 ? clamp(((x.totalLikes + x.totalRetweets) / x.totalViews) * 1200) : null;
  const verified = x.uniqueMentioners > 0 ? clamp((num(x.aggregated?.verifiedAuthors) / x.uniqueMentioners) * 100) : null;
  return {
    available: true,
    quality: weighted([
      { value: botRisk == null ? null : 100 - botRisk, weight: 0.34 },
      { value: authorDiffusion, weight: 0.26 },
      { value: engagement, weight: 0.22 },
      { value: verified, weight: 0.18 },
    ]),
    risk: botRisk,
  };
}

function deriveProvenance(meta: TokenSocialMeta | null) {
  const presence = socialPresence(meta);
  const notes: string[] = [];
  if (!meta) return { available: false, risk: null, notes };

  let risk = 20;
  if (!presence.twitter) {
    risk += 25;
    notes.push("X-ссылка не найдена");
  }
  if (!presence.telegram) {
    risk += 20;
    notes.push("Telegram-ссылка не найдена");
  }
  if (!presence.website) {
    risk += 8;
    notes.push("сайт не найден");
  }
  if (presence.twitter && presence.telegram) {
    notes.push("есть заявленные X и Telegram");
  }
  return { available: true, risk: clamp(risk), notes };
}

function buildSafeEntry(score: number | null, risk: number | null, confidence: number, missing: string[]) {
  if (score == null) return "Вход не подтверждён: сначала нужны данные хотя бы по on-chain или X.";
  if ((risk ?? 0) >= 65) return "Безопасный вход отсутствует: риск выше допустимого, лучше ждать нового независимого подтверждения и снижения красных флагов.";
  if (score >= 70 && (risk ?? 100) <= 35 && confidence >= 60) {
    return "Допустим только малый тестовый вход: тезис держится, пока нет новых bundle/wash сигналов и цена не ушла резко выше первой зоны интереса.";
  }
  if (missing.length > 0) {
    return `Сейчас лучше ждать: не хватает ${missing.join(", ")}, поэтому текущий вход нельзя считать подтверждённым.`;
  }
  return "Можно только наблюдать или заходить минимально: нужен новый независимый факт, который улучшит риск/доходность.";
}

export function buildTradeAnalysisScore(args: {
  chain: AnalysisChainInput | null;
  x: TwitterStats | null;
  meta: TokenSocialMeta | null;
}): UnifiedTradeScore {
  const chain = deriveChain(args.chain);
  const x = deriveX(args.x);
  const provenance = deriveProvenance(args.meta);
  const firstCall = {
    available: false,
    risk: null,
    notes: ["TG first-call ещё не подключён к текущему backend; отсутствие данных не считается негативным сигналом."],
  };
  const missing = [
    !chain.available ? "on-chain" : null,
    !x.available ? "X" : null,
    !firstCall.available ? "TG first-call" : null,
    !provenance.available ? "provenance" : null,
  ].filter((value): value is string => value != null);

  const score = weighted([
    { value: chain.quality, weight: 0.48 },
    { value: x.quality, weight: 0.24 },
    { value: provenance.risk == null ? null : 100 - provenance.risk, weight: 0.18 },
    { value: firstCall.risk == null ? null : 100 - firstCall.risk, weight: 0.1 },
  ]);
  const risk = weighted([
    { value: chain.risk, weight: 0.44 },
    { value: x.risk, weight: 0.2 },
    { value: provenance.risk, weight: 0.24 },
    { value: firstCall.risk, weight: 0.12 },
  ]);
  const activeSources = Number(chain.available) + Number(x.available) + Number(provenance.available) + Number(firstCall.available);
  const confidence = clamp(activeSources * 20 + (chain.truncated ? 0 : 15) + (args.x?.meta?.authenticated === false ? -10 : 0));

  const blockers = [
    (chain.washRisk ?? 0) >= 75 ? "высокая доля wash-признаков в кошельках" : null,
    (chain.concentration ?? 0) >= 85 ? "оборот сконцентрирован у нескольких кошельков" : null,
    (chain.bundleRisk ?? 0) >= 70 ? "большая часть объёма похожа на синхронные bundle-кластеры" : null,
    (provenance.risk ?? 0) >= 70 ? "слабое происхождение нарратива: не хватает собственных публичных каналов" : null,
  ].filter((value): value is string => value != null);

  let action: UnifiedTradeScore["action"] = "insufficient";
  if (score == null && blockers.length === 0) action = "insufficient";
  else if (blockers.length > 0 || (risk ?? 0) >= 65) action = "avoid";
  else if ((score ?? 0) >= 70 && (risk ?? 100) <= 35 && confidence >= 60 && activeSources >= 2) action = "buy";
  else action = "wait";

  const title = {
    buy: "Покупать",
    wait: "Ждать",
    avoid: "Не покупать",
    insufficient: "Недостаточно данных",
  }[action];

  const reasonsFor = [
    chain.quality != null && chain.quality >= 60 ? `on-chain качество ${scoreText(chain.quality)}` : null,
    x.quality != null && x.quality >= 60 ? `X-сигнал ${scoreText(x.quality)}` : null,
    provenance.risk != null && provenance.risk <= 35 ? "публичные ссылки выглядят базово заполненными" : null,
  ].filter((value): value is string => value != null);

  const reasonsAgainst = [
    ...blockers,
    chain.risk != null && chain.risk >= 50 ? `on-chain риск ${scoreText(chain.risk)}` : null,
    x.risk != null && x.risk >= 50 ? `бот/накрутка в X ${scoreText(x.risk)}` : null,
    provenance.risk != null && provenance.risk >= 45 ? `provenance риск ${scoreText(provenance.risk)}` : null,
  ].filter((value): value is string => value != null);

  const oneLiner = action === "buy"
    ? `Оценка ${scoreText(score)} при риске ${scoreText(risk)}: сигнал можно брать только дисциплинированно.`
    : action === "avoid"
      ? `Покупать не стоит: ${reasonsAgainst[0] ?? `риск ${scoreText(risk)}`}.`
      : action === "wait"
        ? `Пока ждать: оценка ${scoreText(score)}, риск ${scoreText(risk)}, уверенность ${Math.round(confidence)}/100.`
        : "Нельзя честно решить: ключевые источники не прочитались.";

  return {
    score,
    risk,
    confidence: Math.round(confidence),
    action,
    title,
    oneLiner,
    reasonsFor,
    reasonsAgainst,
    missing,
    blockers,
    safeEntryThesis: buildSafeEntry(score, risk, confidence, missing),
    provenance,
    firstCall,
    sources: {
      chain: chain.available,
      x: x.available,
      telegramFirstCall: firstCall.available,
      provenance: provenance.available,
    },
  };
}
