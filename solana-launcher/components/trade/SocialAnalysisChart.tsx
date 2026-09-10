"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { useOHLCV } from "@/hooks/useOHLCV";
import { applyChartTheme, CHART_COLORS, CHART_FONTS } from "@/lib/chart/config";
import type { Timeframe } from "@/lib/chart/types";

const TIMEFRAMES: Array<{ value: Timeframe; label: string }> = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1D" },
];

const MAX_RENDERED_CANDLES = 900;

function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  if (value >= 0.01) return `$${value.toFixed(5)}`;
  if (value >= 0.0001) return `$${value.toFixed(7)}`;
  return `$${value.toExponential(3)}`;
}

export default function SocialAnalysisChart({
  mint,
  symbol,
}: {
  mint: string;
  symbol?: string | null;
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>("5m");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const previousTimeframeRef = useRef<Timeframe>(timeframe);

  const {
    candles,
    lastPrice,
    change24h,
    isLoading,
    error,
    retry,
    dataSource,
  } = useOHLCV(mint, timeframe);

  const visibleCandles = useMemo(
    () => (candles.length > MAX_RENDERED_CANDLES ? candles.slice(-MAX_RENDERED_CANDLES) : candles),
    [candles],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || chartRef.current) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: 338,
      layout: {
        background: { type: ColorType.Solid, color: CHART_COLORS.background },
        textColor: CHART_COLORS.text,
        fontFamily: CHART_FONTS.family,
        fontSize: CHART_FONTS.size,
      },
      grid: {
        vertLines: { color: CHART_COLORS.grid },
        horzLines: { color: CHART_COLORS.grid },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: CHART_COLORS.border,
        scaleMargins: { top: 0.08, bottom: 0.2 },
      },
      timeScale: {
        borderColor: CHART_COLORS.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 7,
      },
      handleScroll: { vertTouchDrag: false },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.up,
      downColor: CHART_COLORS.down,
      wickUpColor: CHART_COLORS.up,
      wickDownColor: CHART_COLORS.down,
      borderUpColor: CHART_COLORS.up,
      borderDownColor: CHART_COLORS.down,
      priceLineVisible: false,
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;
    candlesRef.current = candleSeries;
    volumeRef.current = volumeSeries;
    applyChartTheme(chart);

    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({ width: containerRef.current.clientWidth, height: 338 });
    });
    resizeObserver.observe(container);

    const applyTheme = () => applyChartTheme(chartRef.current);
    window.addEventListener("potapoff:theme-applied", applyTheme);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("potapoff:theme-applied", applyTheme);
      chart.remove();
      chartRef.current = null;
      candlesRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const candleSeries = candlesRef.current;
    const volumeSeries = volumeRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart) return;

    const candleData: CandlestickData[] = visibleCandles.map((candle) => ({
      time: candle.time as Time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));
    const volumeData: HistogramData[] = visibleCandles.map((candle) => ({
      time: candle.time as Time,
      value: candle.volume,
      color: candle.close >= candle.open ? `${CHART_COLORS.up}66` : `${CHART_COLORS.down}66`,
    }));

    candleSeries.setData(candleData);
    volumeSeries.setData(volumeData);

    if (visibleCandles.length > 0 && previousTimeframeRef.current !== timeframe) {
      chart.timeScale().fitContent();
    } else if (visibleCandles.length > 0 && previousTimeframeRef.current === timeframe) {
      const count = visibleCandles.length;
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, count - 100),
        to: count + 5,
      });
    }
    previousTimeframeRef.current = timeframe;
  }, [timeframe, visibleCandles]);

  const changeTone = change24h > 0 ? "text-success" : change24h < 0 ? "text-danger" : "text-content-muted";

  return (
    <section className="surface-panel overflow-hidden rounded-2xl border border-bg-border" data-tag="trade.social_analysis_chart.v1">
      <div className="flex flex-col gap-3 border-b border-bg-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-content">{symbol ? `$${symbol.replace(/^\$/, "")}` : "Price"}</h2>
            <span className="font-mono text-base font-bold text-content">{formatPrice(lastPrice)}</span>
            <span className={`font-mono text-xs font-semibold ${changeTone}`}>
              {Number.isFinite(change24h) ? `${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%` : "—"}
            </span>
          </div>
          <div className="mt-1 text-[9px] uppercase tracking-[0.16em] text-content-faint">
            {dataSource || "market"} · максимум {MAX_RENDERED_CANDLES} свечей в DOM
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TIMEFRAMES.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setTimeframe(item.value)}
              className={`rounded-lg border px-2.5 py-1 text-[10px] font-semibold transition ${
                timeframe === item.value
                  ? "border-primary-border bg-primary-soft text-primary"
                  : "border-bg-border bg-bg-card text-content-muted hover:text-content"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative h-[338px] bg-bg-card">
        <div ref={containerRef} className="h-full w-full" />
        {isLoading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg-overlay/60">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-bg-border border-t-primary" />
          </div>
        )}
        {error && !isLoading && visibleCandles.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg-overlay/80 px-6 text-center">
            <p className="text-xs text-danger">{error}</p>
            <button
              type="button"
              onClick={retry}
              className="rounded-lg border border-primary-border bg-primary-soft px-3 py-1.5 text-xs font-semibold text-primary"
            >
              Повторить
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
