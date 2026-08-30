// data-tag: lib.chart.types

// Data source types
export type DataSource = "mock" | "pumpfun" | "bitquery" | "geckoterminal" | "websocket" | "unknown";

// All timeframes including sub-second (1s/5s/15s require WebSocket ticks)
export type Timeframe = "1s" | "5s" | "15s" | "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w" | "all";

export const TF_SECONDS: Record<Timeframe, number> = {
  "1s":  1,
  "5s":  5,
  "15s": 15,
  "1m":  60,
  "5m":  300,
  "15m": 900,
  "1h":  3600,
  "4h":  14400,
  "1d":  86400,
  "1w":  86400,
  "all": 86400,
};

// Minutes per timeframe for aggregation (sub-minute treated as 1m for base data)
export const TF_MINUTES: Record<Timeframe, number> = {
  "1s": 1,
  "5s": 1,
  "15s": 1,
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
  "1w": 1440,
  "all": 1440,
};

// Sub-second timeframes need special handling
export const SUB_SECOND_TFS: Timeframe[] = ["1s", "5s", "15s"];
export const isSubSecond = (tf: Timeframe): boolean => SUB_SECOND_TFS.includes(tf);

export const TIMEFRAMES: Timeframe[] = ["5m", "1h", "1d", "1w", "all"];

export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  "1s": "1 сек",
  "5s": "5 сек",
  "15s": "15 сек",
  "1m": "1 мин",
  "5m": "5 мин",
  "15m": "15 мин",
  "1h": "1 час",
  "4h": "4 часа",
  "1d": "1 день",
  "1w": "неделя",
  "all": "все время",
};

// Time window (ms) for initial history fetch per timeframe
export const TF_TIME_WINDOWS: Record<Timeframe, number> = {
  "1s":  30 * 60 * 1000,          // 30 minutes
  "5s":  2 * 60 * 60 * 1000,      // 2 hours
  "15s": 6 * 60 * 60 * 1000,      // 6 hours
  "1m":  24 * 60 * 60 * 1000,     // 1 day
  "5m":  3 * 24 * 60 * 60 * 1000,  // 3 days
  "15m": 3 * 24 * 60 * 60 * 1000,  // 3 days
  "1h":  7 * 24 * 60 * 60 * 1000,  // 7 days
  "4h":  7 * 24 * 60 * 60 * 1000,  // 7 days
  "1d":  30 * 24 * 60 * 60 * 1000, // 30 days
  "1w":  7 * 24 * 60 * 60 * 1000,  // 7 days
  "all": 5 * 365 * 24 * 60 * 60 * 1000, // deep available history
};

export interface Candle {
  time: number;    // unix seconds UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;  // in SOL
}

export interface Trade {
  mint: string;
  solAmount: number;
  tokenAmount: number;
  isBuy: boolean;
  timestamp: number;  // unix ms
  priceUsd: number;   // computed
  signature?: string;
}

export type WsStatus = "connecting" | "live" | "reconnecting" | "offline" | "polling";

export interface OHLCVState {
  candles: Candle[];
  timeframe: Timeframe;
  lastPrice: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  isLoading: boolean;
  isOnline: boolean;
  wsStatus: WsStatus;
  dataSource: "mock" | "bitquery" | "geckoterminal" | "websocket" | "pumpfun" | "unknown";
  error: string | null;
  ingestTrade: (trade: Trade) => void;
  retry: () => void;
}
