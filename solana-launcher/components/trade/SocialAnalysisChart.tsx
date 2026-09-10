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
import ActivityPanel from "@/components/chart/ActivityPanel";
import { useOHLCV } from "@/hooks/useOHLCV";
import {
  applyChartTheme,
  CHART_COLORS,
  CHART_FONTS,
  formatMcap,
} from "@/lib/chart/config";
import type { Timeframe } from "@/lib/chart/types";

const TIMEFRAMES: Array<{ value: Timeframe; label: string }> = [
  { value: "1s", label: "1s" },
  { value: "5s", label: "5s" },
  { value: "15s", label: "15s" },
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1D" },
];

const PUMP_SUPPLY = 1_000_000_000;
const MAX_RENDERED_CANDLES = 700;
const FALLBACK_CHART_HEIGHT = 400;

type MetricMode = "mcap" | "price";

function formatTokenPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (value >= 1) return `$${value.toFixed(4)}`;
  if (value >= 0.01) return `$${value.toFixed(5)}`;
  if (value >= 0.0001) return `$${value.toFixed(6)}`;
  if (value >= 0.000001) return `$${value.toFixed(8)}`;
  return `$${value.toFixed(10)}`;
}

function formatMcapAxis(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 1 : 2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return `$${value.toFixed(0)}`;
}

function isSecondTimeframe(timeframe: Timeframe): boolean {
  return timeframe === "1s" || timeframe === "5s" || timeframe === "15s";
}

export default function SocialAnalysisChart({
  mint,
  symbol,
}: {
  mint: string;
  symbol?: string | null;
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>("5s");
  const [metricMode, setMetricMode] = useState<MetricMode>("mcap");
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

    const measuredHeight = Math.max(container.clientHeight || FALLBACK_CHART_HEIGHT, 220);
    const chart = createChart(container, {
      width: container.clientWidth,
      height: measuredHeight,
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
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: CHART_COLORS.crosshair, labelBackgroundColor: CHART_COLORS.crosshairLabel },
        horzLine: { color: CHART_COLORS.crosshair, labelBackgroundColor: CHART_COLORS.crosshairLabel },
      },
      rightPriceScale: {
        visible: true,
        borderVisible: true,
        borderColor: CHART_COLORS.border,
        entireTextOnly: true,
        scaleMargins: { top: 0.06, bottom: 0.22 },
      },
      timeScale: {
        borderColor: CHART_COLORS.border,
        timeVisible: true,
        secondsVisible: true,
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
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: {
        type: "custom",
        minMove: 1,
        formatter: formatMcapAxis,
      },
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("volume").applyOptions({
      visible: false,
      scaleMargins: { top: 0.83, bottom: 0 },
    });

    chartRef.current = chart;
    candlesRef.current = candleSeries;
    volumeRef.current = volumeSeries;
    applyChartTheme(chart);

    const resizeObserver = new ResizeObserver(() => {
      const currentContainer = containerRef.current;
      const currentChart = chartRef.current;
      if (!currentContainer || !currentChart) return;
      const nextHeight = Math.max(currentContainer.clientHeight || FALLBACK_CHART_HEIGHT, 220);
      currentChart.applyOptions({
        width: currentContainer.clientWidth,
        height: nextHeight,
      });
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
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().applyOptions({
      timeVisible: true,
      secondsVisible: isSecondTimeframe(timeframe),
    });
  }, [timeframe]);

  useEffect(() => {
    const candleSeries = candlesRef.current;
    const volumeSeries = volumeRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart) return;

    const multiplier = metricMode === "mcap" ? PUMP_SUPPLY : 1;
    candleSeries.applyOptions({
      priceFormat: metricMode === "mcap"
        ? {
            type: "custom",
            minMove: 1,
            formatter: formatMcapAxis,
          }
        : {
            type: "custom",
            minMove: 0.0000000001,
            formatter: formatTokenPrice,
          },
      priceLineVisible: true,
      lastValueVisible: true,
    });

    const candleData: CandlestickData[] = visibleCandles.map((candle) => ({
      time: candle.time as Time,
      open: candle.open * multiplier,
      high: candle.high * multiplier,
      low: candle.low * multiplier,
      close: candle.close * multiplier,
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
    } else if (visibleCandles.length > 0) {
      const count = visibleCandles.length;
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, count - (isSecondTimeframe(timeframe) ? 150 : 110)),
        to: count + 6,
      });
    }
    previousTimeframeRef.current = timeframe;
  }, [timeframe, metricMode, visibleCandles]);

  const changeTone = change24h > 0 ? "text-success" : change24h < 0 ? "text-danger" : "text-content-muted";
  const displayedValue = metricMode === "mcap" ? formatMcap(lastPrice) : formatTokenPrice(lastPrice);

  return (
    <section
      className="surface-panel col-span-full overflow-hidden rounded-2xl border border-bg-border [&+section]:hidden"
      data-tag="trade.social_analysis_chart.v4"
    >
      <div className="grid md:h-[520px] md:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_350px]">
        <div className="flex min-h-[479px] min-w-0 flex-col border-b border-bg-border bg-bg-card md:h-full md:min-h-0 md:border-b-0 md:border-r">
          <div className="flex min-h-[79px] shrink-0 flex-col gap-2 border-b border-bg-border px-3 py-2.5 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-content-faint">
                  {metricMode === "mcap" ? "Market Cap" : "Token Price"}
                </span>
                <h2 className="text-sm font-semibold text-content">{symbol ? `$${symbol.replace(/^\$/, "")}` : "TOKEN"}</h2>
                <span className="font-mono text-lg font-bold text-content">{displayedValue}</span>
                <span className={`font-mono text-xs font-semibold ${changeTone}`}>
                  {Number.isFinite(change24h) ? `${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%` : "—"}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-[9px] text-content-faint">
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                <span className="uppercase tracking-[0.12em]">{dataSource || "market"}</span>
                <span>·</span>
                <span>{metricMode === "mcap" ? "MC = token price × 1B supply" : "USD price per token"}</span>
              </div>
            </div>

            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <div className="flex shrink-0 rounded-md border border-bg-border bg-bg-elevated/45 p-0.5">
                <button
                  type="button"
                  onClick={() => setMetricMode("mcap")}
                  className={`rounded px-2 py-1 text-[9px] font-bold transition ${
                    metricMode === "mcap" ? "bg-primary-soft text-primary" : "text-content-faint hover:text-content"
                  }`}
                >
                  MC
                </button>
                <button
                  type="button"
                  onClick={() => setMetricMode("price")}
                  className={`rounded px-2 py-1 text-[9px] font-bold transition ${
                    metricMode === "price" ? "bg-primary-soft text-primary" : "text-content-faint hover:text-content"
                  }`}
                >
                  PRICE
                </button>
              </div>

              <div className="custom-scrollbar flex min-w-0 max-w-full gap-1 overflow-x-auto pb-0.5">
                {TIMEFRAMES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setTimeframe(item.value)}
                    className={`shrink-0 rounded-md border px-2 py-1.5 text-[9px] font-semibold transition ${
                      timeframe === item.value
                        ? "border-primary-border bg-primary-soft text-primary"
                        : "border-bg-border bg-bg-elevated/45 text-content-muted hover:bg-bg-elevated hover:text-content"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="relative h-[400px] shrink-0 bg-bg-card md:h-auto md:min-h-0 md:flex-1 md:shrink">
            <div ref={containerRef} className="absolute inset-0" />
            {isLoading ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg-overlay/50">
                <div className="h-7 w-7 animate-spin rounded-full border-2 border-bg-border border-t-primary" />
              </div>
            ) : null}
            {error && !isLoading && visibleCandles.length === 0 ? (
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
            ) : null}
          </div>
        </div>

        <div className="h-[400px] min-h-0 overflow-hidden bg-bg-card md:h-full">
          <ActivityPanel mint={mint} />
        </div>
      </div>
    </section>
  );
}
