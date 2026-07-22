"use client";
// data-tag: hooks.use_chart_data
// Optimized data management for chart components - separates data logic from rendering

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { type Candle, type Timeframe, type Trade, TF_SECONDS } from "@/lib/chart/types";

interface LiveCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface UseChartDataOptions {
  initialTimeframe?: Timeframe;
  maxCandles?: number;
}

interface UseChartDataReturn {
  // Timeframe state
  timeframe: Timeframe;
  setTimeframe: (tf: Timeframe) => void;
  
  // Data refs (for direct chart access without re-renders)
  candlesRef: React.MutableRefObject<Candle[]>;
  liveCandleRef: React.MutableRefObject<LiveCandle | null>;
  
  // Optimized updates
  updateWithTrade: (trade: Trade) => void;
  resetLiveCandle: () => void;
  getBucketForTimestamp: (ts: number) => number;
  
  // Hover state (minimal, for display only)
  hoveredCandle: Candle | null;
  setHoveredCandle: (c: Candle | null) => void;
  
  // Normalized candles for display
  normalizedCandles: Candle[];
  setNormalizedCandles: (candles: Candle[]) => void;
}

export function useChartData(
  mint: string,
  options: UseChartDataOptions = {}
): UseChartDataReturn {
  const { initialTimeframe = "1m" } = options;
  
  const [timeframe, setTimeframe] = useState<Timeframe>(initialTimeframe);
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const [normalizedCandles, setNormalizedCandles] = useState<Candle[]>([]);
  
  const candlesRef = useRef<Candle[]>([]);
  const liveCandleRef = useRef<LiveCandle | null>(null);
  const tfRef = useRef(timeframe);
  const seenSigsRef = useRef<Set<string>>(new Set());
  
  // Sync timeframe ref
  useEffect(() => {
    tfRef.current = timeframe;
  }, [timeframe]);
  
  // Reset on mint change
  useEffect(() => {
    candlesRef.current = [];
    liveCandleRef.current = null;
    seenSigsRef.current.clear();
    setHoveredCandle(null);
  }, [mint]);
  
  // Reset live candle on timeframe change
  useEffect(() => {
    liveCandleRef.current = null;
  }, [timeframe]);
  
  const getBucketForTimestamp = useCallback((ts: number): number => {
    const tfSec = TF_SECONDS[tfRef.current] ?? 60;
    return Math.floor(ts / tfSec) * tfSec;
  }, []);
  
  const updateWithTrade = useCallback((trade: Trade) => {
    if (!trade.priceUsd || !trade.solAmount || !trade.tokenAmount) return;
    if (trade.signature && seenSigsRef.current.has(trade.signature)) return;
    if (trade.signature) seenSigsRef.current.add(trade.signature);
    
    const tsSec = Math.floor(trade.timestamp / 1000);
    const tfSec = TF_SECONDS[tfRef.current] ?? 60;
    const bucket = Math.floor(tsSec / tfSec) * tfSec;
    const price = trade.priceUsd;
    
    const prev = liveCandleRef.current;
    let lc: LiveCandle | null;
    
    if (!prev || prev.time !== bucket) {
      // New bucket
      lc = { 
        time: bucket, 
        open: prev?.close ?? price, 
        high: price, 
        low: price, 
        close: price, 
        volume: trade.solAmount 
      };
    } else {
      // Update current bucket
      lc = { 
        time: bucket, 
        open: prev.open, 
        high: Math.max(prev.high, price), 
        low: Math.min(prev.low, price), 
        close: price, 
        volume: prev.volume + trade.solAmount 
      };
    }
    
    liveCandleRef.current = lc;
  }, []);
  
  const resetLiveCandle = useCallback(() => {
    liveCandleRef.current = null;
  }, []);
  
  return useMemo(() => ({
    timeframe,
    setTimeframe,
    candlesRef,
    liveCandleRef,
    updateWithTrade,
    resetLiveCandle,
    getBucketForTimestamp,
    hoveredCandle,
    setHoveredCandle,
    normalizedCandles,
    setNormalizedCandles,
  }), [
    timeframe,
    hoveredCandle,
    normalizedCandles,
    updateWithTrade,
    resetLiveCandle,
    getBucketForTimestamp,
  ]);
}

// Hook for managing markers with optimized re-renders
export interface ChartMarker {
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle";
  text: string;
}

interface UseChartMarkersOptions {
  maxMarkers?: number;
}

interface UseChartMarkersReturn {
  devMarkers: ChartMarker[];
  bundleMarkers: ChartMarker[];
  addDevMarker: (marker: ChartMarker, signature: string) => void;
  addBundleMarker: (marker: ChartMarker, signature: string) => void;
  clearMarkers: () => void;
  seenDevSigs: Set<string>;
}

export function useChartMarkers(
  _mint: string,
  options: UseChartMarkersOptions = {}
): UseChartMarkersReturn {
  const { maxMarkers = 500 } = options;
  
  const [devMarkers, setDevMarkers] = useState<ChartMarker[]>([]);
  const [bundleMarkers, setBundleMarkers] = useState<ChartMarker[]>([]);
  const seenDevSigsRef = useRef<Set<string>>(new Set());
  
  const addDevMarker = useCallback((marker: ChartMarker, signature: string) => {
    if (seenDevSigsRef.current.has(signature)) return;
    seenDevSigsRef.current.add(signature);
    
    setDevMarkers(prev => {
      const next = [...prev, marker].sort((a, b) => a.time - b.time);
      return next.length > maxMarkers ? next.slice(-maxMarkers) : next;
    });
  }, [maxMarkers]);
  
  const addBundleMarker = useCallback((marker: ChartMarker) => {
    setBundleMarkers(prev => {
      const next = [...prev, marker].sort((a, b) => a.time - b.time);
      return next.length > maxMarkers ? next.slice(-maxMarkers) : next;
    });
  }, [maxMarkers]);
  
  const clearMarkers = useCallback(() => {
    setDevMarkers([]);
    setBundleMarkers([]);
    seenDevSigsRef.current.clear();
  }, []);
  
  return useMemo(() => ({
    devMarkers,
    bundleMarkers,
    addDevMarker,
    addBundleMarker,
    clearMarkers,
    seenDevSigs: seenDevSigsRef.current,
  }), [devMarkers, bundleMarkers, addDevMarker, addBundleMarker, clearMarkers]);
}
