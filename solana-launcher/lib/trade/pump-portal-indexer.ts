// data-tag: lib.trade.pump-portal-indexer
// Long-lived WebSocket indexer for PumpPortal new-token events.
// Saves (mint → creator) mappings to dev_tokens table for accurate DEV lookups.
import WebSocket from "ws";
import { getDb } from "./db";

const PUMPPORTAL_URL = "wss://pumpportal.fun/api/data";
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECTS = Infinity;

interface IndexerStats {
  connected: boolean;
  startedAt: number | null;
  totalEvents: number;
  newTokensCount: number;
  errors: number;
  lastEventAt: number | null;
  lastMint: string | null;
  lastCreator: string | null;
}

interface IndexerHandle {
  ws: WebSocket | null;
  stats: IndexerStats;
  reconnectAttempts: number;
  shouldReconnect: boolean;
  reconnectTimer: NodeJS.Timeout | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __PUMP_INDEXER__: IndexerHandle | undefined;
}

function getHandle(): IndexerHandle {
  if (!global.__PUMP_INDEXER__) {
    global.__PUMP_INDEXER__ = {
      ws: null,
      stats: {
        connected: false,
        startedAt: null,
        totalEvents: 0,
        newTokensCount: 0,
        errors: 0,
        lastEventAt: null,
        lastMint: null,
        lastCreator: null,
      },
      reconnectAttempts: 0,
      shouldReconnect: false,
      reconnectTimer: null,
    };
  }
  return global.__PUMP_INDEXER__!;
}

function saveCreateEvent(mint: string, creator: string, name?: string, symbol?: string, uri?: string) {
  if (!mint || !creator) return;
  try {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO dev_tokens
        (mint, creator, symbol, name, image, description, twitter, telegram, website,
         created_at, market_cap_usd, ath_usd, is_migrated, reached_300k, last_updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, 0, 0, ?)
       ON CONFLICT(mint) DO UPDATE SET
         creator=excluded.creator,
         symbol=COALESCE(NULLIF(excluded.symbol,''), dev_tokens.symbol),
         name=COALESCE(NULLIF(excluded.name,''), dev_tokens.name),
         created_at=COALESCE(dev_tokens.created_at, excluded.created_at),
         last_updated_at=excluded.last_updated_at`
    ).run(mint, creator, symbol || null, name || null, now, Date.now());
  } catch (e) {
    console.error("[PumpPortal] DB write failed:", (e as Error).message);
    getHandle().stats.errors++;
  }
}

function handleMessage(raw: string) {
  const h = getHandle();
  h.stats.totalEvents++;
  h.stats.lastEventAt = Date.now();

  try {
    const msg = JSON.parse(raw);

    // PumpPortal new-token events have txType="create"
    if (msg.txType === "create" && msg.mint) {
      const creator = msg.traderPublicKey || msg.creator || msg.user;
      if (creator) {
        h.stats.newTokensCount++;
        h.stats.lastMint = msg.mint;
        h.stats.lastCreator = creator;
        saveCreateEvent(msg.mint, creator, msg.name, msg.symbol, msg.uri);
      }
    }
  } catch {
    h.stats.errors++;
  }
}

function connect() {
  const h = getHandle();
  if (h.ws && (h.ws.readyState === WebSocket.OPEN || h.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log("[PumpPortal] Connecting...");
  const ws = new WebSocket(PUMPPORTAL_URL);
  h.ws = ws;

  ws.on("open", () => {
    console.log("[PumpPortal] Connected");
    h.stats.connected = true;
    h.reconnectAttempts = 0;
    // Subscribe to all new token creation events
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });

  ws.on("message", (data) => {
    handleMessage(data.toString());
  });

  ws.on("error", (e) => {
    console.error("[PumpPortal] Error:", e.message);
    h.stats.errors++;
  });

  ws.on("close", () => {
    console.log("[PumpPortal] Closed");
    h.stats.connected = false;
    h.ws = null;
    if (h.shouldReconnect && h.reconnectAttempts < MAX_RECONNECTS) {
      h.reconnectAttempts++;
      h.reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    }
  });
}

export function startIndexer(): IndexerStats {
  const h = getHandle();
  h.shouldReconnect = true;
  if (!h.stats.startedAt) h.stats.startedAt = Date.now();
  if (!h.ws || h.ws.readyState !== WebSocket.OPEN) {
    connect();
  }
  return h.stats;
}

export function stopIndexer(): IndexerStats {
  const h = getHandle();
  h.shouldReconnect = false;
  if (h.reconnectTimer) {
    clearTimeout(h.reconnectTimer);
    h.reconnectTimer = null;
  }
  if (h.ws) {
    try { h.ws.close(); } catch {}
    h.ws = null;
  }
  h.stats.connected = false;
  return h.stats;
}

export function getIndexerStats(): IndexerStats {
  return { ...getHandle().stats };
}
