// data-tag: lib.market_collector
// PumpPortal Data API WebSocket collector — free tier.
// Subscribes to newToken and migration events and persists them to SQLite.
// Run as: npx ts-node scripts/market-collector.ts (or import startMarketCollector in a worker).

import WebSocket from "ws";
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
}

const state: CollectorState = {
  ws: null,
  isRunning: false,
  reconnectDelay: 1000,
  eventsSinceStart: 0,
  lastEventAt: null,
};

function makeEventId(kind: string, mint: string, timestamp: number): string {
  return `${kind}:${mint}:${timestamp}`;
}

function handleMessage(raw: string) {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();

    // PumpPortal newToken payload:
    // { signature, mint, traderPublicKey, txType, initialBuy, solAmount, tokenAmount, marketCapSol, name, symbol, uri }
    if (msg.mint && typeof msg.mint === "string") {
      const kind: MarketEventKind =
        msg.txType === "create" || msg.txType === "create_v2"
          ? "launch"
          : "trade";

      const mint = msg.mint as string;
      const signature = (msg.signature as string) || "";
      const eventId = signature
        ? `${kind}:${signature}`
        : makeEventId(kind, mint, now);

      persistMarketEvent({
        eventId,
        kind,
        mint,
        trader: (msg.traderPublicKey as string) || null,
        txType: (msg.txType as string) || null,
        amountSol: typeof msg.solAmount === "number" ? msg.solAmount : null,
        marketCapSol:
          typeof msg.marketCapSol === "number" ? msg.marketCapSol : null,
        payload: msg,
        source: "pumpportal",
        observedAt: now,
      });

      state.eventsSinceStart++;
      state.lastEventAt = now;
    }

    // PumpPortal migration payload shape varies; detect by presence of pool or graduation fields
    if (
      (msg.pool || msg.graduation || msg.raydiumPool) &&
      typeof msg.mint === "string"
    ) {
      const mint = msg.mint as string;
      const eventId = makeEventId("migration", mint, now);
      persistMarketEvent({
        eventId,
        kind: "migration",
        mint,
        trader: null,
        txType: null,
        amountSol: 0,
        marketCapSol:
          typeof msg.marketCapSol === "number" ? msg.marketCapSol : null,
        payload: msg,
        source: "pumpportal",
        observedAt: now,
      });

      state.eventsSinceStart++;
      state.lastEventAt = now;
    }
  } catch {
    // ignore malformed
  }
}

function connect() {
  if (!state.isRunning) return;

  try {
    const ws = new WebSocket(PUMPPORTAL_WS);
    state.ws = ws;

    ws.on("open", () => {
      console.log("[market-collector] Connected to PumpPortal");
      state.reconnectDelay = 1000;

      // Subscribe to free streams
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
    });

    ws.on("message", (data: WebSocket.Data) => {
      const raw = typeof data === "string" ? data : data.toString("utf-8");
      handleMessage(raw);
    });

    ws.on("close", () => {
      console.log(
        `[market-collector] Disconnected. Reconnecting in ${state.reconnectDelay}ms...`
      );
      state.ws = null;
      setTimeout(connect, state.reconnectDelay);
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30000);
    });

    ws.on("error", (err: Error) => {
      console.error("[market-collector] WS error:", err.message);
    });
  } catch (err) {
    console.error("[market-collector] Failed to connect:", err);
    setTimeout(connect, state.reconnectDelay);
  }
}

export function startMarketCollector() {
  if (state.isRunning) {
    console.log("[market-collector] Already running");
    return;
  }
  state.isRunning = true;
  state.eventsSinceStart = 0;
  console.log("[market-collector] Starting...");
  connect();
}

export function stopMarketCollector() {
  state.isRunning = false;
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
  };
}
