import type { TwitterStats } from "@/app/api/trade/dev-twitter/route";
import type { WalletRowData } from "@/components/trade/WalletRow";
import type { Channel, Market, SocialTimeline, TimelineItem } from "@/lib/trade/social-intelligence";

export type AnalysisChainInput = {
  mint: string;
  summary?: {
    totalVolumeSol?: number | null;
    totalTrades?: number | null;
    uniqueWallets?: number | null;
    historyTruncated?: boolean | null;
    totalRawTrades?: number | null;
    maxTradesRequested?: number | null;
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

export type TelegramFirstCallAssessment = {
  available: boolean;
  score: number | null;
  risk: number | null;
  notes: string[];
  firstSource: string | null;
  firstAt: string | null;
  minutesAfterPairCreation: number | null;
  explicit: boolean | null;
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
  provenance: { available: boolean; risk: number | null; notes: string[] };
  firstCall: TelegramFirstCallAssessment;
  sources: { chain: boolean; x: boolean; telegramFirstCall: boolean; provenance: boolean };
};

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));

function num(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRate(value: unknown) {
  const parsed = optionalNumber(value);
  return parsed == null ? null : clamp(Math.abs(parsed) <= 1 ? parsed * 100 : parsed);
}

function weighted(values: Array<{ value: number | null; weight: number }>) {
  const present = values.filter((item): item is { value: number; weight: number } => item.value != null);
  const totalWeight = present.reduce((sum, item) => sum + item.weight, 0);
  if (!totalWeight) return null;
  return clamp(present.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight);
}

const scoreText = (value: number | null) => value == null ? "—" : `${Math.round(value)}/100`;

function timestamp(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  let parsed = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 1e12) parsed *= 1000;
  return parsed;
}

const normalizeSource = (value: unknown) => String(value || "").trim().replace(/^@/, "").toLowerCase();

function isExplicitCall(item: TimelineItem) {
  const metrics = item.metrics || {};
  return Boolean(metrics.explicit_call || metrics.is_explicit_call)
    || String(item.event_type || "").toLowerCase().includes("call");
}

function deriveChain(chain: AnalysisChainInput | null) {
  const wallets = chain?.wallets ?? [];
  const bundles = chain?.bundles ?? [];
  const totalVolume = num(chain?.summary?.totalVolumeSol);
  const totalTrades = num(chain?.summary?.totalTrades);
  const topVolume = wallets
    .map((wallet) => Math.max(0, num(wallet.volumeSol)))
    .sort((a, b) => b - a)
    .slice(0, 5)
    .reduce((sum, value) => sum + value, 0);
  const concentration = totalVolume > 0 && wallets.length >= 4 ? clamp((topVolume / totalVolume) * 100) : null;
  const washRisk = wallets.length >= 3
    ? clamp((wallets.filter((wallet) => wallet.isWashTrader).length / wallets.length) * 100)
    : null;
  const bundleVolume = bundles.reduce((sum, bundle) => sum + Math.max(0, num(bundle.totalVolumeSol)), 0);
  const bundleRisk = totalVolume > 0 ? clamp((bundleVolume / totalVolume) * 100) : null;
  const buys = wallets.reduce((sum, wallet) => sum + Math.max(0, num(wallet.buys)), 0);
  const sells = wallets.reduce((sum, wallet) => sum + Math.max(0, num(wallet.sells)), 0);
  const sellability = buys + sells >= 20 ? clamp((sells / (buys + sells)) * 250) : null;

  // Unknown classifier output must stay unknown. Current stream only verifies freshness
  // for a bounded subset and does not provide a smart-wallet classifier yet.
  const verifiedFreshness = wallets.filter((wallet) => wallet.freshnessVerified === true);
  const freshRisk = verifiedFreshness.length >= 3
    ? clamp((verifiedFreshness.filter((wallet) => wallet.isFresh === true).length / verifiedFreshness.length) * 100)
    : null;
  const verifiedSmart = wallets.filter((wallet) => wallet.smartClassificationAvailable === true);
  const smartScore = verifiedSmart.length >= 3
    ? clamp((verifiedSmart.filter((wallet) => wallet.isSmart === true).length / verifiedSmart.length) * 300)
    : null;

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
  const truncationKnown = chain?.truncated != null || chain?.summary?.historyTruncated != null;
  return {
    available: wallets.length > 0 || totalTrades > 0,
    quality,
    risk,
    concentration,
    washRisk,
    bundleRisk,
    truncated: Boolean(chain?.truncated || chain?.summary?.historyTruncated),
    truncationKnown,
  };
}

function deriveX(x: TwitterStats | null) {
  if (!x || (x.totalTweets <= 0 && x.topTweets.length <= 0)) {
    return { available: false, quality: null, risk: null };
  }
  const botRisk = clamp(num(x.riskUniverse?.botRiskScore ?? x.botRiskScore));
  const authorDiffusion = x.totalTweets > 0 ? clamp((x.uniqueMentioners / x.totalTweets) * 100) : null;
  const engagement = x.totalViews > 0 ? clamp(((x.totalLikes + x.totalRetweets) / x.totalViews) * 1200) : null;
  const verified = x.uniqueMentioners > 0 ? clamp((num(x.aggregated?.verifiedAuthors) / x.uniqueMentioners) * 100) : null;
  return {
    available: true,
    quality: weighted([
      { value: 100 - botRisk, weight: 0.34 },
      { value: authorDiffusion, weight: 0.26 },
      { value: engagement, weight: 0.22 },
      { value: verified, weight: 0.18 },
    ]),
    risk: botRisk,
  };
}

function deriveProvenance(meta: TokenSocialMeta | null) {
  if (!meta) return { available: false, risk: null, notes: [] as string[] };
  const notes: string[] = [];
  const twitter = Boolean(meta.socials?.twitter);
  const telegram = Boolean(meta.socials?.telegram);
  const website = Boolean(meta.socials?.website);
  let risk = 20;
  if (!twitter) { risk += 25; notes.push("X-ссылка не найдена"); }
  if (!telegram) { risk += 20; notes.push("Telegram-ссылка не найдена"); }
  if (!website) { risk += 8; notes.push("сайт не найден"); }
  if (twitter && telegram) notes.push("есть заявленные X и Telegram");
  return { available: true, risk: clamp(risk), notes };
}

function deriveTelegramFirstCall(
  tg: SocialTimeline | null,
  channels: Channel[],
  market: Market | null,
): TelegramFirstCallAssessment {
  const rows = (tg?.timeline || [])
    .filter((item) => !item.platform || item.platform.toLowerCase() === "telegram")
    .map((item) => ({ item, time: timestamp(item.occurred_at) }))
    .filter((row): row is { item: TimelineItem; time: number } => row.time != null)
    .sort((a, b) => a.time - b.time);
  const first = rows[0] || null;
  if (!first) {
    return {
      available: false,
      score: null,
      risk: null,
      notes: [tg ? "Telegram найден, но нет сообщения с валидным временем" : "Telegram timeline недоступен"],
      firstSource: null,
      firstAt: null,
      minutesAfterPairCreation: null,
      explicit: null,
    };
  }

  const firstSource = first.item.source_handle || first.item.source_name || null;
  const sourceKey = normalizeSource(firstSource);
  const matchedChannel = channels.find((channel) => {
    const username = normalizeSource(channel.username);
    const title = normalizeSource(channel.title);
    return Boolean(sourceKey && (sourceKey === username || sourceKey === title));
  }) || null;
  const pairCreatedAt = timestamp(market?.pair?.createdAt);
  const minutesAfterPairCreation = pairCreatedAt == null ? null : (first.time - pairCreatedAt) / 60_000;
  const earlyQuality = minutesAfterPairCreation == null
    ? null
    : minutesAfterPairCreation < -5
      ? 55
      : clamp(100 - (Math.max(0, minutesAfterPairCreation) / 180) * 100);
  const channelScore = matchedChannel ? clamp(num(matchedChannel.score)) : null;
  const winRate = matchedChannel ? normalizeRate(matchedChannel.win_rate) : null;
  const rugRate = matchedChannel ? normalizeRate(matchedChannel.rug_rate) : null;
  const explicit = isExplicitCall(first.item);
  const mentions = num(
    tg?.meta?.matchedPlatforms?.telegram
      ?? tg?.meta?.matchedBeforeLimit
      ?? tg?.platforms?.telegram
      ?? rows.length,
  );
  const sourceCount = num(
    tg?.meta?.uniqueSourcesBeforeLimit,
    new Set(rows.map((row) => normalizeSource(row.item.source_handle || row.item.source_name)).filter(Boolean)).size,
  );
  const diffusion = mentions > 0 ? clamp((sourceCount / mentions) * 250) : null;
  const rawQuality = weighted([
    { value: earlyQuality, weight: 0.34 },
    { value: channelScore, weight: 0.24 },
    { value: winRate, weight: 0.14 },
    { value: rugRate == null ? null : 100 - rugRate, weight: 0.14 },
    { value: explicit ? 100 : 45, weight: 0.09 },
    { value: diffusion, weight: 0.05 },
  ]);
  // With a truncated result set, the earliest returned row may not be the true first call.
  // Keep it usable as evidence, but cap how strongly it can improve the verdict.
  const quality = rawQuality == null
    ? null
    : tg?.meta?.truncated
      ? Math.min(75, rawQuality * 0.85)
      : rawQuality;

  const notes: string[] = [
    `${explicit ? "первый явный call" : "первое упоминание"}: ${firstSource ? `@${String(firstSource).replace(/^@/, "")}` : "неизвестный канал"}`,
  ];
  if (minutesAfterPairCreation == null) notes.push("время создания пары недоступно — early-score ограничен");
  else if (minutesAfterPairCreation < -5) notes.push(`сигнал на ${Math.round(Math.abs(minutesAfterPairCreation))} мин раньше pair.createdAt — тайминг требует проверки`);
  else notes.push(`${Math.max(0, Math.round(minutesAfterPairCreation))} мин после создания пары`);
  if (matchedChannel) {
    const reputation = [`score ${Math.round(channelScore ?? 0)}/100`];
    if (winRate != null) reputation.push(`win ${Math.round(winRate)}%`);
    if (rugRate != null) reputation.push(`rug ${Math.round(rugRate)}%`);
    notes.push(`репутация канала: ${reputation.join(" · ")}`);
  } else {
    notes.push("для первого канала нет накопленной репутации");
  }
  if (tg?.meta?.truncated) {
    notes.push("Telegram выборка усечена: источник считается первым только в возвращённой выборке, score понижен");
  }

  return {
    available: true,
    score: quality,
    risk: quality == null ? null : 100 - quality,
    notes,
    firstSource,
    firstAt: new Date(first.time).toISOString(),
    minutesAfterPairCreation,
    explicit,
  };
}

function buildSafeEntry(score: number | null, risk: number | null, confidence: number, missing: string[]) {
  if (score == null) return "Вход не подтверждён: сначала нужны данные хотя бы по on-chain или X/TG.";
  if ((risk ?? 0) >= 65) return "Безопасный вход отсутствует: риск выше допустимого, лучше ждать нового независимого подтверждения и снижения красных флагов.";
  if (score >= 70 && (risk ?? 100) <= 35 && confidence >= 60) {
    return "Допустим только малый тестовый вход: тезис держится, пока нет новых bundle/wash сигналов и цена не ушла резко выше первой зоны интереса.";
  }
  if (missing.length) {
    return `Сейчас лучше ждать: не хватает ${missing.join(", ")}, поэтому текущий вход нельзя считать полностью подтверждённым.`;
  }
  return "Можно только наблюдать или заходить минимально: нужен новый независимый факт, который улучшит риск/доходность.";
}

export function buildTradeAnalysisScore(args: {
  chain: AnalysisChainInput | null;
  x: TwitterStats | null;
  meta: TokenSocialMeta | null;
  tg?: SocialTimeline | null;
  channels?: Channel[];
  market?: Market | null;
}): UnifiedTradeScore {
  const chain = deriveChain(args.chain);
  const x = deriveX(args.x);
  const provenance = deriveProvenance(args.meta);
  const firstCall = deriveTelegramFirstCall(args.tg ?? null, args.channels ?? [], args.market ?? null);
  const missing = [
    !chain.available ? "on-chain" : null,
    !x.available ? "X" : null,
    !firstCall.available ? "TG first-call" : null,
    !provenance.available ? "provenance" : null,
  ].filter((value): value is string => value != null);

  const score = weighted([
    { value: chain.quality, weight: 0.46 },
    { value: x.quality, weight: 0.22 },
    { value: provenance.risk == null ? null : 100 - provenance.risk, weight: 0.16 },
    { value: firstCall.score, weight: 0.16 },
  ]);
  const risk = weighted([
    { value: chain.risk, weight: 0.42 },
    { value: x.risk, weight: 0.18 },
    { value: provenance.risk, weight: 0.2 },
    { value: firstCall.risk, weight: 0.2 },
  ]);
  const activeSources = Number(chain.available) + Number(x.available) + Number(provenance.available) + Number(firstCall.available);
  const completenessBonus = chain.available && chain.truncationKnown && !chain.truncated ? 15 : 0;
  const chainTruncationPenalty = chain.truncated ? -10 : 0;
  const xTruncationPenalty = args.x?.collectionTruncated || args.x?.meta?.truncated ? -5 : 0;
  const tgTruncationPenalty = args.tg?.meta?.truncated ? -5 : 0;
  const confidence = clamp(activeSources * 20 + completenessBonus + chainTruncationPenalty + xTruncationPenalty + tgTruncationPenalty);

  const blockers = [
    (chain.washRisk ?? 0) >= 75 ? "высокая доля wash-признаков в кошельках" : null,
    (chain.concentration ?? 0) >= 85 ? "оборот сконцентрирован у нескольких кошельков" : null,
    (chain.bundleRisk ?? 0) >= 70 ? "большая часть объёма похожа на синхронные bundle-кластеры" : null,
    (provenance.risk ?? 0) >= 70 ? "слабое происхождение нарратива: не хватает собственных публичных каналов" : null,
    (firstCall.risk ?? 0) >= 78 ? "первый Telegram-сигнал слабый или высокорисковый" : null,
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
    firstCall.score != null && firstCall.score >= 65 ? `TG first-call ${scoreText(firstCall.score)}` : null,
    provenance.risk != null && provenance.risk <= 35 ? "публичные ссылки выглядят базово заполненными" : null,
  ].filter((value): value is string => value != null);
  const reasonsAgainst = [
    ...blockers,
    chain.risk != null && chain.risk >= 50 ? `on-chain риск ${scoreText(chain.risk)}` : null,
    x.risk != null && x.risk >= 50 ? `бот/накрутка в X ${scoreText(x.risk)}` : null,
    firstCall.risk != null && firstCall.risk >= 55 ? `TG first-call риск ${scoreText(firstCall.risk)}` : null,
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
