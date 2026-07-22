"use client";
// data-tag: hooks.use_chart_markers
// Chart marker management (dev trades, bundles) - separated from PumpFunChart

import { useState, useRef, useCallback, useMemo } from "react";
import type { SeriesMarker, Time } from "lightweight-charts";

export interface ChartMarker {
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle";
  text: string;
  signature?: string; // for deduplication
}

interface UseChartMarkersOptions {
  maxMarkers?: number;
}

interface UseChartMarkersReturn {
  // Dev markers
  devMarkers: ChartMarker[];
  addDevMarker: (marker: ChartMarker) => void;
  hasDevMarker: (signature: string) => boolean;
  setDevMarkers: (markers: ChartMarker[]) => void;
  devMarkerCount: number;

  // Bundle markers
  bundleMarkers: ChartMarker[];
  addBundleMarker: (marker: ChartMarker) => void;
  setBundleMarkers: (markers: ChartMarker[]) => void;
  bundleMarkerCount: number;

  // Combined for chart
  allMarkers: SeriesMarker<Time>[];
  showDev: boolean;
  showBundle: boolean;
  setShowDev: (show: boolean) => void;
  setShowBundle: (show: boolean) => void;

  // Actions
  clearMarkers: () => void;
  clearDevMarkers: () => void;
  clearBundleMarkers: () => void;
}

export function useChartMarkers(options: UseChartMarkersOptions = {}): UseChartMarkersReturn {
  const { maxMarkers = 500 } = options;

  const [devMarkers, setDevMarkersState] = useState<ChartMarker[]>([]);
  const [bundleMarkers, setBundleMarkersState] = useState<ChartMarker[]>([]);
  const [showDev, setShowDev] = useState(true);
  const [showBundle, setShowBundle] = useState(false);

  const seenDevSigs = useRef<Set<string>>(new Set());
  const seenBundleSigs = useRef<Set<string>>(new Set());

  // Add dev marker with deduplication
  const addDevMarker = useCallback((marker: ChartMarker) => {
    if (marker.signature && seenDevSigs.current.has(marker.signature)) return;
    if (marker.signature) seenDevSigs.current.add(marker.signature);

    setDevMarkersState(prev => {
      const next = [...prev, marker].sort((a, b) => a.time - b.time);
      // Limit and cleanup old signatures
      if (next.length > maxMarkers) {
        const removed = next.slice(0, next.length - maxMarkers);
        removed.forEach(m => {
          if (m.signature) seenDevSigs.current.delete(m.signature);
        });
        return next.slice(-maxMarkers);
      }
      return next;
    });
  }, [maxMarkers]);

  // Add bundle marker with deduplication
  const addBundleMarker = useCallback((marker: ChartMarker) => {
    if (marker.signature && seenBundleSigs.current.has(marker.signature)) return;
    if (marker.signature) seenBundleSigs.current.add(marker.signature);

    setBundleMarkersState(prev => {
      const next = [...prev, marker].sort((a, b) => a.time - b.time);
      if (next.length > maxMarkers) {
        const removed = next.slice(0, next.length - maxMarkers);
        removed.forEach(m => {
          if (m.signature) seenBundleSigs.current.delete(m.signature);
        });
        return next.slice(-maxMarkers);
      }
      return next;
    });
  }, [maxMarkers]);

  // Check if dev marker exists
  const hasDevMarker = useCallback((signature: string) => {
    return seenDevSigs.current.has(signature);
  }, []);

  // Set dev markers (bulk, for historical loading)
  const setDevMarkers = useCallback((markers: ChartMarker[]) => {
    seenDevSigs.current.clear();
    markers.forEach(m => {
      if (m.signature) seenDevSigs.current.add(m.signature);
    });
    setDevMarkersState(markers.sort((a, b) => a.time - b.time));
  }, []);

  // Set bundle markers
  const setBundleMarkers = useCallback((markers: ChartMarker[]) => {
    seenBundleSigs.current.clear();
    markers.forEach(m => {
      if (m.signature) seenBundleSigs.current.add(m.signature);
    });
    setBundleMarkersState(markers.sort((a, b) => a.time - b.time));
  }, []);

  // Clear all
  const clearMarkers = useCallback(() => {
    setDevMarkersState([]);
    setBundleMarkersState([]);
    seenDevSigs.current.clear();
    seenBundleSigs.current.clear();
  }, []);

  const clearDevMarkers = useCallback(() => {
    setDevMarkersState([]);
    seenDevSigs.current.clear();
  }, []);

  const clearBundleMarkers = useCallback(() => {
    setBundleMarkersState([]);
    seenBundleSigs.current.clear();
  }, []);

  // Combined markers for chart
  const allMarkers = useMemo<SeriesMarker<Time>[]>(() => {
    const result: SeriesMarker<Time>[] = [];

    if (showDev) {
      result.push(...devMarkers.map(m => ({
        time: m.time as Time,
        position: m.position,
        color: m.color,
        shape: m.shape,
        text: m.text,
      })));
    }

    if (showBundle) {
      result.push(...bundleMarkers.map(m => ({
        time: m.time as Time,
        position: m.position,
        color: m.color,
        shape: m.shape,
        text: m.text,
      })));
    }

    return result.sort((a, b) => Number(a.time) - Number(b.time));
  }, [devMarkers, bundleMarkers, showDev, showBundle]);

  return {
    devMarkers,
    addDevMarker,
    hasDevMarker,
    setDevMarkers,
    devMarkerCount: devMarkers.length,

    bundleMarkers,
    addBundleMarker,
    setBundleMarkers,
    bundleMarkerCount: bundleMarkers.length,

    allMarkers,
    showDev,
    showBundle,
    setShowDev,
    setShowBundle,

    clearMarkers,
    clearDevMarkers,
    clearBundleMarkers
  };
}
