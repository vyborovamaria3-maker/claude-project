"use client";
// data-tag: hooks.use_websocket

import { useEffect, useRef, useCallback } from "react";
import { type WsStatus } from "@/lib/chart/types";

interface UseWebSocketOptions {
  url: string;
  onOpen?: (ws: WebSocket) => void;
  onMessage: (data: unknown) => void;
  onStatusChange: (status: WsStatus) => void;
  enabled?: boolean;
}

const MAX_BACKOFF = 30_000;
const MAX_ATTEMPTS = 3;
const CONNECTION_TIMEOUT = 8_000; // 8 seconds before giving up
const MAX_ERROR_LOGS = 3;

export function useWebSocket({
  url,
  onOpen,
  onMessage,
  onStatusChange,
  enabled = true,
}: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const attempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmounted = useRef(false);
  const errorCount = useRef(0);
  const pollingMode = useRef(false); // Stop all reconnection attempts when true

  // stable refs so effects don't re-run on callback identity change
  const onOpenRef = useRef(onOpen);
  const onMessageRef = useRef(onMessage);
  const onStatusRef = useRef(onStatusChange);
  onOpenRef.current = onOpen;
  onMessageRef.current = onMessage;
  onStatusRef.current = onStatusChange;

  const connect = useCallback(() => {
    if (unmounted.current || !enabled || pollingMode.current) return;

    // Clear any existing connection timer
    if (connectionTimer.current) {
      clearTimeout(connectionTimer.current);
      connectionTimer.current = null;
    }

    onStatusRef.current("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      if (errorCount.current < MAX_ERROR_LOGS) {
        console.warn("[WebSocket] Failed to create connection:", e);
        errorCount.current++;
      }
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    // Set connection timeout
    connectionTimer.current = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        if (errorCount.current < MAX_ERROR_LOGS) {
          console.warn("[WebSocket] Connection timeout after 8s, switching to polling");
          errorCount.current++;
        }
        ws.close();
        pollingMode.current = true; // Stop future reconnection attempts
        onStatusRef.current("polling");
      }
    }, CONNECTION_TIMEOUT);

    ws.onopen = () => {
      if (unmounted.current) { ws.close(); return; }
      // Clear connection timeout on successful open
      if (connectionTimer.current) {
        clearTimeout(connectionTimer.current);
        connectionTimer.current = null;
      }
      attempt.current = 0;
      onStatusRef.current("live");
      onOpenRef.current?.(ws);
    };

    ws.onmessage = (ev) => {
      if (unmounted.current) return;
      try {
        const data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        onMessageRef.current(data);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onerror = () => {
      // Silently track errors - logging is too noisy
      errorCount.current++;
    };

    ws.onclose = () => {
      wsRef.current = null;
      // Clear connection timeout
      if (connectionTimer.current) {
        clearTimeout(connectionTimer.current);
        connectionTimer.current = null;
      }
      if (unmounted.current) return;
      // If we're in polling mode or max attempts reached, stop reconnecting
      if (pollingMode.current || attempt.current >= MAX_ATTEMPTS) {
        pollingMode.current = true;
        onStatusRef.current("polling");
        return;
      }
      onStatusRef.current("reconnecting");
      scheduleReconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, enabled]);

  function scheduleReconnect() {
    if (reconnectTimer.current || pollingMode.current) return;
    if (attempt.current >= MAX_ATTEMPTS) {
      // Switch to polling mode instead of offline
      pollingMode.current = true;
      onStatusRef.current("polling");
      return;
    }
    const delay = Math.min(MAX_BACKOFF, 1000 * Math.pow(2, attempt.current));
    attempt.current++;
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      if (!unmounted.current) connect();
    }, delay);
  }

  const send = useCallback((payload: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    if (connectionTimer.current) { clearTimeout(connectionTimer.current); connectionTimer.current = null; }
    wsRef.current?.close();
    wsRef.current = null;
    pollingMode.current = false; // Reset polling mode on disconnect
    attempt.current = 0;
    errorCount.current = 0;
  }, []);

  useEffect(() => {
    unmounted.current = false;
    if (enabled) connect();
    return () => {
      unmounted.current = true;
      disconnect();
    };
  }, [connect, disconnect, enabled]);

  return { send, disconnect };
}
