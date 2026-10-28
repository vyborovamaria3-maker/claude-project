"use client";
// Unified POTAPOFF analysis entry. Existing data pipelines and detailed routes are reused unchanged.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import SearchBar from "@/components/trade/SearchBar";
import {
  Activity, ArrowUpRight, BarChart3, BrainCircuit, ChevronDown, ChevronUp,
  Database, History, Maximize2, Minimize2, Search, ShieldCheck, Sparkles,
  Trophy, Twitter, X, MessageCircle, Users, Clock3,
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

const sections: Array<{ id: Section; label: string; description: string; icon: typeof Twitter }> = [
  { id: "twitter", label: "X / Twitter", description: "Упоминания, авторы, боты, охват и качество публикаций", icon: Twitter },
  { id: "telegram", label: "Telegram", description: "Каналы, сигналы, репутация, история и ранние упоминания", icon: MessageCircle },
  { id: "blockchain", label: "Блокчейн", description: "Кошельки, сделки, источники данных и состояние индексов", icon: Database },
  { id: "fomo", label: "FOMO", description: "Ускорение, ажиотаж, органика и признаки манипуляций", icon: Activity },
  { id: "ai", label: "Общий анализ ИИ", description: "Все 129 основных / 141 отображаемое поле, включая cross-source evidence", icon: BrainCircuit },
  { id: "cross", label: "Cross-platform / Timing", description: "27 полей совпадений, скорости, времени и цены", icon: Clock3 },
  { id: "price", label: "Price event evidence", description: "14 полей истории цены, трейдов, охвата и импульсов", icon: BarChart3 },
  { id: "onchain", label: "Кошельки и DEV", description: "Полный прежний анализ: PnL, bundles, фильтры и CSV", icon: Users },
  { id: "evidence", label: "Проверенные данные", description: "Локальные подтверждённые операции и границы охвата", icon: ShieldCheck },
  { id: "leaderboard", label: "Leaderboard", description: "Существующие рейтинги кошельков и разработчиков", icon: Trophy },
  { id: "history", label: "История запусков", description: "Прежняя история токенов и кошельков", icon: History },
  { id: "kols", label: "KOL / Smart Money", description: "Данные отслеживаемых адресов и KOL", icon: Users },
  { id: "live", label: "Live Intelligence", description: "Действующий мониторинг источников в реальном времени", icon: Clock3 },
  { id: "investigation", label: "Расследование", description: "Существующий углублённый аналитический инструмент", icon: Search },
  { id: "chart", label: "График подробно", description: "Оригинальный график Pump.fun со своими инструментами", icon: BarChart3 },
];

const mainSections = sections.slice(0, 4);
const extraSections = sections.filter(({ id }) => !["twitter", "telegram", "blockchain", "fomo", "ai", "chart"].includes(id));
const gold = "border-[#a98b2b]/35 bg-[#a98b2b]/5";
const buttonClass = "inline-flex items-center gap-2 rounded-lg border border-[#a98b2b]/40 bg-[#a98b2b]/10 px-3 py-2 text-xs font-semibold text-[#edcf69] transition hover:border-[#e6c65a]/70 hover:bg-[#a98b2b]/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#edcf69]";

function LegacyDetail({ path, mint, label, onNavigate, onClose }: {
  path: string; mint: string; label: string;
  onNavigate: (nextMint: string, overview: boolean) => void;
  onClose: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const url = mint ? `${path}?mint=${encodeURIComponent(mint)}` : path;
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let attachedDocument: Document | null = null;
    let lastUrl = "";
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
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
  }, [onNavigate, onClose]);
  return (
    <div className="h-full min-h-[640px] overflow-hidden rounded-xl border border-[#a98b2b]/25 bg-[#17130e]">
      <iframe ref={frameRef} title={label} src={url} className="h-[70vh] min-h-[640px] w-full border-0" />
    </div>
  );
}

export default function UnifiedAnalysisClient({ requestOnly = false }: { requestOnly?: boolean }) {
  const params = useSearchParams();
  const router = useRouter();
  const initialMint = params.get("mint")?.trim() || "";
  const [mint, setMint] = useState(initialMint);
  const [chartSize, setChartSize] = useState<ChartSize>("normal");
  const [detail, setDetail] = useState<Section | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const validMint = MINT_RE.test(mint);

  useEffect(() => {
    const next = params.get("mint")?.trim() || "";
    setMint(next);
  }, [params]);

  const submit = useCallback((next: string) => {
    // SearchBar retains clipboard paste, recent searches, auto-submit and base58 validation.
    setMint(next);
    router.replace(`/trade/analysis?mint=${encodeURIComponent(next)}`, { scroll: false });
  }, [router]);

  const open = (id: Section) => {
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDetail(id);
  };

  const close = useCallback(() => {
    setDetail(null);
    requestAnimationFrame(() => priorFocus.current?.focus());
  }, []);

  const navigateLegacy = useCallback((next: string, overview: boolean) => {
    if (next !== mint) submit(next);
    if (overview) close();
  }, [mint, submit, close]);

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
        const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex="0"]'
        ));
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
            key={mint}
            focus={id}
            embedded
            requestOnly={requestOnly}
            mintOverride={mint}
            onMintChange={(next) => { if (next !== mint) submit(next); }}
          />
          {id === "ai" && validMint && <BlockchainAiReportPanel mint={mint} />}
        </div>
      );
    }
    if (!validMint && !["leaderboard", "history"].includes(id)) {
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
    const legacy = { onNavigate: navigateLegacy, onClose: close };
    if (id === "onchain") return <LegacyDetail {...legacy} path="/trade/analysis/onchain" mint={mint} label="Полный анализ кошельков" />;
    if (id === "leaderboard") return <LegacyDetail {...legacy} path="/trade/leaderboard" mint={mint} label="Leaderboard" />;
    if (id === "history") return <LegacyDetail {...legacy} path="/trade/history" mint={mint} label="История запусков" />;
    if (id === "kols") return <LegacyDetail {...legacy} path="/trade/kols-twitter" mint={mint} label="KOL / Smart Money" />;
    if (id === "live") return <LegacyDetail {...legacy} path="/trade/analysis/live-intelligence" mint={mint} label="Live Intelligence" />;
    if (id === "investigation") return <LegacyDetail {...legacy} path="/trade/analysis/investigation" mint={mint} label="Расследование" />;
    return <div className="h-[min(75vh,740px)] overflow-auto rounded-xl border border-[#a98b2b]/20"><PumpFunChart mint={mint}/></div>;
  }

  const detailMeta = sections.find((item) => item.id === detail);

  return (
    <main className="space-y-5 text-[#ede8dc]" data-tag="trade.analysis.unified_v1">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-[.24em] text-[#d8b744]">POTAPOFF / ANALYSIS</p>
        <h1 className="text-2xl font-semibold tracking-tight text-[#f1eee6]">Единый анализ токена</h1>
        <p className="max-w-4xl text-sm text-[#a9a093]">Все существующие источники на одном экране. 129 основных параметров и 141 отображаемое поле доступны в подробном анализе. Подробности открываются в большой панели без перехода на другую страницу. Расчётные показатели не являются подтверждённым PnL.</p>
      </header>

      <div className="rounded-2xl border border-[#a98b2b]/25 bg-[#211c16]/90 p-4">
        <p className="mb-2 text-xs font-semibold text-[#e8cb6b]">Solana mint / CA</p>
        <SearchBar onSearch={submit} isLoading={false} initialValue={mint} />
      </div>

      <section className="overflow-hidden rounded-2xl border border-[#a98b2b]/30 bg-[#1e1912]" aria-label="График токена">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#a98b2b]/20 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold"><BarChart3 className="text-[#e6c55b]" size={17}/> График Pump.fun <span className="text-[11px] font-normal text-[#9f9583]">Данные существующего компонента</span></div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={() => setChartSize(chartSize === "compact" ? "normal" : "compact")}>
              <Minimize2 size={14}/> {chartSize === "compact" ? "Обычный размер" : "Уменьшить"}
            </button>
            <button type="button" className={buttonClass} onClick={() => setChartSize(chartSize === "hidden" ? "normal" : "hidden")}>
              {chartSize === "hidden" ? <ChevronDown size={14}/> : <ChevronUp size={14}/>}
              {chartSize === "hidden" ? "Показать" : "Свернуть"}
            </button>
            <button type="button" className={buttonClass} onClick={() => open("chart")}><Maximize2 size={14}/> Подробнее</button>
          </div>
        </div>
        {chartSize !== "hidden" && (
          <div className={chartSize === "compact" ? "max-h-[390px] overflow-hidden" : "min-h-[460px]"}>
            {validMint ? <PumpFunChart mint={mint} /> : (
              <div className="flex min-h-[240px] items-center justify-center p-8 text-center text-sm text-[#aca293]">Введите mint токена, чтобы загрузить реальный график.</div>
            )}
          </div>
        )}
      </section>

      <section aria-label="Анализ по источникам" className="grid gap-4 lg:grid-cols-2">
        {mainSections.map(({ id, label, description, icon: Icon }) => (
          <article key={id} className={`flex min-h-[180px] flex-col justify-between rounded-2xl border p-5 ${gold}`}>
            <div>
              <div className="mb-3 flex items-center gap-2"><Icon size={20} className="text-[#e5c452]"/><h2 className="text-lg font-semibold">{label}</h2></div>
              <p className="text-sm leading-relaxed text-[#b2a999]">{description}</p>
              <p className="mt-3 text-xs text-[#857e73]">{validMint ? "Детальные показатели загружаются из действующих источников при открытии отчёта." : "Для получения данных требуется адрес токена."}</p>
            </div>
            <button type="button" className={`${buttonClass} mt-4 self-start`} onClick={() => open(id)}>
              Открыть подробно <ArrowUpRight size={15} />
            </button>
          </article>
        ))}
      </section>

      <section className={`rounded-2xl border p-5 ${gold}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <div className="mb-2 flex items-center gap-2"><BrainCircuit size={22} className="text-[#e5c452]"/><h2 className="text-xl font-semibold">Общий анализ ИИ</h2></div>
            <p className="text-sm leading-relaxed text-[#b2a999]">Существующий cross-source анализ X, Telegram, рыночных и on-chain данных. Выводы, противоречия, степень уверенности и нехватка доказательств остаются в подробном отчёте.</p>
          </div>
          <button type="button" className={buttonClass} onClick={() => open("ai")}>Открыть полный отчёт <ArrowUpRight size={15}/></button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2"><Sparkles className="text-[#e5c452]" size={16}/><h2 className="text-sm font-semibold text-[#eee2c2]">Прежние инструменты анализа</h2></div>
        <div className="flex flex-wrap gap-2">
          {extraSections.map(({ id, label }) => (
            <button key={id} className={buttonClass} type="button" onClick={() => open(id)}>{label} <ArrowUpRight size={13}/></button>
          ))}
        </div>
      </section>

      {detail && detailMeta && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-0 backdrop-blur-sm md:p-6"
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
      )}
    </main>
  );
}
