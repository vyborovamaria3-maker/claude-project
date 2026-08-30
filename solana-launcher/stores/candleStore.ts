// data-tag: stores.candle_store
// Unified state management for chart data - single source of truth

import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { Candle, Timeframe, Trade, WsStatus } from "@/lib/chart/types";

// Types
export interface CandleState {
  // Core data
  candles: Candle[];
  liveCandle: Candle | null;
  timeframe: Timeframe;
  mint: string;

  // Metrics
  lastPrice: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  mcap: number;

  // Status
  isLoading: boolean;
  isOnline: boolean;
  wsStatus: WsStatus;
  dataSource: "mock" | "pumpfun" | "bitquery" | "geckoterminal" | "websocket" | "unknown";
  error: string | null;
  lastUpdate: number;
}

export interface CandleActions {
  // Data operations
  setCandles: (candles: Candle[], source?: CandleState["dataSource"]) => void;
  setLiveCandle: (candle: Candle | null) => void;
  mergeLiveCandle: () => void;
  addTrade: (trade: Trade) => void;

  // Config
  setTimeframe: (tf: Timeframe) => void;
  setMint: (mint: string) => void;

  // Status
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setOnline: (online: boolean) => void;
  setWsStatus: (status: WsStatus) => void;
  setDataSource: (source: CandleState["dataSource"]) => void;

  // Metrics
  updateMetrics: (metrics: Partial<Pick<CandleState, "lastPrice" | "change24h" | "volume24h" | "high24h" | "low24h" | "mcap">>) => void;

  // Reset
  reset: () => void;
  clearError: () => void;
}

// Initial state factory
const createInitialState = (mint = "", tf: Timeframe = "1m"): CandleState => ({
  candles: [],
  liveCandle: null,
  timeframe: tf,
  mint,

  lastPrice: 0,
  change24h: 0,
  volume24h: 0,
  high24h: 0,
  low24h: 0,
  mcap: 0,

  isLoading: true,
  isOnline: false,
  wsStatus: "connecting",
  dataSource: "unknown",
  error: null,
  lastUpdate: 0,
});

// Zustand store with Immer for mutations
export const useCandleStore = create<CandleState & CandleActions>()(
  subscribeWithSelector(
    immer(
      devtools(
        (set, get) => ({
          ...createInitialState(),

          setCandles: (candles, source) => {
            set((state) => {
              state.candles = candles;
              state.lastUpdate = Date.now();
              if (source) state.dataSource = source;
              if (candles.length > 0) {
                const last = candles[candles.length - 1];
                state.lastPrice = last.close;
              }
            });
          },

          setLiveCandle: (candle) => {
            set((state) => {
              state.liveCandle = candle;
            });
          },

          mergeLiveCandle: () => {
            set((state) => {
              if (!state.liveCandle) return;

              const lastCandle = state.candles[state.candles.length - 1];
              if (lastCandle && lastCandle.time === state.liveCandle.time) {
                // Update last candle
                lastCandle.high = Math.max(lastCandle.high, state.liveCandle.high);
                lastCandle.low = Math.min(lastCandle.low, state.liveCandle.low);
                lastCandle.close = state.liveCandle.close;
                lastCandle.volume = state.liveCandle.volume;
              } else if (!lastCandle || state.liveCandle.time > lastCandle.time) {
                // Add new candle
                state.candles.push(state.liveCandle);
                // Limit to 5000 candles
                if (state.candles.length > 5000) {
                  state.candles = state.candles.slice(-5000);
                }
              }
              state.lastPrice = state.liveCandle.close;
              state.lastUpdate = Date.now();
              state.liveCandle = null;
            });
          },

          addTrade: (trade) => {
            set((state) => {
              if (!trade.priceUsd) return;

              const tfSeconds = {
                "1s": 1, "5s": 5, "15s": 15,
                "1m": 60, "5m": 300, "15m": 900,
                "1h": 3600, "4h": 14400, "1d": 86400
              }[state.timeframe] || 60;

              const bucket = Math.floor(trade.timestamp / 1000 / tfSeconds) * tfSeconds;
              const price = trade.priceUsd;

              const lastCandle = state.candles[state.candles.length - 1];

              if (!state.liveCandle || state.liveCandle.time !== bucket) {
                // New bucket - merge previous live candle first
                if (state.liveCandle && lastCandle && lastCandle.time === state.liveCandle.time) {
                  lastCandle.high = Math.max(lastCandle.high, state.liveCandle.high);
                  lastCandle.low = Math.min(lastCandle.low, state.liveCandle.low);
                  lastCandle.close = state.liveCandle.close;
                  lastCandle.volume = state.liveCandle.volume;
                } else if (state.liveCandle && (!lastCandle || state.liveCandle.time > lastCandle.time)) {
                  state.candles.push(state.liveCandle);
                  if (state.candles.length > 5000) {
                    state.candles = state.candles.slice(-5000);
                  }
                }
                // Create new live candle
                state.liveCandle = {
                  time: bucket,
                  open: lastCandle?.close ?? price,
                  high: price,
                  low: price,
                  close: price,
                  volume: trade.solAmount || 0
                };
              } else {
                // Update existing live candle only; chart updates directly from trade stream callback
                state.liveCandle.high = Math.max(state.liveCandle.high, price);
                state.liveCandle.low = Math.min(state.liveCandle.low, price);
                state.liveCandle.close = price;
                state.liveCandle.volume += trade.solAmount || 0;
              }

              state.lastPrice = price;
              state.lastUpdate = Date.now();
            });
          },

          setTimeframe: (tf) => {
            set((state) => {
              state.timeframe = tf;
              state.liveCandle = null; // Reset live candle only; keep candles until new data arrives
            });
          },

          setMint: (mint) => {
            set((state) => {
              Object.assign(state, createInitialState(mint, state.timeframe));
            });
          },

          setLoading: (loading) => {
            set((state) => {
              state.isLoading = loading;
            });
          },

          setError: (error) => {
            set((state) => {
              state.error = error;
              state.isLoading = false;
            });
          },

          setOnline: (online) => {
            set((state) => {
              state.isOnline = online;
            });
          },

          setWsStatus: (status) => {
            set((state) => {
              state.wsStatus = status;
              state.isOnline = status === "live" || status === "polling";
            });
          },

          setDataSource: (source) => {
            set((state) => {
              state.dataSource = source;
            });
          },

          updateMetrics: (metrics) => {
            set((state) => {
              Object.assign(state, metrics);
            });
          },

          reset: () => {
            set((state) => {
              Object.assign(state, createInitialState(state.mint, state.timeframe));
            });
          },

          clearError: () => {
            set((state) => {
              state.error = null;
            });
          },
        }),
        { name: "CandleStore" }
      )
    )
  )
);

// Selectors for performance
export const selectCandles = (state: CandleState) => state.candles;
export const selectLastPrice = (state: CandleState) => state.lastPrice;
export const selectMetrics = (state: CandleState) => ({
  change24h: state.change24h,
  volume24h: state.volume24h,
  high24h: state.high24h,
  low24h: state.low24h,
  mcap: state.mcap
});
export const selectIsLoading = (state: CandleState) => state.isLoading;
export const selectIsOnline = (state: CandleState) => state.isOnline;
