/**
 * Полный блокчейн-анализ: контракт safety, ликвидность с лестницей slippage,
 * холдеры в динамике, dev-поведение, кластеры (bundles/snipers/wash/smart),
 * лента событий и provenance. Чистые_evaluator'ы + сборка групп метрик для digest
 * и chain-полей для verdict-движка (который передаёт их ИИ).
 */
import type { ChainQualityAnalytics } from './quality';
import type { LargestAccount } from './provider';

export type SafetyCheck = {
  id: string;
  status: "ok" | "warn" | "fail" | "unknown";
  note?: string;
};

export type StampedCheck = SafetyCheck & { source: string; fetchedAt: number };

export type HolderPoint = { ts: number; holders: number; top10Pct: number };

export type LiquidityDepth = {
  liquidityUsd: number | null;
  volLiqRatio: number | null;
  /** slippage продажи 1/5/10% supply, % */
  slippage: { pct1: number | null; pct5: number | null; pct10: number | null };
  lpConcentrationPct: number | null;
};

export type DevBehavior = {
  wallets: string[];
  remainingPct: number | null;
  realizedPnlSol: number | null;
  cexDeposits: Array<{ ts: number; wallet: string; sol: number }>;
  lastActivityTs: number | null;
};

export type ClusterInfo = {
  bundles: number | null;
  walletSharePct: number | null;
  sniperCount: number | null;
  washSharePct: number | null;
  smartInflowSol: number | null;
};

export type ChainEventKind =
  | 'pool_created' | 'mint_revoked' | 'freeze_revoked' | 'lp_burned' | 'lp_locked'
  | 'migration' | 'large_swap' | 'cex_deposit';

export type ChainEvent = { ts: number; kind: ChainEventKind; note?: string; tx?: string };

export type ChainFull = {
  mint: string;
  asOf: number;
  checks: StampedCheck[];
  largestAccounts: LargestAccount[];
  holders: HolderPoint[];
  liquidity: LiquidityDepth;
  dev: DevBehavior;
  clusters: ClusterInfo;
  events: ChainEvent[];
  quality: ChainQualityAnalytics | null;
  truncated: boolean;
  sources: string[];
};

export type SafetyFacts = {
  /** undefined = провайдер не ответил (статус unknown), null = authority отозван (ok), строка = active (fail). */
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  lpLockedPct: number | null;
  lpBurnedPct: number | null;
  honeypotSellOk: boolean | null;
  transferTaxPct: number | null;
  upgradeable: boolean | null;
  permanentDelegate?: string | null;
  transferHookProgramId?: string | null;
  defaultAccountState?: string | null;
  nonTransferable?: boolean | null;
};

export type SafetySourceMap = Partial<Record<
  'mint_authority' | 'freeze_authority' | 'lp_lock' | 'honeypot' | 'tax' | 'proxy' |
  'permanent_delegate' | 'transfer_hook' | 'default_frozen' | 'non_transferable', string
>>;

/** Детерминированные safety-чеки контракта с полевым provenance и временем. */
export function evaluateSafety(f: SafetyFacts, source: string | SafetySourceMap, fetchedAt: number): StampedCheck[] {
  const out: StampedCheck[] = [];
  const sourceFor = (id: SafetyCheck['id']) => typeof source === 'string' ? source : source[id as keyof SafetySourceMap] ?? 'unavailable';
  const push = (id: SafetyCheck['id'], status: SafetyCheck['status'], note?: string) =>
    out.push({ id, status, note, source: sourceFor(id), fetchedAt });
  push('mint_authority', f.mintAuthority === null ? 'ok' : f.mintAuthority === undefined ? 'unknown' : 'fail',
    f.mintAuthority === null ? 'revoked' : f.mintAuthority ? `active: ${f.mintAuthority.slice(0, 8)}…` : undefined);
  push('freeze_authority', f.freezeAuthority === null ? 'ok' : f.freezeAuthority === undefined ? 'unknown' : 'fail',
    f.freezeAuthority === null ? 'revoked' : undefined);
  const lpTotal = (f.lpLockedPct ?? 0) + (f.lpBurnedPct ?? 0);
  if (f.lpLockedPct == null && f.lpBurnedPct == null) push('lp_lock', 'unknown');
  else if (lpTotal >= 90) push('lp_lock', 'ok', `${Math.round(lpTotal)}% burned+locked`);
  else if (lpTotal >= 50) push('lp_lock', 'warn', `только ${Math.round(lpTotal)}% burned+locked`);
  else push('lp_lock', 'fail', `burned+locked ${Math.round(lpTotal)}%`);
  push('honeypot', f.honeypotSellOk == null ? 'unknown' : f.honeypotSellOk ? 'ok' : 'fail',
    f.honeypotSellOk === false ? 'sell-симуляция ревертится' : undefined);
  push('tax', f.transferTaxPct == null ? 'unknown' : f.transferTaxPct <= 1 ? 'ok' : f.transferTaxPct <= 5 ? 'warn' : 'fail',
    f.transferTaxPct != null ? `transfer tax ${f.transferTaxPct}%` : undefined);
  push('proxy', f.upgradeable == null ? 'unknown' : f.upgradeable ? 'warn' : 'ok',
    f.upgradeable ? 'upgradeable proxy' : undefined);
  push('permanent_delegate', f.permanentDelegate === undefined ? 'unknown' : f.permanentDelegate === null ? 'ok' : 'warn',
    f.permanentDelegate ? `delegate: ${f.permanentDelegate.slice(0, 8)}…` : undefined);
  push('transfer_hook', f.transferHookProgramId === undefined ? 'unknown' : f.transferHookProgramId === null ? 'ok' : 'warn',
    f.transferHookProgramId ? `hook: ${f.transferHookProgramId.slice(0, 8)}…` : undefined);
  push('default_frozen', f.defaultAccountState === undefined ? 'unknown' : f.defaultAccountState === null ? 'ok' : f.defaultAccountState.toLowerCase() === 'frozen' ? 'fail' : 'ok',
    f.defaultAccountState ?? undefined);
  push('non_transferable', f.nonTransferable === undefined ? 'unknown' : f.nonTransferable ? 'fail' : 'ok',
    f.nonTransferable ? 'Token-2022 non-transferable extension' : undefined);
  return out;
}

/** Constant-product slippage: продажа q токенов из резерва R даёт slippage q/(R+q). */
export function slippageLadder(reserveTokens: number | null, supply: number | null): LiquidityDepth['slippage'] {
  if (!reserveTokens || !supply || reserveTokens <= 0 || supply <= 0) return { pct1: null, pct5: null, pct10: null };
  const at = (pct: number) => {
    const q = (pct / 100) * supply;
    return (q / (reserveTokens + q)) * 100;
  };
  return { pct1: at(1), pct5: at(5), pct10: at(10) };
}

/** Дрейф холдеров и концентрации top-10 за окно (п.п. / %). */
export function concentrationDrift(series: HolderPoint[], windowMs = 86_400_000): { holdersDrift: number | null; top10Drift: number | null } {
  if (series.length < 2) return { holdersDrift: null, top10Drift: null };
  const sorted = [...series].sort((a, b) => a.ts - b.ts);
  const last = sorted[sorted.length - 1];
  const cutoff = last.ts - windowMs;
  const base = sorted.filter((p) => p.ts <= cutoff).pop() ?? sorted[0];
  if (base.ts === last.ts) return { holdersDrift: null, top10Drift: null };
  const holdersDrift = base.holders > 0 ? ((last.holders - base.holders) / base.holders) * 100 : null;
  const top10Drift = last.top10Pct - base.top10Pct;
  return { holdersDrift, top10Drift };
}

export type MetricRow = { label: string; value: string; note?: string };
export type MetricGroupOut = { title: string; rows: MetricRow[] };

const pct = (v: number | null, digits = 1) => (v == null ? '—' : `${v.toFixed(digits)}%`);
const num = (v: number | null, digits = 0) => (v == null ? '—' : v.toFixed(digits));

/** Группы метрик блокчейн-блока — вход для digest ИИ и для UI-панели. */
export function buildChainGroups(full: ChainFull, drift: ReturnType<typeof concentrationDrift>): MetricGroupOut[] {
  const checkValue = (id: string) => full.checks.find((c) => c.id === id);
  const st = (id: string) => {
    const c = checkValue(id);
    if (!c || c.status === 'unknown') return '—';
    return c.status === 'ok' ? 'ok' : c.status === 'warn' ? 'warn' : 'fail';
  };
  const lp = full.checks.find((c) => c.id === 'lp_lock');
  const lpPct = lp?.note ? Number.parseFloat(lp.note.replace(/[^\d.]/g, '')) : null;
  return [
    {
      title: 'Chain safety',
      rows: [
        { label: 'mint authority', value: st('mint_authority'), note: checkValue('mint_authority')?.note },
        { label: 'freeze authority', value: st('freeze_authority') },
        { label: 'LP locked', value: pct(lpPct), note: lp?.note },
        { label: 'honeypot', value: st('honeypot'), note: checkValue('honeypot')?.note },
        { label: 'tax', value: st('tax'), note: checkValue('tax')?.note },
        { label: 'proxy', value: st('proxy'), note: checkValue('proxy')?.note },
        { label: 'permanent delegate', value: st('permanent_delegate'), note: checkValue('permanent_delegate')?.note },
        { label: 'transfer hook', value: st('transfer_hook'), note: checkValue('transfer_hook')?.note },
        { label: 'default frozen', value: st('default_frozen'), note: checkValue('default_frozen')?.note },
        { label: 'non-transferable', value: st('non_transferable'), note: checkValue('non_transferable')?.note },
      ],
    },
    {
      title: 'Chain liquidity',
      rows: [
        { label: 'liquidity usd', value: full.liquidity.liquidityUsd == null ? '—' : `$${Math.round(full.liquidity.liquidityUsd).toLocaleString('en-US')}` },
        { label: 'slippage 1%', value: pct(full.liquidity.slippage.pct1, 2) },
        { label: 'slippage 5%', value: pct(full.liquidity.slippage.pct5, 2) },
        { label: 'slippage 10%', value: pct(full.liquidity.slippage.pct10, 2) },
        { label: 'vol/liq', value: num(full.liquidity.volLiqRatio, 2) },
        { label: 'LP concentration', value: pct(full.liquidity.lpConcentrationPct) },
      ],
    },
    {
      title: 'Chain holders',
      rows: [
        { label: 'holders now', value: full.holders.length ? String(full.holders[full.holders.length - 1].holders) : '—' },
        { label: 'holders drift 24h', value: pct(drift.holdersDrift) },
        { label: 'top-10 concentration', value: pct(full.holders.length ? full.holders[full.holders.length - 1].top10Pct : full.quality?.concentration.top10Pct ?? null) },
        { label: 'adjusted top-10', value: pct(full.quality?.concentration.adjustedTop10Pct ?? null), note: 'creator / known curve / pool addresses excluded when identified' },
        { label: 'top-10 drift 24h', value: drift.top10Drift == null ? '—' : `${drift.top10Drift > 0 ? '+' : ''}${drift.top10Drift.toFixed(1)} п.п.` },
      ],
    },
    {
      title: 'Chain dev & clusters',
      rows: [
        { label: 'dev remaining', value: pct(full.dev.remainingPct) },
        { label: 'dev CEX deposits', value: String(full.dev.cexDeposits.length) },
        { label: 'atomic Jito bundles', value: full.clusters.bundles == null ? '—' : String(full.clusters.bundles), note: 'requires explicit bundle membership/ID evidence; Jito tips alone do not count' },
        { label: 'high-conf coordinated supply', value: pct(full.clusters.walletSharePct), note: 'same-slot coordination corroborated by funding/Jito-tip evidence; not an atomic bundle claim' },
        { label: 'snipers launch slots', value: full.clusters.sniperCount == null ? '—' : String(full.clusters.sniperCount) },
        { label: 'wash share', value: pct(full.clusters.washSharePct) },
        { label: 'smart inflow SOL', value: num(full.clusters.smartInflowSol, 1) },
      ],
    },
    {
      title: 'Chain events',
      rows: [
        { label: 'events 24h', value: String(full.events.filter((e) => full.asOf - e.ts <= 86_400_000).length) },
        { label: 'last event', value: full.events.length ? `${Math.round((full.asOf - full.events[full.events.length - 1].ts) / 3_600_000)}h ago · ${full.events[full.events.length - 1].kind}` : '—' },
      ],
    },
    ...(full.quality ? [
      {
        title: 'Chain ownership quality',
        rows: [
          { label: 'top-1 supply', value: pct(full.quality.concentration.top1Pct) },
          { label: 'top-10 supply', value: pct(full.quality.concentration.top10Pct) },
          { label: 'fresh <24h supply', value: pct(full.quality.walletAge.freshLt24hSupplyPct) },
          { label: 'sniper remaining supply', value: pct(full.quality.snipers.remainingSupplyPct) },
          { label: 'high-conf coordinated supply', value: pct(full.quality.bundles.currentSupplyPct), note: 'not proof of atomic Jito bundle membership' },
          { label: 'verified same-funder supply', value: pct(full.quality.funding.sameFunderWalletSupplyPct) },
          { label: 'insider-candidate supply', value: pct(full.quality.insiders.candidateSupplyPct), note: 'multi-signal heuristic; not an ownership claim' },
        ],
      },
      {
        title: 'Chain execution quality',
        rows: [
          { label: 'wash wallet share', value: pct(full.quality.wash.walletSharePct) },
          { label: 'smart net inflow', value: full.quality.smartMoney.netInflowSol == null ? '—' : `${full.quality.smartMoney.netInflowSol.toFixed(2)} SOL` },
          { label: 'coordinated sell', value: full.quality.coordinatedSelling.score == null ? '—' : `${full.quality.coordinatedSelling.score.toFixed(0)}/100` },
          { label: '$10k exit impact', value: pct(full.quality.exitLiquidity.slippageForUsd['10000']) },
          { label: 'same-slot buy share', value: pct(full.quality.transactions.sameSlotBuyPct) },
          { label: 'evidence completeness', value: pct(full.quality.evidenceCompletenessPct, 0) },
        ],
      },
    ] : []),
  ];
}

export type ChainVerdictFields = {
  lpLockedPct: number | null;
  top10Pct: number | null;
  holdersDrift24h: number | null;
  top10Drift24h: number | null;
  devRemainingPct: number | null;
  bundleSharePct: number | null;
  washSharePct: number | null;
  smartInflowSol24h: number | null;
  slippage5Pct: number | null;
  devCexDeposit: boolean;
  safetyFail: boolean;
  top1Pct: number | null;
  top20Pct: number | null;
  fresh24hSupplyPct: number | null;
  sniperRemainingSupplyPct: number | null;
  insiderCandidateSupplyPct: number | null;
  verifiedSameFunderSupplyPct: number | null;
  coordinatedSellScore: number | null;
  exitImpact10kPct: number | null;
  organicDemandScore: number | null;
  coordinationRiskScore: number | null;
};

/** Выжимка блокчейн-блока в поля verdict-движка (и далее в аргументы ИИ). */
export function chainVerdictFields(full: ChainFull, drift: ReturnType<typeof concentrationDrift>): ChainVerdictFields {
  const lp = full.checks.find((c) => c.id === 'lp_lock');
  const lpPct = lp && lp.status !== 'unknown' && lp.note ? Number.parseFloat(lp.note.replace(/[^\d.]/g, '')) : null;
  const last = full.holders.length ? full.holders[full.holders.length - 1] : null;
  return {
    lpLockedPct: lpPct,
    top10Pct: last?.top10Pct ?? full.quality?.concentration.top10Pct ?? null,
    holdersDrift24h: drift.holdersDrift,
    top10Drift24h: drift.top10Drift,
    devRemainingPct: full.dev.remainingPct,
    bundleSharePct: full.clusters.walletSharePct,
    washSharePct: full.clusters.washSharePct,
    smartInflowSol24h: full.clusters.smartInflowSol,
    slippage5Pct: full.liquidity.slippage.pct5,
    devCexDeposit: full.dev.cexDeposits.length > 0,
    safetyFail: full.checks.some((c) => c.status === 'fail'),
    top1Pct: full.quality?.concentration.top1Pct ?? null,
    top20Pct: full.quality?.concentration.top20Pct ?? null,
    fresh24hSupplyPct: full.quality?.walletAge.freshLt24hSupplyPct ?? null,
    sniperRemainingSupplyPct: full.quality?.snipers.remainingSupplyPct ?? null,
    insiderCandidateSupplyPct: full.quality?.insiders.candidateSupplyPct ?? null,
    verifiedSameFunderSupplyPct: full.quality?.funding.sameFunderWalletSupplyPct ?? null,
    coordinatedSellScore: full.quality?.coordinatedSelling.score ?? null,
    exitImpact10kPct: full.quality?.exitLiquidity.slippageForUsd['10000'] ?? null,
    organicDemandScore: full.quality?.dimensions.organicDemand.score ?? null,
    coordinationRiskScore: full.quality?.dimensions.coordinationRisk.score ?? null,
  };
}
