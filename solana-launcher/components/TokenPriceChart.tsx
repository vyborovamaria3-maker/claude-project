"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  CrosshairMode,
  ColorType,
} from "lightweight-charts";
import { RefreshCw, AlertTriangle, Loader2 } from "lucide-react";
import { usePumpFunOHLCV } from "@/hooks/usePumpFunOHLCV";
import { TIMEFRAMES, type Timeframe } from "@/lib/chart/types";

// data-tag: components.token_price_chart

interface Props {
  mint: string;
}

function formatPrice(p: number) {
  if (!p) return "$0";
  if (p >= 1) return `$${p.toFixed(4)}`;
  if (p >= 0.01) return `$${p.toFixed(5)}`;
  return `$${p.toExponential(3)}`;
}

export default function TokenPriceChart({ mint }: Props) {
  const [tf, setTf] = useState<Timeframe>("1m");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastUpdate = useRef<number>(0);

  const { candles, pair, lastPrice, change24h, status, error, retry } =
    usePumpFunOHLCV(mint, tf);

  // Initialize chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 420,
      layout: {
        background: { type: ColorType.Solid, color: "#0a0a0f" },
        textColor: "#9ca3af",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1f1f2e" },
        horzLines: { color: "#1f1f2e" },
      },
      rightPriceScale: { borderColor: "#1f1f2e" },
      timeScale: {
        borderColor: "#1f1f2e",
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 6,
        minBarSpacing: 2,
        rightOffset: 2,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#3f3f5e", width: 1, style: 2 },
        horzLine: { color: "#3f3f5e", width: 1, style: 2 },
      },
    });

    const cs = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderUpColor: "#26a69a",
      borderDownColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      priceLineVisible: false,
      lastValueVisible: true,
    });

    const vs = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: "#26a69a",
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeries.current = cs;
    volumeSeries.current = vs;

    const onResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      candleSeries.current = null;
      volumeSeries.current = null;
    };
  }, [tf]);

  // Push data to chart — throttled to 500ms, incremental update() when possible.
  const prevCount = useRef(0);
  const prevLastTime = useRef(0);
  useEffect(() => {
    if (!candleSeries.current || !volumeSeries.current) return;
    if (candles.length === 0) return;
    const now = Date.now();
    if (now - lastUpdate.current < 500 && candles.length > 1) return;
    lastUpdate.current = now;

    const last = candles[candles.length - 1];
    const sameLen = candles.length === prevCount.current;
    const sameTime = last.time === prevLastTime.current;
    const appendOne = candles.length === prevCount.current + 1 && last.time > prevLastTime.current;

    if (prevCount.current > 0 && ((sameLen && sameTime) || appendOne)) {
      // FAST PATH — only the live candle changed or one new bucket appended.
      // series.update() auto-extends viewport; no setData / fitContent jitter.
      candleSeries.current.update({
        time: last.time as UTCTimestamp,
        open: last.open, high: last.high, low: last.low, close: last.close,
      });
      volumeSeries.current.update({
        time: last.time as UTCTimestamp,
        value: last.volume,
        color: last.close >= last.open ? "rgba(38,166,154,0.5)" : "rgba(239,83,80,0.5)",
      });
      prevCount.current = candles.length;
      prevLastTime.current = last.time;
      return;
    }

    // SLOW PATH — full rebuild (tf change / initial load / gap)
    candleSeries.current.setData(
      candles.map(c => ({
        time: c.time as UTCTimestamp,
        open: c.open, high: c.high, low: c.low, close: c.close,
      }))
    );
    volumeSeries.current.setData(
      candles.map(c => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? "rgba(38,166,154,0.5)" : "rgba(239,83,80,0.5)",
      }))
    );

    // Show last ~60 bars without forcing fitContent (which jerks the view).
    const ts = chartRef.current?.timeScale();
    if (ts && candles.length > 0) {
      const visibleCount = Math.min(60, candles.length);
      ts.setVisibleLogicalRange({
        from: candles.length - visibleCount,
        to: candles.length + 2,
      });
    }

    prevCount.current = candles.length;
    prevLastTime.current = last.time;
  }, [candles]);

  const isLoading = false; // placeholder candles seeded immediately — no blank state
  const isError = status === "error" && candles.length === 0;
  const change = change24h.pct;
  const changeColor = change >= 0 ? "text-[#26a69a]" : "text-[#ef5350]";
  const changeSign = change >= 0 ? "+" : "";

  const statusDot =
    status === "live"     ? { color: "bg-[#26a69a]", label: "Live" } :
    status === "polling"  ? { color: "bg-yellow-400", label: "Polling" } :
    status === "error"    ? { color: "bg-[#ef5350]", label: "Offline" } :
                            { color: "bg-white/30", label: "Connecting" };

  return (
    <div className="w-full bg-[#0a0a0f] border border-bg-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-bg-border">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white">
                {pair?.symbol ?? "—"}
              </span>
              <span className="text-xs text-white/40">{pair?.name ?? mint.slice(0, 6) + "…"}</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-base font-semibold text-white tabular-nums">
                {formatPrice(lastPrice)}
              </span>
              <span className={`text-xs font-semibold tabular-nums ${changeColor}`}>
                {changeSign}{change.toFixed(2)}% ({changeSign}${Math.abs(change24h.usd).toExponential(2)})
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${statusDot.color} ${status === "live" ? "animate-pulse" : ""}`} />
            <span className="text-[11px] text-white/50">{statusDot.label}</span>
          </div>
        </div>
      </div>

      {/* Timeframe bar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-bg-border">
        {TIMEFRAMES.map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTf(t)}
            className={[
              "px-2.5 py-1 rounded text-[11px] font-semibold transition",
              tf === t
                ? "bg-white/10 text-white"
                : "text-white/40 hover:text-white hover:bg-white/5",
            ].join(" ")}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Chart area */}
      <div className="relative">
        <div ref={containerRef} className="w-full" style={{ height: 420 }} />

        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0a0a0f]">
            <Loader2 className="w-6 h-6 text-white/40 animate-spin" />
            <p className="text-sm text-white/40">Загрузка данных…</p>
          </div>
        )}

        {isError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0a0a0f]">
            <AlertTriangle className="w-6 h-6 text-[#ef5350]" />
            <p className="text-sm text-white/60">{error ?? "Не удалось загрузить данные"}</p>
            <button
              type="button"
              onClick={retry}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs text-white transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Повторить
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
