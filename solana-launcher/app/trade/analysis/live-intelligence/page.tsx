"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

const PumpFunChart = dynamic(() => import("@/components/PumpFunChart"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[680px] items-center justify-center rounded-xl border border-bg-border bg-bg-card text-sm text-content-muted">
      Загружаю существующий график Trade Analysis…
    </div>
  ),
});

type SignalTone = "positive" | "negative" | "social";

type SignificantSignal = {
  id: number;
  source: string;
  title: string;
  detail: string;
  impact: number;
  tone: SignalTone;
  left: number;
  top: number;
};

const SIGNAL_LIBRARY: Omit<SignificantSignal, "id" | "left" | "top">[] = [
  {
    source: "SMART WALLET",
    title: "Умный кошелёк купил 18.4 SOL",
    detail: "Новая позиция верифицированного smart-wallet. Bundle-связь не обнаружена.",
    impact: 3.1,
    tone: "positive",
  },
  {
    source: "X · ИНФЛЮЕНСЕР",
    title: "Крупный инфлюенсер упомянул токен",
    detail: "Высокая репутация автора и охват заметно выше фонового уровня по токену.",
    impact: 2.4,
    tone: "social",
  },
  {
    source: "WHALE",
    title: "Крупный держатель продал 31.7 SOL",
    detail: "Продажа превышает порог значимости и ухудшает краткосрочную on-chain структуру.",
    impact: -3.6,
    tone: "negative",
  },
  {
    source: "ЛИКВИДНОСТЬ",
    title: "Ликвидность снизилась на 18%",
    detail: "Глубина падает при повышенном объёме. Риск проскальзывания и выхода вырос.",
    impact: -2.9,
    tone: "negative",
  },
  {
    source: "TELEGRAM",
    title: "Сильный Telegram-сигнал подтверждён",
    detail: "Сигнал из высокорейтингового канала подтверждён независимым источником.",
    impact: 2.1,
    tone: "social",
  },
  {
    source: "SMART MONEY",
    title: "Три smart-wallet вошли в одном окне",
    detail: "Независимые классифицированные кошельки купили без общего bundle-паттерна.",
    impact: 4.0,
    tone: "positive",
  },
];

const INITIAL_SIGNALS: SignificantSignal[] = [
  { ...SIGNAL_LIBRARY[0], id: 1, left: 35, top: 54 },
  { ...SIGNAL_LIBRARY[1], id: 2, left: 63, top: 31 },
];

function toneClasses(tone: SignalTone) {
  if (tone === "positive") {
    return {
      card: "border-[#26a69a]/55 bg-[#081419]/95",
      dot: "bg-[#26a69a] shadow-[0_0_0_3px_rgba(10,10,20,.9)]",
      impact: "text-[#26a69a]",
    };
  }
  if (tone === "negative") {
    return {
      card: "border-[#ef5350]/55 bg-[#160d12]/95",
      dot: "bg-[#ef5350] shadow-[0_0_0_3px_rgba(10,10,20,.9)]",
      impact: "text-[#ef5350]",
    };
  }
  return {
    card: "border-[#a855f7]/60 bg-[#100d18]/95",
    dot: "bg-[#a855f7] shadow-[0_0_0_3px_rgba(10,10,20,.9)]",
    impact: "text-[#a855f7]",
  };
}

export default function LiveIntelligencePrototypePage() {
  const params = useSearchParams();
  const initialMint = params.get("mint") || "DksAcB4w38E7bfzQ2KbjwG3sf95vUPWX9x7rhniwpump";
  const [mintInput, setMintInput] = useState(initialMint);
  const [mint, setMint] = useState(initialMint);
  const [signals, setSignals] = useState<SignificantSignal[]>(INITIAL_SIGNALS);
  const [score, setScore] = useState(68);
  const [confidence, setConfidence] = useState(84);
  const [stability, setStability] = useState(57);
  const [nextSignal, setNextSignal] = useState(2);

  const scoreRange = useMemo(() => {
    const spread = Math.round(5 + (100 - confidence) / 7 + (100 - stability) / 18);
    return `${Math.max(0, score - spread)}–${Math.min(100, score + spread)}`;
  }, [confidence, score, stability]);

  const addSignal = () => {
    const base = SIGNAL_LIBRARY[nextSignal % SIGNAL_LIBRARY.length];
    const id = Date.now();
    const leftSlots = [22, 46, 72, 57, 31, 78];
    const topSlots = [39, 61, 28, 68, 44, 51];
    const signal: SignificantSignal = {
      ...base,
      id,
      left: leftSlots[nextSignal % leftSlots.length],
      top: topSlots[nextSignal % topSlots.length],
    };

    setSignals((value) => [...value.slice(-2), signal]);
    setScore((value) => Math.max(0, Math.min(100, Math.round(value + base.impact * 0.45))));
    setConfidence((value) => Math.max(72, Math.min(94, value + (base.impact >= 0 ? 0.4 : -0.3))));
    setStability((value) => Math.max(42, Math.min(88, value + (base.impact >= 0 ? 0.5 : -0.8))));
    setNextSignal((value) => value + 1);
  };

  const verdict = score >= 78
    ? "Сильная структура"
    : score >= 64
      ? "Умеренно сильная структура"
      : score >= 48
        ? "Смешанная структура"
        : "Слабая структура";

  return (
    <div className="space-y-4" data-tag="trade.live_intelligence.prototype">
      <header className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-content-faint">Тестовый маршрут · существующий график без изменений</div>
          <h1 className="mt-1 text-lg font-semibold text-content">Живой анализ токена</h1>
          <p className="mt-1 max-w-3xl text-xs text-content-muted">
            Свечи, объём, таймфреймы, crosshair, live-trades и Dev Forensics рендерит текущий PumpFunChart. Новый слой отвечает только за intelligence-события и общий вывод.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={mintInput}
            onChange={(event) => setMintInput(event.target.value)}
            className="min-w-0 rounded-lg border border-bg-border bg-bg-card px-3 py-2 font-mono text-xs text-content outline-none sm:w-[390px]"
            placeholder="Solana mint"
          />
          <button
            type="button"
            onClick={() => mintInput.trim() && setMint(mintInput.trim())}
            className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary"
          >
            Открыть токен
          </button>
        </div>
      </header>

      <section className="relative overflow-hidden rounded-2xl border border-bg-border bg-bg-card">
        <div className="min-h-[700px]">
          <PumpFunChart mint={mint} symbol="TOKEN" tokenName="Live Intelligence" />
        </div>

        {/* Только overlay: сам PumpFunChart и его candle series не модифицируются. */}
        <div className="pointer-events-none absolute left-0 right-[288px] top-[132px] z-20 hidden h-[300px] overflow-hidden lg:block">
          {signals.map((signal) => {
            const tone = toneClasses(signal.tone);
            return (
              <div key={signal.id}>
                <span
                  className={`absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${tone.dot}`}
                  style={{ left: `${signal.left}%`, top: `${signal.top}%` }}
                />
                <article
                  className={`pointer-events-auto absolute w-[220px] -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-xl border p-2.5 shadow-2xl backdrop-blur ${tone.card}`}
                  style={{ left: `${signal.left}%`, top: `${signal.top}%` }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-[8px] font-semibold uppercase tracking-[0.13em] text-content-faint">{signal.source}</div>
                    <div className={`font-mono text-xs font-bold ${tone.impact}`}>
                      {signal.impact >= 0 ? "+" : ""}{signal.impact.toFixed(1)}
                    </div>
                  </div>
                  <div className="mt-1 text-[10px] font-semibold leading-4 text-content">{signal.title}</div>
                  <p className="mt-1 text-[9px] leading-4 text-content-muted">{signal.detail}</p>
                </article>
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid gap-3 xl:grid-cols-[1.2fr_.8fr]">
        <article className="surface-panel rounded-2xl border border-bg-border p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-[0.15em] text-content-faint">Общий вывод по монете</div>
              <div className="mt-2 flex items-end gap-2">
                <span className="font-mono text-6xl font-bold leading-none text-content">{score}</span>
                <span className="pb-1 text-lg font-semibold text-content-faint">/100</span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[9px] uppercase tracking-wider text-content-faint">Вероятный диапазон</div>
              <div className="mt-1 font-mono text-lg font-bold text-content">{scoreRange}</div>
            </div>
          </div>

          <h2 className="mt-4 text-base font-semibold text-content">{verdict}</h2>
          <p className="mt-1 text-xs leading-5 text-content-muted">
            Итог пересчитывается по всем доступным параметрам, но на график попадают только события, способные заметно изменить торговый тезис: smart-money, whale, крупный инфлюенсер, сильный Telegram-сигнал и существенное изменение ликвидности.
          </p>

          <div className="mt-4 grid gap-2 sm:grid-cols-4">
            <Metric label="Уверенность" value={`${confidence.toFixed(0)}%`} />
            <Metric label="Устойчивость" value={`${stability.toFixed(0)}/100`} />
            <Metric label="Покрытие" value="124/129" />
            <Metric label="Значимых событий" value={String(signals.length)} />
          </div>
        </article>

        <article className="surface-panel rounded-2xl border border-bg-border p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-[0.15em] text-content-faint">Значимые события</div>
              <h2 className="mt-1 text-sm font-semibold text-content">Что сейчас меняет итог</h2>
            </div>
            <button
              type="button"
              onClick={addSignal}
              className="rounded-lg border border-bg-border bg-bg-elevated px-2.5 py-1.5 text-[10px] font-semibold text-content-muted hover:text-content"
            >
              + событие
            </button>
          </div>

          <div className="mt-3 space-y-2">
            {[...signals].reverse().map((signal) => {
              const tone = toneClasses(signal.tone);
              return (
                <div key={signal.id} className="grid grid-cols-[50px_1fr_auto] items-start gap-2 rounded-lg border border-bg-border bg-bg-card p-2.5">
                  <span className={`font-mono text-xs font-bold ${tone.impact}`}>{signal.impact >= 0 ? "+" : ""}{signal.impact.toFixed(1)}</span>
                  <div>
                    <div className="text-[10px] font-semibold text-content">{signal.title}</div>
                    <div className="mt-0.5 text-[9px] leading-4 text-content-faint">{signal.source}</div>
                  </div>
                  <span className="text-[8px] uppercase tracking-wider text-content-faint">значимо</span>
                </div>
              );
            })}
          </div>
        </article>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-card p-3">
      <div className="text-[8px] uppercase tracking-wider text-content-faint">{label}</div>
      <div className="mt-1 font-mono text-sm font-bold text-content">{value}</div>
    </div>
  );
}
