import {
  clamp,
  numberOr,
  toTimestamp,
  type AiEnvelope,
  type ChainAnalysis,
  type Channel,
  type DerivedSocial,
  type Market,
  type SocialTimeline,
  type TwitterStats,
} from "./social-intelligence";

export type IntelligenceTone = "positive" | "negative" | "social" | "warning";

export type LiveIntelligenceSignal = {
  id: string;
  time: number;
  source: "x" | "telegram" | "chain" | "market";
  category: "influencer" | "smart-wallet" | "whale" | "telegram-call" | "risk";
  title: string;
  detail: string;
  impact: number;
  tone: IntelligenceTone;
  shortLabel: string;
};

export type PromoterRow = {
  name: string;
  messages: number;
  explicitCalls: number;
  followers: number | null;
  engagement: number;
  verified: boolean;
  sourceScore: number | null;
  winRate: number | null;
  rugRate: number | null;
  firstSeen: number | null;
  lastSeen: number | null;
  assessment: string;
};

export type WalletActor = {
  address: string;
  volumeSol: number;
  buys: number;
  sells: number;
  role: "smart" | "whale" | "fresh" | "wash" | "wallet";
  direction: "buying" | "selling" | "mixed";
  latestTradeAt: number | null;
};

export type SourceConclusion = {
  score: number;
  state: string;
  summary: string;
  facts: string[];
};

export type LiveIntelligenceModel = {
  tokenStrength: number;
  entryScore: number;
  riskScore: number;
  confidence: number;
  stability: number;
  entryStatus: string;
  verdict: string;
  summary: string;
  positiveFactors: string[];
  negativeFactors: string[];
  confirmationTriggers: string[];
  invalidationTriggers: string[];
  x: SourceConclusion & {
    mentions: number;
    uniqueAuthors: number;
    botRisk: number;
    suspiciousShare: number | null;
    promoters: PromoterRow[];
  };
  telegram: SourceConclusion & {
    messages: number;
    matchedBeforeLimit: number;
    highQualitySources: number;
    riskySources: number;
    promoters: PromoterRow[];
  };
  chain: SourceConclusion & {
    wallets: number;
    trades: number;
    smartBuyers: number;
    smartSellers: number;
    freshWallets: number;
    washWallets: number;
    bundles: number;
    actors: WalletActor[];
  };
  market: SourceConclusion & {
    changeH1: number | null;
    change24h: number | null;
    liquidityUsd: number | null;
    overextension: number;
  };
  crossSource: SourceConclusion;
  signals: LiveIntelligenceSignal[];
};

type BuildArgs = {
  x: TwitterStats | null;
  tg: SocialTimeline | null;
  market: Market | null;
  chain: ChainAnalysis | null;
  channels: Channel[];
  derived: DerivedSocial;
  ai: AiEnvelope | null;
  featureCoverage?: number | null;
  liveImpact?: number;
};

function norm(value: string | null | undefined) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ratePct(value: unknown): number | null {
  const parsed = finite(value);
  if (parsed == null) return null;
  return clamp(Math.abs(parsed) <= 1 ? parsed * 100 : parsed);
}

function shortAddress(value: string) {
  return value.length > 12 ? `${value.slice(0, 5)}…${value.slice(-4)}` : value;
}

function stddev(values: number[]) {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length);
}

function weighted(parts: Array<{ value: number | null; weight: number }>) {
  const available = parts.filter((part): part is { value: number; weight: number } => part.value != null);
  const total = available.reduce((sum, part) => sum + part.weight, 0);
  if (!total) return 0;
  return clamp(available.reduce((sum, part) => sum + clamp(part.value) * part.weight, 0) / total);
}

function latestTradeAt(chain: ChainAnalysis | null, address: string) {
  const rows = (chain?.trades || []).filter((trade) => norm(trade.w) === norm(address));
  let latest: number | null = null;
  for (const row of rows) {
    const timestamp = toTimestamp(row.ts);
    if (timestamp != null && (latest == null || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

function buildXPromoters(x: TwitterStats | null): PromoterRow[] {
  if (!x) return [];
  return (x.shillers || [])
    .map((row) => {
      const tweets = (x.topTweets || []).filter((tweet) => norm(tweet.author) === norm(row.handle));
      const times = tweets.map((tweet) => toTimestamp(tweet.timestamp)).filter((value): value is number => value != null);
      const suspicious = tweets.filter((tweet) => tweet.isSuspicious).length;
      const assessment = row.isBot
        ? "высокий бот-риск"
        : row.isVerified && (row.followers || 0) >= 50_000
          ? "крупный подтверждённый автор"
          : suspicious > 0
            ? "есть подозрительные публикации"
            : row.tweets >= 4
              ? "часто продвигает токен"
              : "обычный участник распространения";
      return {
        name: row.handle.startsWith("@") ? row.handle : `@${row.handle}`,
        messages: row.tweets,
        explicitCalls: 0,
        followers: row.followers,
        engagement: row.totalEngagement,
        verified: row.isVerified,
        sourceScore: null,
        winRate: null,
        rugRate: null,
        firstSeen: times.length ? Math.min(...times) : null,
        lastSeen: times.length ? Math.max(...times) : null,
        assessment,
      };
    })
    .sort((a, b) => {
      const reachA = (a.followers || 0) + a.engagement * 6 + (a.verified ? 50_000 : 0);
      const reachB = (b.followers || 0) + b.engagement * 6 + (b.verified ? 50_000 : 0);
      return reachB - reachA;
    })
    .slice(0, 6);
}

function buildTgPromoters(tg: SocialTimeline | null, channels: Channel[]): PromoterRow[] {
  if (!tg) return [];
  const byChannel = new Map(channels.map((channel) => [norm(channel.username || channel.title), channel]));
  const grouped = new Map<string, { name: string; messages: number; calls: number; times: number[] }>();
  for (const item of tg.timeline || []) {
    if (item.platform && item.platform.toLowerCase() !== "telegram") continue;
    const display = item.source_handle || item.source_name || "unknown";
    const key = norm(display);
    const current = grouped.get(key) || { name: display, messages: 0, calls: 0, times: [] };
    current.messages += 1;
    const eventType = String(item.event_type || "").toLowerCase();
    const metrics = item.metrics || {};
    if (eventType.includes("call") || metrics.explicit_call === true || metrics.is_call === true) current.calls += 1;
    const timestamp = toTimestamp(item.occurred_at);
    if (timestamp != null) current.times.push(timestamp);
    grouped.set(key, current);
  }
  return [...grouped.entries()]
    .map(([key, row]) => {
      const channel = byChannel.get(key);
      const winRate = ratePct(channel?.win_rate);
      const rugRate = ratePct(channel?.rug_rate);
      const assessment = channel && channel.score >= 75 && (rugRate ?? 0) < 25
        ? "качественный источник"
        : (rugRate ?? 0) >= 40
          ? "плохая rug-история"
          : row.calls > 0
            ? "даёт прямые calls"
            : "обсуждает токен";
      return {
        name: row.name.startsWith("@") || row.name === "unknown" ? row.name : `@${row.name}`,
        messages: row.messages,
        explicitCalls: row.calls,
        followers: null,
        engagement: 0,
        verified: false,
        sourceScore: channel?.score ?? null,
        winRate,
        rugRate,
        firstSeen: row.times.length ? Math.min(...row.times) : null,
        lastSeen: row.times.length ? Math.max(...row.times) : null,
        assessment,
      };
    })
    .sort((a, b) => (
      (b.explicitCalls * 15 + b.messages * 2 + (b.sourceScore || 0))
      - (a.explicitCalls * 15 + a.messages * 2 + (a.sourceScore || 0))
    ))
    .slice(0, 6);
}

function buildChainActors(chain: ChainAnalysis | null) {
  const wallets = chain?.wallets || [];
  const smart = wallets.filter((wallet) => wallet.smartClassificationAvailable && wallet.isSmart === true);
  const smartBuyers = smart.filter((wallet) => numberOr(wallet.buys) > numberOr(wallet.sells));
  const smartSellers = smart.filter((wallet) => numberOr(wallet.sells) > numberOr(wallet.buys));
  const freshWallets = wallets.filter((wallet) => wallet.freshnessVerified && wallet.isFresh === true);
  const washWallets = wallets.filter((wallet) => wallet.isWashTrader === true);
  const buyers = wallets.filter((wallet) => numberOr(wallet.buys) > numberOr(wallet.sells)).length;
  const sellers = wallets.filter((wallet) => numberOr(wallet.sells) > numberOr(wallet.buys)).length;
  const top = [...wallets].sort((a, b) => numberOr(b.volumeSol) - numberOr(a.volumeSol)).slice(0, 6);
  const actors: WalletActor[] = top.map((wallet) => {
    const buys = numberOr(wallet.buys);
    const sells = numberOr(wallet.sells);
    const role: WalletActor["role"] = wallet.isWashTrader
      ? "wash"
      : wallet.smartClassificationAvailable && wallet.isSmart
        ? "smart"
        : wallet.freshnessVerified && wallet.isFresh
          ? "fresh"
          : "whale";
    return {
      address: wallet.address,
      volumeSol: numberOr(wallet.volumeSol),
      buys,
      sells,
      role,
      direction: buys > sells ? "buying" : sells > buys ? "selling" : "mixed",
      latestTradeAt: latestTradeAt(chain, wallet.address),
    };
  });
  const smartBias = smart.length
    ? clamp(50 + ((smartBuyers.length - smartSellers.length) / Math.max(1, smart.length)) * 50)
    : 50;
  const buyerBias = wallets.length ? clamp((buyers / Math.max(1, buyers + sellers)) * 100) : 50;
  const washShare = wallets.length ? (washWallets.length / wallets.length) * 100 : 0;
  const bundleShare = wallets.length
    ? clamp(((chain?.bundles || []).reduce((sum, bundle) => sum + numberOr(bundle.size), 0) / wallets.length) * 100)
    : 0;
  const chainRisk = clamp(washShare * 2.2 + bundleShare * 0.7 + Math.max(0, 50 - buyerBias) * 0.55);
  const score = wallets.length
    ? weighted([
        { value: smartBias, weight: 0.38 },
        { value: buyerBias, weight: 0.27 },
        { value: 100 - chainRisk, weight: 0.35 },
      ])
    : 0;
  return {
    score,
    chainRisk,
    smartBuyers,
    smartSellers,
    freshWallets,
    washWallets,
    buyers,
    sellers,
    actors,
  };
}

function marketScore(market: Market | null) {
  const liquidity = finite(market?.pair?.liquidityUsd);
  const changeH1 = finite(market?.pair?.changeH1);
  const change24h = finite(market?.pair?.change24h);
  const liquidityScore = liquidity == null
    ? null
    : clamp((Math.log10(Math.max(1, liquidity)) - 3) * 25);
  const trendScore = changeH1 == null ? null : clamp(50 + changeH1 * 1.4);
  const score = weighted([
    { value: liquidityScore, weight: 0.58 },
    { value: trendScore, weight: 0.42 },
  ]);
  const runup1h = changeH1 == null ? 0 : Math.max(0, changeH1 - 12);
  const runup24h = change24h == null ? 0 : Math.max(0, change24h - 45) * 0.35;
  return {
    score,
    liquidity,
    changeH1,
    change24h,
    overextension: clamp(runup1h * 1.7 + runup24h),
  };
}

function buildSignals(
  x: TwitterStats | null,
  tgPromoters: PromoterRow[],
  chain: ChainAnalysis | null,
  chainActors: WalletActor[],
): LiveIntelligenceSignal[] {
  const signals: LiveIntelligenceSignal[] = [];
  const xPromoters = buildXPromoters(x);
  for (const promoter of xPromoters.slice(0, 2)) {
    const influential = (promoter.followers || 0) >= 50_000 || promoter.verified;
    if (!influential || promoter.lastSeen == null) continue;
    const impact = clamp(1.7 + Math.log10(Math.max(10, promoter.followers || 10_000)) * 0.35 + Math.min(1.2, promoter.engagement / 20_000), 1.8, 4.2);
    signals.push({
      id: `x-${norm(promoter.name)}-${promoter.lastSeen}`,
      time: promoter.lastSeen,
      source: "x",
      category: "influencer",
      title: `${promoter.name} упомянул токен`,
      detail: `${promoter.followers ? `${promoter.followers.toLocaleString("ru-RU")} подписчиков · ` : ""}${promoter.assessment}`,
      impact,
      tone: "social",
      shortLabel: `X +${impact.toFixed(1)}`,
    });
  }
  for (const promoter of tgPromoters.filter((row) => (row.sourceScore || 0) >= 70 && row.explicitCalls > 0).slice(0, 2)) {
    if (promoter.lastSeen == null) continue;
    const impact = clamp(1.4 + (promoter.sourceScore || 0) / 100 + promoter.explicitCalls * 0.25, 1.5, 3.4);
    signals.push({
      id: `tg-${norm(promoter.name)}-${promoter.lastSeen}`,
      time: promoter.lastSeen,
      source: "telegram",
      category: "telegram-call",
      title: `Сильный Telegram-call: ${promoter.name}`,
      detail: `Рейтинг источника ${Math.round(promoter.sourceScore || 0)}/100 · calls ${promoter.explicitCalls}`,
      impact,
      tone: "social",
      shortLabel: `TG +${impact.toFixed(1)}`,
    });
  }
  for (const actor of chainActors.filter((row) => row.role === "smart" && row.direction === "buying").slice(0, 2)) {
    if (actor.latestTradeAt == null) continue;
    const impact = clamp(1.8 + Math.log10(Math.max(1, actor.volumeSol + 1)), 1.8, 4.2);
    signals.push({
      id: `smart-${actor.address}-${actor.latestTradeAt}`,
      time: actor.latestTradeAt,
      source: "chain",
      category: "smart-wallet",
      title: `Smart-wallet ${shortAddress(actor.address)} набирает позицию`,
      detail: `${actor.buys} покупок / ${actor.sells} продаж · объём ${actor.volumeSol.toFixed(1)} SOL`,
      impact,
      tone: "positive",
      shortLabel: `SMART +${impact.toFixed(1)}`,
    });
  }
  const whaleSeller = chainActors.find((row) => row.role !== "wash" && row.direction === "selling" && row.volumeSol >= 10);
  if (whaleSeller?.latestTradeAt) {
    const impact = -clamp(2.2 + Math.log10(Math.max(1, whaleSeller.volumeSol)), 2.4, 5);
    signals.push({
      id: `whale-${whaleSeller.address}-${whaleSeller.latestTradeAt}`,
      time: whaleSeller.latestTradeAt,
      source: "chain",
      category: "whale",
      title: `Крупный кошелёк ${shortAddress(whaleSeller.address)} продаёт`,
      detail: `${whaleSeller.buys} покупок / ${whaleSeller.sells} продаж · объём ${whaleSeller.volumeSol.toFixed(1)} SOL`,
      impact,
      tone: "negative",
      shortLabel: `WHALE ${impact.toFixed(1)}`,
    });
  }
  const washActor = chainActors.find((row) => row.role === "wash" && row.latestTradeAt != null);
  if (washActor?.latestTradeAt) {
    signals.push({
      id: `wash-${washActor.address}-${washActor.latestTradeAt}`,
      time: washActor.latestTradeAt,
      source: "chain",
      category: "risk",
      title: `Wash-признаки: ${shortAddress(washActor.address)}`,
      detail: "Кошелёк участвует в торговле с подтверждёнными wash-признаками.",
      impact: -2.5,
      tone: "warning",
      shortLabel: "WASH -2.5",
    });
  }
  return signals.sort((a, b) => a.time - b.time).slice(-8);
}

export function buildLiveIntelligence(args: BuildArgs): LiveIntelligenceModel {
  const { x, tg, market, chain, channels, derived, ai } = args;
  const xPromoters = buildXPromoters(x);
  const tgPromoters = buildTgPromoters(tg, channels);
  const chainData = buildChainActors(chain);
  const marketData = marketScore(market);

  const xTotal = x?.riskUniverse?.totalTweets ?? x?.totalTweets ?? 0;
  const xSuspicious = x?.riskUniverse?.suspiciousTweets;
  const suspiciousShare = xTotal > 0 && xSuspicious != null ? clamp((xSuspicious / xTotal) * 100) : null;
  const uniqueAuthors = x?.riskUniverse?.uniqueAuthors ?? x?.uniqueMentioners ?? 0;
  const botRisk = clamp(x?.riskUniverse?.botRiskScore ?? x?.botRiskScore ?? 0);
  const xConcentration = xTotal > 0 ? clamp((Math.max(0, xPromoters[0]?.messages || 0) / xTotal) * 100) : 0;
  const xState = !x
    ? "данные недоступны"
    : botRisk >= 55
      ? "внимание растёт, но бот-риск высокий"
      : xConcentration >= 35
        ? "интерес сосредоточен вокруг узкой группы промо-аккаунтов"
        : derived.xScore >= 70
          ? "сообщество ускоряется и выглядит относительно органично"
          : "распространение смешанное";
  const xSummary = !x
    ? "X сейчас не участвует в выводе: данные источника не пришли."
    : `${uniqueAuthors} уникальных авторов при ${xTotal} упоминаниях. ${xState}. ${ai?.result?.campaignHypothesis?.narrative || ""}`.trim();

  const tgMessages = (tg?.timeline || []).filter((item) => !item.platform || item.platform.toLowerCase() === "telegram").length;
  const tgMatched = tg?.meta?.matchedBeforeLimit ?? tg?.mentions ?? 0;
  const highQualitySources = tgPromoters.filter((row) => (row.sourceScore || 0) >= 70 && (row.rugRate ?? 0) < 35).length;
  const riskySources = tgPromoters.filter((row) => (row.rugRate ?? 0) >= 40 || (row.sourceScore ?? 100) < 35).length;
  const tgState = !tg
    ? "данные недоступны"
    : highQualitySources >= 2 && derived.tgScore >= 65
      ? "несколько качественных каналов подтверждают сигнал"
      : riskySources > highQualitySources
        ? "обсуждение есть, но качество источников слабое"
        : "сигнал смешанный";
  const tgSummary = !tg
    ? "Telegram сейчас не участвует в выводе."
    : `${tgMessages} сообщений в текущей выборке, ${tgMatched} совпадений до лимита. ${tgState}.`;

  const smartBuyers = chainData.smartBuyers.length;
  const smartSellers = chainData.smartSellers.length;
  const chainState = !chain
    ? "данные блокчейна недоступны"
    : chainData.washWallets.length > 0
      ? `есть wash-признаки у ${chainData.washWallets.length} кошельков`
      : smartBuyers > smartSellers
        ? "smart-money чаще набирают, чем разгружают"
        : smartSellers > smartBuyers
          ? "smart-money чаще сокращают позиции"
          : "явного перевеса smart-money нет";
  const chainSummary = !chain
    ? "On-chain источник ещё не загрузился."
    : `${chain?.wallets?.length || 0} кошельков и ${chain?.trades?.length || chain?.summary?.totalTrades || 0} трейдов. ${chainState}.`;

  const marketState = !market?.pair
    ? "рыночные данные недоступны"
    : marketData.overextension >= 45
      ? "цена уже сильно растянута относительно краткосрочного движения"
      : marketData.changeH1 != null && marketData.changeH1 > 0
        ? "краткосрочный рынок поддерживает движение"
        : "цена не даёт сильного подтверждения";
  const marketSummary = !market?.pair
    ? "Market не участвует в расчёте уверенности."
    : `${marketState}. Ликвидность ${marketData.liquidity == null ? "неизвестна" : `$${Math.round(marketData.liquidity).toLocaleString("ru-RU")}`}.`;

  const crossScores = [
    x ? derived.xScore : null,
    tg ? derived.tgScore : null,
    chain ? chainData.score : null,
    market?.pair ? marketData.score : null,
  ].filter((value): value is number => value != null);
  const disagreement = stddev(crossScores);
  const stability = clamp(100 - disagreement * 2.1 - (market?.meta?.stale ? 12 : 0));
  const crossState = disagreement >= 18
    ? "источники заметно расходятся"
    : disagreement >= 10
      ? "есть умеренное расхождение между источниками"
      : "основные источники подтверждают друг друга";
  const crossSummary = `${crossState}. Cross-platform score ${Math.round(derived.socialScore)}/100; median lead/lag ${derived.price.leadLagMinutes == null ? "—" : `${Math.abs(derived.price.leadLagMinutes).toFixed(1)} мин`}.`;

  const tokenStrengthBase = weighted([
    { value: x || tg ? derived.socialScore : null, weight: 0.24 },
    { value: x || tg ? derived.alpha : null, weight: 0.18 },
    { value: chain ? chainData.score : null, weight: 0.34 },
    { value: market?.pair ? marketData.score : null, weight: 0.24 },
  ]);
  const liveImpact = clamp(numberOr(args.liveImpact), -10, 10);
  const tokenStrength = clamp(tokenStrengthBase + liveImpact * 0.45);
  const riskScore = weighted([
    { value: x || tg ? derived.socialRisk : null, weight: 0.38 },
    { value: x || tg ? derived.manipulation : null, weight: 0.22 },
    { value: chain ? chainData.chainRisk : null, weight: 0.28 },
    { value: market?.pair ? marketData.overextension : null, weight: 0.12 },
  ]);

  const sourceCoverage = (x ? 0.2 : 0) + (tg ? 0.2 : 0) + (chain ? 0.3 : 0) + (market?.pair ? 0.15 : 0) + (ai?.available ? 0.15 : 0);
  const featureCoverage = args.featureCoverage == null ? sourceCoverage : clamp(args.featureCoverage * 100) / 100;
  const aiConfidence = ai?.result?.overallConfidence != null ? clamp(ai.result.overallConfidence * 100) : null;
  const confidence = clamp(
    sourceCoverage * 72
    + featureCoverage * 18
    + (aiConfidence == null ? 8 : aiConfidence * 0.1)
    - (chain?.truncated || chain?.summary?.historyTruncated ? 8 : 0)
    - (market?.meta?.stale ? 6 : 0),
  );

  const whaleSellerCount = chainData.actors.filter((actor) => actor.role === "whale" && actor.direction === "selling").length;
  const sellerPenalty = whaleSellerCount * 4 + Math.max(0, smartSellers - smartBuyers) * 5;
  const entryScore = clamp(
    tokenStrength * 0.44
    + derived.early * 0.14
    + derived.organic * 0.10
    + chainData.score * 0.12
    + (100 - riskScore) * 0.20
    - marketData.overextension * 0.34
    - sellerPenalty
    + liveImpact * 0.55,
  );
  const entryStatus = entryScore >= 78
    ? "Сильный вход"
    : entryScore >= 64
      ? "Можно рассматривать"
      : entryScore >= 50
        ? "Ждать подтверждения"
        : entryScore >= 35
          ? "Поздний / слабый вход"
          : "Избегать входа";

  const positives: string[] = [];
  const negatives: string[] = [];
  if (smartBuyers > smartSellers && smartBuyers > 0) positives.push(`Smart-money покупают: ${smartBuyers} против ${smartSellers} продавцов.`);
  if (highQualitySources >= 2) positives.push(`Telegram подтверждают ${highQualitySources} качественных источника.`);
  if (derived.organic >= 65) positives.push(`Социальное распространение выглядит относительно органичным: ${Math.round(derived.organic)}/100.`);
  if (derived.xScore >= 70 && botRisk < 40) positives.push(`X сильный без критичного бот-риска: ${Math.round(derived.xScore)}/100.`);
  if (marketData.overextension >= 35) negatives.push("Цена уже заметно растянута — качество нового входа снижается.");
  if (smartSellers > smartBuyers && smartSellers > 0) negatives.push(`Smart-money чаще продают: ${smartSellers} против ${smartBuyers} покупателей.`);
  if (chainData.washWallets.length > 0) negatives.push(`Wash-признаки обнаружены у ${chainData.washWallets.length} кошельков.`);
  if (botRisk >= 50) negatives.push(`Высокий бот-риск в X: ${Math.round(botRisk)}/100.`);
  if (derived.manipulation >= 55) negatives.push(`Высокий риск промо/координации: ${Math.round(derived.manipulation)}/100.`);
  if (riskySources > 0) negatives.push(`В Telegram есть ${riskySources} источника с плохой историей/низким рейтингом.`);

  const verdict = riskScore >= 72
    ? "Высокий риск — позитивные сигналы не компенсируют качество структуры"
    : tokenStrength >= 70 && entryScore < 55
      ? "Монета выглядит сильнее среднего, но текущий вход уже хуже самой структуры"
      : tokenStrength >= 70 && entryScore >= 64
        ? "Структура сильная, а момент входа пока подтверждается несколькими источниками"
        : tokenStrength >= 55
          ? "Структура смешанная: нужен дополнительный триггер перед входом"
          : "Структура слабая — подтверждений недостаточно";
  const summary = `${verdict}. Сила монеты ${Math.round(tokenStrength)}/100, качество входа ${Math.round(entryScore)}/100, риск ${Math.round(riskScore)}/100, уверенность ${Math.round(confidence)}%.`;

  return {
    tokenStrength,
    entryScore,
    riskScore,
    confidence,
    stability,
    entryStatus,
    verdict,
    summary,
    positiveFactors: positives.slice(0, 5),
    negativeFactors: negatives.slice(0, 5),
    confirmationTriggers: [
      "Smart-wallet net-flow остаётся положительным или усиливается.",
      "Цена подтверждает социальный импульс без ухудшения ликвидности.",
      "Новые X/TG источники остаются независимыми, а copy/bot risk не ускоряется.",
    ],
    invalidationTriggers: [
      "Smart-money разворачиваются в продажи или крупные holders начинают разгрузку.",
      "Ликвидность резко падает на растущем объёме.",
      "Wash/bundle/coordination risk растёт быстрее органического охвата.",
    ],
    x: {
      score: x ? derived.xScore : 0,
      state: xState,
      summary: xSummary,
      facts: [
        `${xTotal} упоминаний · ${uniqueAuthors} уникальных авторов`,
        `бот-риск ${Math.round(botRisk)}/100`,
        `крупнейший промо-источник: ${xPromoters[0]?.name || "—"}`,
      ],
      mentions: xTotal,
      uniqueAuthors,
      botRisk,
      suspiciousShare,
      promoters: xPromoters,
    },
    telegram: {
      score: tg ? derived.tgScore : 0,
      state: tgState,
      summary: tgSummary,
      facts: [
        `${tgMessages} сообщений · ${tgMatched} совпадений до лимита`,
        `${highQualitySources} качественных · ${riskySources} рискованных источников`,
        `первый сильный источник: ${tgPromoters[0]?.name || "—"}`,
      ],
      messages: tgMessages,
      matchedBeforeLimit: tgMatched,
      highQualitySources,
      riskySources,
      promoters: tgPromoters,
    },
    chain: {
      score: chain ? chainData.score : 0,
      state: chainState,
      summary: chainSummary,
      facts: [
        `${smartBuyers} smart-buyers · ${smartSellers} smart-sellers`,
        `${chainData.freshWallets.length} fresh · ${chainData.washWallets.length} wash`,
        `${chain?.bundles?.length || 0} bundle/buy-кластеров`,
      ],
      wallets: chain?.wallets?.length || chain?.summary?.uniqueWallets || 0,
      trades: chain?.trades?.length || chain?.summary?.totalTrades || 0,
      smartBuyers,
      smartSellers,
      freshWallets: chainData.freshWallets.length,
      washWallets: chainData.washWallets.length,
      bundles: chain?.bundles?.length || 0,
      actors: chainData.actors,
    },
    market: {
      score: market?.pair ? marketData.score : 0,
      state: marketState,
      summary: marketSummary,
      facts: [
        `1ч: ${marketData.changeH1 == null ? "—" : `${marketData.changeH1 >= 0 ? "+" : ""}${marketData.changeH1.toFixed(1)}%`}`,
        `24ч: ${marketData.change24h == null ? "—" : `${marketData.change24h >= 0 ? "+" : ""}${marketData.change24h.toFixed(1)}%`}`,
        `overextension ${Math.round(marketData.overextension)}/100`,
      ],
      changeH1: marketData.changeH1,
      change24h: marketData.change24h,
      liquidityUsd: marketData.liquidity,
      overextension: marketData.overextension,
    },
    crossSource: {
      score: stability,
      state: crossState,
      summary: crossSummary,
      facts: [
        `согласованность ${Math.round(stability)}/100`,
        `social ${Math.round(derived.socialScore)}/100 · chain ${Math.round(chainData.score)}/100 · market ${Math.round(marketData.score)}/100`,
        `AI: ${ai?.result?.summary || "нет отдельного AI-вывода"}`,
      ],
    },
    signals: buildSignals(x, tgPromoters, chain, chainData.actors),
  };
}
