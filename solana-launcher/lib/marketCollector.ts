// data-tag: lib.market_collector
// PumpPortal Data API WebSocket collector — free tier.
// Subscribes to newToken and migration events and persists them to SQLite.
// Run as: npx ts-node scripts/market-collector.ts (or import startMarketCollector in a worker).

import WebSocket from "ws";
import { createHash } from "node:crypto";
import {
  persistMarketEvent,
  getMarketCollectorStatus,
  type MarketEventKind,
} from "./trade/db";

const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";

interface CollectorState {
  ws: WebSocket | null;
  isRunning: boolean;
  reconnectDelay: number;
  eventsSinceStart: number;
  lastEventAt: number | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  disconnects: number;
  needsBackfill: boolean;
}

const state: CollectorState = {
  ws: null,
  isRunning: false,
  reconnectDelay: 1000,
  eventsSinceStart: 0,
  lastEventAt: null,
  reconnectTimer: null,
  disconnects: 0,
  needsBackfill: false,
};

// Signature-based IDs dedupe a replay. If the stream lacks a signature, hash the
// original message rather than generating a new ID on every delivery.
function makeEventId(kind: string, mint: string, msg: Record<string, unknown>): string {
  const signature = typeof msg.signature === "string" ? msg.signature.trim() : "";
  const txType = typeof msg.txType === "string" ? msg.txType : "";
  if (signature) return `${kind}:${mint}:${signature}:${txType}`;
  const fingerprint = createHash("sha256").update(JSON.stringify(msg)).digest("hex");
  return `${kind}:${mint}:unverified:${fingerprint}`;
}

function handleMessage(raw: string) {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (typeof msg.mint !== "string" || !msg.mint) return;
    const mint = msg.mint;
    const now = Date.now();
    const txType = typeof msg.txType === "string" ? msg.txType : "";
    const isMigration = Boolean(msg.pool || msg.graduation || msg.raydiumPool)
      || txType === "migrate" || txType === "migration";
    const isLaunch = txType === "create" || txType === "create_v2";
    const isTrade = txType === "buy" || txType === "sell";

    // Event types are mutually exclusive. Previously migrations and arbitrary
    // messages with a mint could be counted as trades.
    const kind: MarketEventKind | null = isMigration ? "migration" : isLaunch ? "launch" : isTrade ? "trade" : null;
    if (!kind) return;
    persistMarketEvent({
      eventId: makeEventId(kind, mint, msg),
      kind,
      mint,
      trader: kind === "trade" || kind === "launch" ? (typeof msg.traderPublicKey === "string" ? msg.traderPublicKey : null) : null,
      txType: txType || null,
      amountSol: kind === "trade" && typeof msg.solAmount === "number" && Number.isFinite(msg.solAmount) ? msg.solAmount : null,
      marketCapSol: typeof msg.marketCapSol === "number" && Number.isFinite(msg.marketCapSol) ? msg.marketCapSol : null,
      payload: msg,
      source: "pumpportal",
      observedAt: now,
    });
    state.eventsSinceStart++;
    state.lastEventAt = now;
  } catch (error) {
    console.error("[market-collector] Invalid event or persistence failed:", error);
  }
}

function connect() {
  if (!state.isRunning) return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

  try {
    const ws = new WebSocket(PUMPPORTAL_WS);
    state.ws = ws;

    ws.on("open", () => {
      console.log("[market-collector] Connected to PumpPortal");
      state.reconnectDelay = 1000;
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }

      // Subscribe to free streams
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
    });

    ws.on("message", (data: WebSocket.Data) => {
      const raw = typeof data === "string" ? data : data.toString("utf-8");
      handleMessage(raw);
    });

    ws.on("close", () => {
      if (state.ws !== ws) return;
      state.ws = null;
      if (!state.isRunning) return;
      state.disconnects++;
      state.needsBackfill = true; // WebSocket is not a durable event log.
      scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      console.error("[market-collector] WS error:", err.message);
    });
  } catch (err) {
    console.error("[market-collector] Failed to connect:", err);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!state.isRunning || state.reconnectTimer) return;
  const delay = state.reconnectDelay;
  console.warn(`[market-collector] Reconnecting in ${delay}ms; missed events need historical reconciliation`);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, delay);
  state.reconnectDelay = Math.min(delay * 2, 30_000);
}

export function startMarketCollector() {
  if (state.isRunning) {
    console.log("[market-collector] Already running");
    return;
  }
  state.isRunning = true;
  state.eventsSinceStart = 0;
  state.needsBackfill = false;
  state.disconnects = 0;
  console.log("[market-collector] Starting...");
  connect();
}

export function stopMarketCollector() {
  state.isRunning = false;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      // ignore
    }
    state.ws = null;
  }
  console.log("[market-collector] Stopped");
}

export function getCollectorStatus() {
  const dbStatus = getMarketCollectorStatus();
  return {
    isRunning: state.isRunning,
    wsConnected: state.ws?.readyState === WebSocket.OPEN,
    eventsSinceStart: state.eventsSinceStart,
    lastEventAt: state.lastEventAt ?? dbStatus.lastEventAt,
    events: dbStatus.events,
    launches: dbStatus.launches,
    migrations: dbStatus.migrations,
    trades: dbStatus.trades,
    disconnects: state.disconnects,
    needsBackfill: state.needsBackfill,
  };
}
