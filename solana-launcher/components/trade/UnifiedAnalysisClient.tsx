"use client";
// Unified POTAPOFF analysis entry. Existing data pipelines and detailed routes are reused unchanged.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import SearchBar from "@/components/trade/SearchBar";
import useAnalysisOverview, { overviewNumber, telegramMentions } from "./useAnalysisOverview";
import "./analysis-workspace.css";
import {
  Activity, ArrowUpRight, BarChart3, BrainCircuit, ChevronDown, ChevronUp,
  Database, History, Maximize2, Minimize2, Search, ShieldCheck, Sparkles,
  Trophy, Twitter, X, MessageCircle, Users, Clock3, RefreshCw,
} from "lucide-react";

const PumpFunChart = dynamic(() => import("@/components/PumpFunChart"), { ssr: false });
const SocialIntelligencePanel = dynamic(() => import("@/components/trade/SocialIntelligencePanel"), { ssr: false });
const BlockchainAnalyticsDashboard = dynamic(() => import("@/components/trade/BlockchainAnalyticsDashboard"), { ssr: false });
const BlockchainAiReportPanel = dynamic(() => import("@/components/trade/BlockchainAiReportPanel"), { ssr: false });
const ForensicEvidencePage = dynamic(() => import("@/app/trade/analysis/evidence/page"), { ssr: false });

type Section = "twitter" | "telegram" | "blockchain" | "fomo" | "ai" | "cross" | "price"
  | "onchain" | "evidence" | "leaderboard" | "history" | "kols" | "live" | "investigation" | "chart";
type ChartSize = "normal" | "compact" | "hidden";
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FOCUSABLE_SELECTOR = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex="0"]';

function focusableElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
}

const sections: Array<{ id: Section; label: string; description: string; icon: typeof Twitter }> = [
  { id: "twitter", label: "X / Twitter", description: "Упоминания, авторы, боты, охват и качество публикаций", icon: Twitter },
  { id: "telegram", label: "Telegram", description: "Каналы, сигналы, репутация, история и ранние упоминания", icon: MessageCircle },
  { id: "blockchain", label: "Блокчейн", description: "Кошельки, сделки, источники данных и состояние индексов", icon: Database },
  { id: "fomo", label: "FOMO", description: "Ускорение, ажиотаж, органика и признаки манипуляций", icon: Activity },
  { id: "ai", label: "Общий анализ ИИ", description: "Выводы, противоречия, уверенность и доказательства по всем источникам", icon: BrainCircuit },
  { id: "cross", label: "Cross-platform / Timing", description: "Совпадения X и Telegram, время сигналов и реакция цены", icon: Clock3 },
  { id: "price", label: "Price event evidence", description: "История цены, сделки, импульсы и реакция на упоминания", icon: BarChart3 },
  { id: "onchain", label: "Кошельки и DEV", description: "Разработчики, сделки, PnL, bundles и экспорт", icon: Users },
  { id: "evidence", label: "Проверенные данные", description: "Подтверждённые операции Solana и границы выборки", icon: ShieldCheck },
  { id: "leaderboard", label: "Leaderboard", description: "Рейтинг кошельков и разработчиков", icon: Trophy },
  { id: "history", label: "История запусков", description: "История токенов, кошельков и результатов анализа", icon: History },
  { id: "kols", label: "KOL / Smart Money", description: "Данные отслеживаемых адресов и KOL", icon: Users },
  { id: "live", label: "Live Intelligence", description: "Мониторинг источников и сигналов в реальном времени", icon: Clock3 },
  { id: "investigation", label: "Расследование", description: "Углублённое исследование токена и его активности", icon: Search },
  { id: "chart", label: "График подробно", description: "Оригинальный график Pump.fun со своими инструментами", icon: BarChart3 },
];

const mainSections = sections.slice(0, 4);
const extraSections = sections.filter(({ id }) => !["twitter", "telegram", "blockchain", "fomo", "ai", "chart"].includes(id));
const buttonClass = "analysis-button";

function LegacyDetail({ path, mint, label, onNavigate, onClose, onTabBoundary }: {
  path: string; mint: string; label: string;
  onNavigate: (nextMint: string, overview: boolean) => void;
  onClose: () => void;
  onTabBoundary: (direction: "previous" | "next", frame: HTMLIFrameElement) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const url = mint ? `${path}?mint=${encodeURIComponent(mint)}` : path;
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let attachedDocument: Document | null = null;
    let lastUrl = "";
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const childDocument = frame.contentDocument;
      if (!childDocument) return;
      const focusable = focusableElements(childDocument);
      const active = childDocument.activeElement;
      if (!focusable.length || (event.shiftKey && active === focusable[0])) {
        event.preventDefault();
        onTabBoundary("previous", frame);
      } else if (!event.shiftKey && active === focusable[focusable.length - 1]) {
        event.preventDefault();
        onTabBoundary("next", frame);
      }
    };
    const sync = () => {
      try {
        const child = frame.contentWindow;
        if (!child || child.location.origin !== window.location.origin) return;
        if (attachedDocument !== child.document) {
          attachedDocument?.removeEventListener("keydown", keydown);
          attachedDocument = child.document;
          attachedDocument.addEventListener("keydown", keydown);
        }
        if (child.location.href === lastUrl) return;
        lastUrl = child.location.href;
        const nextUrl = new URL(lastUrl);
        const nextMint = nextUrl.searchParams.get("mint")?.trim() || "";
        if (MINT_RE.test(nextMint)) onNavigate(nextMint, nextUrl.pathname === "/trade/analysis");
      } catch { /* External frame navigation cannot change the selected token. */ }
    };
    frame.addEventListener("load", sync);
    // Next.js changes the child URL without a frame load event.
    const timer = window.setInterval(sync, 500);
    sync();
    return () => {
      frame.removeEventListener("load", sync);
      attachedDocument?.removeEventListener("keydown", keydown);
      window.clearInterval(timer);
    };
  }, [onNavigate, onClose, onTabBoundary]);
  return (
    <div className="h-full min-h-[640px] overflow-hidden rounded-xl border border-[#a98b2b]/25 bg-[#17130e]">
      <iframe ref={frameRef} title={label} src={url} className="h-[70vh] min-h-[640px] w-full border-0" />
    </div>
  );
}

export default function UnifiedAnalysisClient({ requestOnly = false }: { requestOnly?: boolean }) {
  const params = useSearchParams();
  const router = useRouter();
  const paramsRef = useRef(params.toString());
  useEffect(() => { paramsRef.current = params.toString(); }, [params]);
  const initialMint = params.get("mint")?.trim() || "";
  const [mint, setMint] = useState(initialMint);
  const [chartSize, setChartSize] = useState<ChartSize>("normal");
  const requestedSection = params.get("section");
  const [detail, setDetail] = useState<Section | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const validMint = MINT_RE.test(mint);
  const overview = useAnalysisOverview(mint);

  useEffect(() => {
    const next = params.get("mint")?.trim() || "";
    setMint(next);
  }, [params]);

  useEffect(() => {
    setDetail(sections.find((item) => item.id === requestedSection)?.id || null);
  }, [requestedSection]);

  const submit = useCallback((next: string) => {
    // SearchBar retains clipboard paste, recent searches, auto-submit and base58 validation.
    setMint(next);
    const nextParams = new URLSearchParams(params.toString());
    nextParams.set("mint", next);
    paramsRef.current = nextParams.toString();
    router.replace(`/trade/analysis?${nextParams}`, { scroll: false });
  }, [params, router]);

  const open = (id: Section) => {
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDetail(id);
  };

  const close = useCallback(() => {
    setDetail(null);
    const nextParams = new URLSearchParams(paramsRef.current);
    if (nextParams.has("section")) {
      nextParams.delete("section");
      paramsRef.current = nextParams;
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${nextParams.size ? `?${nextParams.toString()}` : ""}${window.location.hash}`,
      );
    }
    requestAnimationFrame(() => priorFocus.current?.focus());
  }, []);

  const navigateLegacy = useCallback((next: string, overview: boolean) => {
    if (next !== mint) submit(next);
    if (overview) close();
  }, [mint, submit, close]);

  const focusFrameBoundary = useCallback((direction: "previous" | "next", frame: HTMLIFrameElement) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = focusableElements(dialog);
    const frameIndex = focusable.indexOf(frame);
    const target = direction === "previous"
      ? focusable[frameIndex - 1] ?? focusable[focusable.length - 1]
      : focusable[frameIndex + 1] ?? focusable[0];
    target?.focus();
  }, []);

  useEffect(() => {
    if (!detail) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
      if (event.key === "Tab" && dialogRef.current) {
        const focusable = focusableElements(dialogRef.current);
        if (focusable.length) {
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = before;
      document.removeEventListener("keydown", keydown);
    };
  }, [detail, close]);

  function detailContent(id: Section): ReactNode {
    if (id === "twitter" || id === "telegram" || id === "fomo" || id === "cross" || id === "price" || id === "ai") {
      return (
        <div className="space-y-6">
          {!validMint && <p className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-6 text-sm text-amber-200">Для этого анализа сначала укажите mint токена в основной форме.</p>}
          <SocialIntelligencePanel
            focus={id}
            embedded
            requestOnly={requestOnly}
            mintOverride={mint}
            onMintChange={(next) => { if (next !== mint) submit(next); }}
          />
          {id === "ai" && validMint && <BlockchainAiReportPanel mint={mint} requestOnly /> /* The unified report must never trigger a paid AI request merely by opening the dialog. */}
        </div>
      );
    }
    if (!validMint && !["leaderboard", "history", "kols"].includes(id)) {
      return <p className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-6 text-sm text-amber-200">Для этого анализа сначала укажите mint токена в основной форме.</p>;
    }
    if (id === "blockchain") return (
      <div className="space-y-5">
        <BlockchainAnalyticsDashboard mint={mint} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={() => setDetail("onchain")}>Кошельки, DEV и сделки <ArrowUpRight size={14}/></button>
          <button type="button" className={buttonClass} onClick={() => setDetail("evidence")}>Проверенные данные <ArrowUpRight size={14}/></button>
        </div>
      </div>
    );
    if (id === "evidence") return <ForensicEvidencePage />;
    const legacy = { onNavigate: navigateLegacy, onClose: close, onTabBoundary: focusFrameBoundary };
    if (id === "onchain") return <LegacyDetail {...legacy} path="/trade/analysis/onchain" mint={mint} label="Полный анализ кошельков" />;
    if (id === "leaderboard") return <LegacyDetail {...legacy} path="/trade/leaderboard" mint={mint} label="Leaderboard" />;
    if (id === "history") return <LegacyDetail {...legacy} path="/trade/history" mint={mint} label="История запусков" />;
    if (id === "kols") return <LegacyDetail {...legacy} path="/trade/kols-twitter" mint={mint} label="KOL / Smart Money" />;
    if (id === "live") return <LegacyDetail {...legacy} path="/trade/analysis/live-intelligence" mint={mint} label="Live Intelligence" />;
    if (id === "investigation") return <LegacyDetail {...legacy} path="/trade/analysis/investigation" mint={mint} label="Расследование" />;
    return <div className="h-[min(75vh,740px)] overflow-auto rounded-xl border border-[#a98b2b]/20"><PumpFunChart key={mint} mint={mint}/></div>;
  }

  const detailMeta = sections.find((item) => item.id === detail);
  const x = overview.x.data, tg = overview.tg.data, chain = overview.chain.data;
  const tgCount = telegramMentions(tg);
  const hasSocial = !!x?.totalTweets && !!tgCount;
  const growth = overview.metrics.groups.find(group => group.title === "Growth / Quality / Manipulation");
  const growthValue = (label: string) => hasSocial ? growth?.rows.find(row => row.label === label)?.value || "—" : "—";
  const count = overviewNumber;
  const channels = tg ? tg.meta?.uniqueSourcesBeforeLimit ?? new Set(tg.timeline.filter(item => !item.platform || item.platform.toLowerCase() === "telegram").map(item => item.source_handle || item.source_name).filter(Boolean)).size : null;
  const chainIndexed = !!chain?.meta.dexIndexAvailable;
  const forensicIndexed = !!chain?.meta.forensicIndexAvailable;
  const cards = {
    twitter: { source: overview.x, headline: count(x?.totalTweets), unit: "упоминаний в выборке", rows: [["Авторы", count(x?.uniqueMentioners)], ["Просмотры", count(x?.totalViews)], ["Вовлечения", count(x?.aggregated.totalEngagement)], ["Риск ботов · оценка", x?.totalTweets ? `${count(x.riskUniverse?.botRiskScore ?? x.botRiskScore)} / 100` : "—"]], note: "24 часа · отфильтрованная выборка X" },
    telegram: { source: overview.tg, headline: count(tgCount), unit: "упоминаний по фильтру", rows: [["Каналы", count(channels)], ["Сообщения в выборке", count(tg?.timeline.length)], ["Явные сигналы", count(tg?.meta?.explicitTelegramCallsBeforeLimit)], ["Первый источник", tg?.origin?.source_name || tg?.origin?.source_handle || "—"]], note: "24 часа · до 200 сообщений Telegram" },
    blockchain: { source: overview.chain, headline: chainIndexed ? count(chain?.observedDexTrades.length) : "—", unit: "наблюдаемых DEX-операций", rows: [["Сделки seed-кошельков", forensicIndexed ? count(chain?.seedWalletTrades.length) : "—"], ["Записи PnL verified", forensicIndexed ? count(chain?.walletPnl.filter(item => item.status === "verified").length) : "—"], ["Индекс кошельков", chain ? forensicIndexed ? "Доступен" : "Не создан" : "—"], ["Индекс DEX", chain ? chainIndexed ? "Доступен" : "Не создан" : "—"]], note: "Локальная выборка · до 100 записей / источник" },
    fomo: { source: { status: overview.x.status === "loading" || overview.tg.status === "loading" ? "loading" : hasSocial ? "ready" : "idle" }, headline: growthValue("FOMO score"), unit: "FOMO · расчётная оценка", rows: [["Органичность", growthValue("Organic score")], ["Манипуляции", growthValue("Manipulation score")], ["Социальный риск", growthValue("Social risk")], ["Пиковая плотность", growthValue("Peak density")]], note: hasSocial ? "Эвристика по X + Telegram · не прогноз" : "Для оценки нужны упоминания X и Telegram" },
  };
  const available = [overview.x, overview.tg, overview.chain].filter(item => item.status === "ready").length;
  const market = overview.market.data?.pair;
  const sourceLabel = (status: string) => status === "loading" ? "Загрузка" : status === "ready" ? "Источник доступен" : status === "error" ? "Недоступен" : validMint ? "Недостаточно данных" : "Ожидает токен";

  return (
    <main className="analysis-workspace" data-tag="trade.analysis.unified_v1">
      <header className="analysis-heading">
        <div><p className="analysis-eyebrow"><span/> POTAPOFF INTELLIGENCE</p><h1>Единый анализ токена<span>.</span></h1><p className="analysis-subtitle">От первого упоминания до движения средств. Вся картина на одном экране.</p></div>
        <div className="analysis-network"><span/> SOLANA <span className="analysis-network-divider"/> 6 групп анализа</div>
      </header>
      <section className="analysis-search analysis-surface" aria-label="Выбор токена">
        <div className="analysis-section-heading"><h2>Адрес токена</h2><span>Solana mint / CA</span></div>
        <SearchBar onSearch={submit} isLoading={false} initialValue={mint}/>
        <div className="analysis-search-caption"><span>{validMint ? "Сводка по выбранному токену · социальные данные за 24 часа" : "Вставьте адрес — доступные данные появятся в сводке"}</span><span>Отсутствующие значения — «—»</span></div>
      </section>
      <div className="analysis-section-heading"><h2>Обзор источников</h2><button type="button" className="analysis-refresh" disabled={!validMint || overview.loading} onClick={overview.refresh}><RefreshCw size={13} className={overview.loading ? "animate-spin" : ""}/>{overview.loading ? "Обновляем данные" : "Обновить сводку"}</button></div>
      <section aria-label="Анализ по источникам" className="analysis-cards" aria-busy={overview.loading}>
        {mainSections.map(({ id, label, icon: Icon }) => {
          const card = cards[id as keyof typeof cards];
          return <article key={id} className="analysis-source-card analysis-surface" data-source={id}>
            <div className="analysis-card-heading"><span className="analysis-icon"><Icon size={17}/></span><h2>{label}</h2><span className={`analysis-source-dot is-${card.source.status}`} title={sourceLabel(card.source.status)}/></div>
            <p className="analysis-card-value">{card.headline}</p><p className="analysis-card-unit">{card.unit}</p>
            <dl className="analysis-metrics">{card.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl>
            <p className="analysis-card-note">{card.source.status === "error" ? "Источник недоступен. Повторите обновление." : card.note}</p>
            <button type="button" className="analysis-card-link" onClick={() => open(id)}>Открыть подробно <ArrowUpRight size={15}/></button>
          </article>;
        })}
      </section>
      <div className="analysis-middle">
        <section className="analysis-chart analysis-surface" aria-label="График токена">
          <div className="analysis-chart-heading"><h2><BarChart3 size={17}/> Рынок и динамика</h2><div className="analysis-chart-controls">
            <button type="button" className={buttonClass} title={chartSize === "compact" ? "Обычный размер" : "Уменьшить"} aria-label={chartSize === "compact" ? "Обычный размер" : "Уменьшить"} onClick={() => setChartSize(chartSize === "compact" ? "normal" : "compact")}><Minimize2 size={14}/></button>
            <button type="button" className={buttonClass} title={chartSize === "hidden" ? "Показать" : "Свернуть"} aria-label={chartSize === "hidden" ? "Показать" : "Свернуть"} onClick={() => setChartSize(chartSize === "hidden" ? "normal" : "hidden")}>{chartSize === "hidden" ? <ChevronDown size={14}/> : <ChevronUp size={14}/>}</button>
            <button type="button" className={buttonClass} onClick={() => open("chart")}><Maximize2 size={14}/> Подробнее</button>
          </div></div>
          <dl className="analysis-market-stats"><div><dt>Ликвидность</dt><dd>{market?.liquidityUsd == null ? "—" : `$${count(market.liquidityUsd)}`}</dd></div><div><dt>Объём · 24ч</dt><dd>{market?.volumeH24 == null ? "—" : `$${count(market.volumeH24)}`}</dd></div><div><dt>Изменение · 24ч</dt><dd>{market?.change24h == null ? "—" : `${market.change24h > 0 ? "+" : ""}${count(market.change24h)}%`}</dd></div></dl>
          {chartSize !== "hidden" && (validMint ? <div className={`analysis-chart-content is-${chartSize}`}><PumpFunChart key={mint} mint={mint} overview/></div> : <div className="analysis-chart-empty"><span className="analysis-empty-icon"><BarChart3 size={29} strokeWidth={1.2}/></span><h3>Рынок начинается с токена</h3><p>Укажите адрес выше, чтобы увидеть свечи,<br/>ликвидность и торговую активность.</p><span className="analysis-empty-caption">PUMP.FUN · РЫНОЧНЫЕ ДАННЫЕ</span></div>)}
        </section>
        <section className="analysis-ai analysis-surface">
          <div className="analysis-ai-heading"><span className="analysis-icon"><BrainCircuit size={20}/></span><span className="analysis-eyebrow">СВЯЗИ МЕЖДУ ИСТОЧНИКАМИ</span></div>
          <h2>Общий анализ ИИ</h2><p>Что стоит за активностью токена: рост интереса, координация или движение капитала.</p>
          <div className="analysis-coverage"><span>Доступность источников</span><strong>{available}<span> / 3</span></strong></div>
          <div className="analysis-source-chips">{[["X", overview.x.status], ["Telegram", overview.tg.status], ["Solana", overview.chain.status]].map(([label, status]) => <span key={label} title={sourceLabel(status)}><i className={`analysis-source-dot is-${status}`}/>{label}</span>)}</div>
          <p className="analysis-ai-note">{validMint ? "Вывод ИИ формируется по отдельному запросу внутри отчёта. Расчётный PnL отделён от подтверждённых операций." : "Выберите токен для сбора доказательств. Каталог показателей доступен и без адреса."}</p>
          <button type="button" className="analysis-primary" onClick={() => open("ai")}>Открыть полный отчёт <ArrowUpRight size={16}/></button>
          <div className="analysis-ai-footer"><span>129 основных параметров</span><span>141 показатель</span></div>
        </section>
      </div>
      <section className="analysis-tools"><div className="analysis-section-heading"><h2><Sparkles size={15}/> Углублённый анализ</h2><span>Все инструменты в одном месте</span></div>
        <div className="analysis-tool-grid">{extraSections.map(({ id, label, description, icon: Icon }) => <button key={id} className="analysis-tool" type="button" onClick={() => open(id)}><Icon size={17}/><span><strong>{label}</strong><small>{description}</small></span><ArrowUpRight size={14}/></button>)}</div>
      </section>
      <footer className="analysis-footnote"><ShieldCheck size={14}/><span>Сводка отражает доступную выборку, а не весь рынок. Оценки FOMO и риска — эвристики. Подтверждённые операции и границы охвата доступны в разделе доказательств.</span></footer>

      {detail && detailMeta && createPortal(
        <div className="analysis-detail-overlay fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-0 backdrop-blur-sm md:p-6"
          onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
          <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={detailMeta.label} tabIndex={-1}
            className="flex h-[100dvh] w-full max-w-[1540px] flex-col overflow-hidden rounded-none border border-[#a98b2b]/40 bg-[#15120e] shadow-[0_0_80px_rgba(0,0,0,.65)] outline-none md:h-[92vh] md:rounded-2xl">
            <header className="flex items-center justify-between gap-4 border-b border-[#a98b2b]/25 bg-[#252018] px-5 py-4">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold text-[#f1e8d0]">{detailMeta.label}</h2>
                <p className="truncate text-xs text-[#a9a093]">{detailMeta.description}</p>
              </div>
              <button type="button" onClick={close} aria-label="Закрыть подробный анализ" className={buttonClass}>
                <X size={17}/> <span className="hidden sm:inline">Закрыть</span>
              </button>
            </header>
            <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[210px_minmax(0,1fr)]">
              <nav aria-label="Разделы подробного анализа" className="flex shrink-0 gap-1 overflow-x-auto border-b border-[#a98b2b]/20 bg-[#1d1914] p-3 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r">
                {sections.map(({ id, label, icon: Icon }) => (
                  <button type="button" key={id} onClick={() => setDetail(id)}
                    aria-current={detail === id ? "true" : undefined}
                    className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#e0c25a] ${detail === id ? "border border-[#a98b2b]/40 bg-[#a98b2b]/20 text-[#f8dc7c]" : "border border-transparent text-[#b4aa9b] hover:bg-white/5 hover:text-white"}`}>
                    <Icon size={15}/><span>{label}</span>
                  </button>
                ))}
              </nav>
              <div className="min-h-0 min-w-0 flex-1 overflow-auto p-4 text-white md:p-6" data-tag="trade.analysis.detail_modal">
                {detailContent(detail)}
              </div>
            </div>
          </section>
        </div>
      , document.body)}
    </main>
  );
}
