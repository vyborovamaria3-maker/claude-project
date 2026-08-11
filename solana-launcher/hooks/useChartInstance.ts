"use client";
// data-tag: hooks.use_chart_instance
// Lightweight-charts instance management - separated from PumpFunChart

import { useEffect, useRef, useCallback } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  CrosshairMode,
  ColorType,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import { applyChartTheme, CHART_COLORS, CHART_DIMENSIONS, CHART_FONTS } from "@/lib/chart/config";
import { formatPrice } from "@/lib/chart/formatters";

interface UseChartInstanceOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onCrosshairMove?: (time: number, price: number) => void;
}

interface ChartInstance {
  chart: IChartApi;
  candleSeries: ISeriesApi<"Candlestick">;
  volumeSeries: ISeriesApi<"Histogram">;
  cleanup: () => void;
}

export function useChartInstance({ containerRef, onCrosshairMove }: UseChartInstanceOptions) {
  const instanceRef = useRef<ChartInstance | null>(null);

  const initChart = useCallback(() => {
    const container = containerRef.current;
    if (!container || instanceRef.current) return;

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
        formatter: (price: number) => formatPrice(price),
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

    if (onCrosshairMove) {
      chart.subscribeCrosshairMove((param) => {
        if (!param.time || !param.point) return;
        const data = param.seriesData.get(candleSeries);
        if (data && typeof data === "object" && "close" in data) {
          onCrosshairMove(param.time as number, data.close as number);
        }
      });
    }

    const instance: ChartInstance = {
      chart,
      candleSeries,
      volumeSeries,
      cleanup: () => {
        chart.remove();
      },
    };

    instanceRef.current = instance;
    applyChartTheme(chart);
    return instance;
  }, [containerRef, onCrosshairMove]);

  useEffect(() => {
    return () => {
      instanceRef.current?.cleanup();
      instanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const container = containerRef.current;
      const chart = instanceRef.current?.chart;
      if (!container || !chart) return;

      const rect = container.getBoundingClientRect();
      chart.applyOptions({
        width: rect.width,
        height: rect.height,
      });
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [containerRef]);

  // Canvas content lives outside CSS cascade, so re-apply palette after ThemeRuntime
  // finalizes adaptive variables. Data, viewport and series state remain untouched.
  useEffect(() => {
    const handleThemeApplied = () => applyChartTheme(instanceRef.current?.chart ?? null);
    window.addEventListener("potapoff:theme-applied", handleThemeApplied);
    return () => window.removeEventListener("potapoff:theme-applied", handleThemeApplied);
  }, []);

  return {
    instanceRef,
    initChart,
    getInstance: () => instanceRef.current,
  };
}
