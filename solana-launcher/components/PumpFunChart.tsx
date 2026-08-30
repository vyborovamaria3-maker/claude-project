"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  CrosshairMode,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { useOHLCV } from "@/hooks/useOHLCV";
import { useTradeStream, type TradeItem } from "@/hooks/useTradeStream";
import ChartHeader from "./chart/ChartHeader";
import ChartToolbar from "./chart/ChartToolbar";
import CandleTitleBar from "./chart/CandleTitleBar";
import BottomTabs from "./chart/BottomTabs";
import { type Timeframe } from "@/lib/chart/types";
import type { Candle } from "@/lib/chart/types";
import { applyChartTheme, CHART_COLORS, CHART_DIMENSIONS, CHART_FONTS } from "@/lib/chart/config";
import { formatMcap } from "@/lib/chart/formatters";

const ActivityPanel = dynamic(() => import("./chart/ActivityPanel"), {
  ssr: false,
  loading: () => (
    <div className="w-72 flex flex-col border-l border-bg-border bg-bg-card min-w-0">
      <div className="px-3 py-2 border-b border-bg-border">
        <div className="text-xs font-semibold text-content">Активность</div>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
      </div>
    </div>
  ),
});

export type PumpFunChartSignal = {
  id: string;
  time: number;
  shortLabel: string;
  impact: number;
  tone: "positive" | "negative" | "social" | "warning";
};

interface Props {
  mint: string;
  symbol?: string;
  tokenName?: string;
  intelligenceSignals?: PumpFunChartSignal[];
}

const TF_VIEWPORT: Record<Timeframe, { visibleBars: number; barSpacing: number; rightOffset: number }> = {
  "1s": { visibleBars: 120, barSpacing: 10, rightOffset: 12 },
  "5s": { visibleBars: 120, barSpacing: 9, rightOffset: 12 },
  "15s": { visibleBars: 100, barSpacing: 8, rightOffset: 10 },
  "1m": { visibleBars: 90, barSpacing: 7, rightOffset: 9 },
  "5m": { visibleBars: 80, barSpacing: 9, rightOffset: 8 },
  "15m": { visibleBars: 72, barSpacing: 10, rightOffset: 8 },
  "1h": { visibleBars: 60, barSpacing: 11, rightOffset: 7 },
  "4h": { visibleBars: 48, barSpacing: 12, rightOffset: 6 },
  "1d": { visibleBars: 40, barSpacing: 14, rightOffset: 5 },
};

function applyViewport(chart: IChartApi | null, timeframe: Timeframe, candleCount: number) {
  if (!chart || candleCount <= 0) return;

  const cfg = TF_VIEWPORT[timeframe];
  const isSubMinute = timeframe === "1s" || timeframe === "5s" || timeframe === "15s";

  chart.applyOptions({
    timeScale: {
      barSpacing: cfg.barSpacing,
      rightOffset: cfg.rightOffset,
      timeVisible: true,
      secondsVisible: isSubMinute,
    },
  });

  const visibleBars = Math.max(20, cfg.visibleBars);
  const rightPad = Math.max(4, Math.round(cfg.rightOffset));
  const from = candleCount > visibleBars ? candleCount - visibleBars : 0;
  const to = candleCount + rightPad;

  chart.timeScale().setVisibleLogicalRange({ from, to });
}

function nearestCandleTime(candles: Candle[], eventTime: number): Time | null {
  if (!candles.length || !Number.isFinite(eventTime)) return null;
  const target = eventTime >= 1e12 ? Math.floor(eventTime / 1000) : Math.floor(eventTime);
  let low = 0;
  let high = candles.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].time < target) low = middle + 1;
    else high = middle;
  }
  const right = candles[low];
  const left = candles[Math.max(0, low - 1)];
  const closest = Math.abs(right.time - target) < Math.abs(left.time - target) ? right : left;
  return closest.time as Time;
}

function markerColor(tone: PumpFunChartSignal["tone"]) {
  if (tone === "positive") return CHART_COLORS.up;
  if (tone === "negative") return CHART_COLORS.down;
  if (tone === "warning") return "#f59e0b";
  return "#a855f7";
}

export default function PumpFunChart({ mint, symbol, tokenName, intelligenceSignals = [] }: Props) {
  const [tf, setTf] = useState<Timeframe>("1m");
  const handleTfChange = useCallback((newTf: Timeframe) => {
    if (newTf === tf) return;
    setHoveredCandle(null);
    setTf(newTf);
  }, [tf]);
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);

  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markerPluginRef = useRef<ReturnType<typeof createSeriesMarkers> | null>(null);

  const {
    candles,
    lastPrice,
    change24h,
    isLoading,
    isOnline,
    ingestTrade,
    error,
    retry,
  } = useOHLCV(mint, tf);

  const normalizedCandles = candles;

  const handleLiveTrade = useCallback((trade: TradeItem) => {
    ingestTrade({
      mint,
      solAmount: trade.solAmount,
      tokenAmount: trade.tokenAmount,
      isBuy: trade.isBuy,
      timestamp: trade.ts,
      priceUsd: trade.priceUsd,
      signature: trade.signature,
    });
  }, [ingestTrade, mint]);

  useTradeStream(mint, 25, handleLiveTrade, { headless: true });

  // Init chart once. Theme changes only update chart options, not data or viewport.
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container || chartRef.current) return;

    const chart = createChart(container, {
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
        borderColor: CHART_COLORS.border,
        scaleMargins: CHART_DIMENSIONS.priceScaleMargins,
      },
      timeScale: {
        borderColor: CHART_COLORS.border,
        rightOffset: CHART_DIMENSIONS.rightOffset,
        barSpacing: CHART_DIMENSIONS.barSpacingDesktop,
        timeVisible: true,
        secondsVisible: true,
      },
      handleScroll: { vertTouchDrag: false },
      width: container.clientWidth,
      height: container.clientHeight || 300,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.up,
      downColor: CHART_COLORS.down,
      borderUpColor: CHART_COLORS.up,
      borderDownColor: CHART_COLORS.down,
      wickUpColor: CHART_COLORS.up,
      wickDownColor: CHART_COLORS.down,
      borderVisible: true,
      priceLineVisible: false,
      priceFormat: {
        type: "custom",
        formatter: (price: number) => formatMcap(price),
        minMove: 0.000000001,
      },
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: CHART_COLORS.up,
    });

    chart.priceScale("vol").applyOptions({
      scaleMargins: CHART_DIMENSIONS.volumeScaleMargins,
    });

    markerPluginRef.current = createSeriesMarkers(candleSeries, [], { autoScale: false });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) {
        setHoveredCandle(null);
        return;
      }
      const data = param.seriesData.get(candleSeries) as CandlestickData | undefined;
      if (data && "open" in data) {
        setHoveredCandle({
          time: param.time as number,
          open: data.open,
          high: data.high,
          low: data.low,
          close: data.close,
          volume: 0,
        });
      }
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    applyChartTheme(chart);

    let resizeTimeout: NodeJS.Timeout | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (container && chartRef.current) {
          chartRef.current.applyOptions({
            width: container.clientWidth,
            height: container.clientHeight || 300,
          });
        }
      }, 100);
    });
    ro.observe(container);

    const onThemeApplied = () => applyChartTheme(chartRef.current);
    window.addEventListener("potapoff:theme-applied", onThemeApplied);

    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      ro.disconnect();
      window.removeEventListener("potapoff:theme-applied", onThemeApplied);
      markerPluginRef.current?.detach();
      markerPluginRef.current = null;
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  const prevTfRef = useRef(tf);
  const didFitRef = useRef(false);
  const prevLengthRef = useRef(0);
  const prevLastTimeRef = useRef<number | null>(null);

  useEffect(() => {
    const cs = candleSeriesRef.current;
    const vs = volumeSeriesRef.current;
    if (!cs || !vs) return;

    const tfChanged = prevTfRef.current !== tf;
    if (tfChanged) {
      prevTfRef.current = tf;
      didFitRef.current = false;
      prevLengthRef.current = 0;
      prevLastTimeRef.current = null;
      try {
        cs.setData([]);
        vs.setData([]);
      } catch {}
    }

    if (normalizedCandles.length === 0) return;

    const last = normalizedCandles[normalizedCandles.length - 1];
    const prevLen = prevLengthRef.current;
    const prevLastTime = prevLastTimeRef.current;

    const canUseUpdate =
      didFitRef.current &&
      normalizedCandles.length > 0 &&
      ((normalizedCandles.length === prevLen && last.time === prevLastTime) ||
       (normalizedCandles.length === prevLen + 1 && last.time > (prevLastTime || 0)));

    prevLengthRef.current = normalizedCandles.length;
    prevLastTimeRef.current = last.time;

    if (canUseUpdate) {
      try {
        cs.update({ time: last.time as Time, open: last.open, high: last.high, low: last.low, close: last.close });
        vs.update({
          time: last.time as Time,
          value: last.volume,
          color: last.close >= last.open ? `${CHART_COLORS.up}88` : `${CHART_COLORS.down}88`,
        });
      } catch {}
      return;
    }

    const candleData: CandlestickData[] = normalizedCandles.map((c) => ({
      time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    const volumeData: HistogramData[] = normalizedCandles.map((c) => ({
      time: c.time as Time,
      value: c.volume,
      color: c.close >= c.open ? `${CHART_COLORS.up}88` : `${CHART_COLORS.down}88`,
    }));

    try {
      cs.setData(candleData);
      vs.setData(volumeData);
      if (!didFitRef.current || tfChanged) {
        didFitRef.current = true;
        applyViewport(chartRef.current, tf, normalizedCandles.length);
      }
    } catch {}
  }, [normalizedCandles, tf]);

  useEffect(() => {
    const plugin = markerPluginRef.current;
    if (!plugin) return;
    if (normalizedCandles.length === 0) {
      plugin.setMarkers([]);
      return;
    }
    const markers = intelligenceSignals
      .map((signal): SeriesMarker<Time> | null => {
        const time = nearestCandleTime(normalizedCandles, signal.time);
        if (time == null) return null;
        return {
          id: signal.id,
          time,
          position: signal.impact >= 0 ? "belowBar" : "aboveBar",
          color: markerColor(signal.tone),
          shape: signal.tone === "social" ? "circle" : signal.impact >= 0 ? "arrowUp" : "arrowDown",
          text: signal.shortLabel.slice(0, 28),
          size: 1.1,
        };
      })
      .filter((marker): marker is SeriesMarker<Time> => marker != null)
      .sort((left, right) => Number(left.time) - Number(right.time));
    plugin.setMarkers(markers);
  }, [intelligenceSignals, normalizedCandles]);

  const handleResetZoom = useCallback(() => {
    applyViewport(chartRef.current, tf, normalizedCandles.length);
  }, [normalizedCandles.length, tf]);

  const handleFitCurrent = useCallback(() => {
    applyViewport(chartRef.current, tf, normalizedCandles.length);
  }, [normalizedCandles.length, tf]);

  const displaySymbol = symbol || "TOKEN";

  return (
    <div className="flex flex-col h-full w-full bg-bg-card text-content" data-tag="components.pump_fun_chart">
      <ChartHeader
        mint={mint}
        symbol={displaySymbol}
        name={tokenName || ""}
        lastPrice={lastPrice}
        change24h={change24h}
        isOnline={isOnline}
        candles={normalizedCandles}
        timeframe={tf}
      />

      <CandleTitleBar
        symbol={displaySymbol}
        timeframe={tf}
        candle={hoveredCandle}
      />

      <ChartToolbar
        timeframe={tf}
        onTimeframeChange={handleTfChange}
        onResetZoom={handleResetZoom}
        onFitCurrent={handleFitCurrent}
      />

      <div className="flex min-h-0" style={{ height: 300 }}>
        <div className="flex-1 min-h-0 relative bg-bg-card">
          <div ref={chartContainerRef} className="w-full h-full" style={{ minHeight: 300 }} />
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-bg-overlay/70 pointer-events-none">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          )}
          {error && !isLoading && normalizedCandles.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg-overlay/85">
              <p className="text-red-400 text-sm mb-3">{error}</p>
              <button
                type="button"
                onClick={retry}
                className="px-4 py-1.5 rounded bg-primary-soft text-primary text-sm hover:brightness-110 transition"
              >
                Retry
              </button>
            </div>
          )}
          {error && normalizedCandles.length > 0 && (
            <div className="absolute top-2 right-2 z-10 rounded-md border border-[#ef5350]/30 bg-[#ef5350]/10 px-2 py-1 text-[10px] text-[#ef5350]">
              {error}
            </div>
          )}
        </div>

        <div className="w-72 flex flex-col border-l border-bg-border overflow-hidden bg-bg-card">
          <ActivityPanel mint={mint} />
        </div>
      </div>

      <BottomTabs mint={mint} />
    </div>
  );
}
