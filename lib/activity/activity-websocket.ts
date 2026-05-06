"use client";

/**
 * Ported from MemeDeck-OSS lib/jupiter/realtime/activity-websocket.ts
 * Connects directly to the public memedeck activity feed:
 *   - WS:   wss://api.memedeck.win/activity
 *   - REST: https://api.memedeck.win/api/activity/top/50
 *
 * Module-level singleton so multiple consumers share one socket.
 */

const ACTIVITY_WEBSOCKET_URL =
  process.env.NEXT_PUBLIC_ACTIVITY_WS_URL ?? "wss://api.memedeck.win/activity";
const ACTIVITY_REST_URL =
  process.env.NEXT_PUBLIC_ACTIVITY_REST_URL ??
  "https://api.memedeck.win/api/activity/top/50";

export interface ActivityToken {
  tokenId: string;
  symbol: string;
  name: string;
  price: number;
  icon?: string;
  liquidity?: number;
  volume24h?: number;
  createdAt?: string;
  oneMinGain?: number;
  twoMinGain?: number;
  threeMinGain?: number;
  fourMinGain?: number;
  fiveMinGain?: number;
  updatesPerMinute?: number;
  signal?: "STRONG" | "RISING" | "WATCH" | "FLAT";
  buyPressure5m?: number;
  winRate?: number;
  tokenBeingAnalyzed?: boolean;
  firstSeen?: number;
}

interface ActivityMessage {
  type: "update";
  data: ActivityToken[];
  timestamp: number;
}

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isActivityMessage(v: unknown): v is { type: "update"; data: unknown[]; timestamp: number } {
  if (!isRecord(v)) return false;
  if (v.type !== "update") return false;
  if (!Array.isArray(v.data)) return false;
  if (typeof v.timestamp !== "number") return false;
  return true;
}

function normalizeTokens(raw: unknown[]): ActivityToken[] {
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const tokenId =
      (typeof entry.tokenId === "string" && entry.tokenId) ||
      (typeof entry.id === "string" && entry.id) ||
      (typeof entry.mint === "string" && entry.mint) ||
      "";
    if (!tokenId) return [];
    const t: ActivityToken = {
      tokenId,
      symbol: typeof entry.symbol === "string" ? entry.symbol : "",
      name: typeof entry.name === "string" ? entry.name : "",
      price: typeof entry.price === "number" ? entry.price : 0,
    };
    if (typeof entry.icon === "string") t.icon = entry.icon;
    if (typeof entry.oneMinGain === "number") t.oneMinGain = entry.oneMinGain;
    if (typeof entry.twoMinGain === "number") t.twoMinGain = entry.twoMinGain;
    if (typeof entry.threeMinGain === "number") t.threeMinGain = entry.threeMinGain;
    if (typeof entry.fourMinGain === "number") t.fourMinGain = entry.fourMinGain;
    if (typeof entry.fiveMinGain === "number") t.fiveMinGain = entry.fiveMinGain;
    if (typeof entry.buyPressure5m === "number") t.buyPressure5m = entry.buyPressure5m;
    if (typeof entry.liquidity === "number") t.liquidity = entry.liquidity;
    if (typeof entry.volume24h === "number") t.volume24h = entry.volume24h;
    if (typeof entry.updatesPerMinute === "number") t.updatesPerMinute = entry.updatesPerMinute;
    if (typeof entry.winRate === "number") t.winRate = entry.winRate;
    if (typeof entry.firstSeen === "number") t.firstSeen = entry.firstSeen;
    if (typeof entry.createdAt === "string") t.createdAt = entry.createdAt;
    if (entry.signal === "STRONG" || entry.signal === "RISING" || entry.signal === "WATCH" || entry.signal === "FLAT") {
      t.signal = entry.signal;
    }
    if (typeof entry.tokenBeingAnalyzed === "boolean") {
      t.tokenBeingAnalyzed = entry.tokenBeingAnalyzed;
    }
    return [t];
  });
}

let globalActivityWebSocket: WebSocket | null = null;
let inFlightActivityWebSocket: WebSocket | null = null;
let isConnecting = false;
let connectionCallbacks: Array<(ws: WebSocket) => void> = [];
let messageHandlers: Array<(message: ActivityMessage) => void> = [];
let connectionStateHandlers: Array<(state: ConnectionState) => void> = [];
let reconnectAttempts = 0;
let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;

let lastUpdateTime = 0;
let pendingMessage: ActivityMessage | null = null;
let updateTimeoutId: ReturnType<typeof setTimeout> | null = null;

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 800;
const THROTTLE_DELAY = 1000;

function notifyConnectionState(state: ConnectionState) {
  connectionStateHandlers.forEach((handler) => handler(state));
}

function clearReconnectTimeout() {
  if (reconnectTimeoutId) {
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    notifyConnectionState("error");
    return;
  }
  clearReconnectTimeout();
  reconnectTimeoutId = setTimeout(() => {
    reconnectAttempts += 1;
    getOrCreateActivityWebSocket().catch(() => scheduleReconnect());
  }, RECONNECT_DELAY);
}

function flushMessage(message: ActivityMessage) {
  messageHandlers.forEach((handler) => handler(message));
}

function throttledMessageDispatch(message: ActivityMessage) {
  const now = Date.now();
  pendingMessage = message;
  if (now - lastUpdateTime >= THROTTLE_DELAY) {
    lastUpdateTime = now;
    flushMessage(message);
    pendingMessage = null;
    if (updateTimeoutId) {
      clearTimeout(updateTimeoutId);
      updateTimeoutId = null;
    }
    return;
  }
  if (!updateTimeoutId) {
    const remaining = THROTTLE_DELAY - (now - lastUpdateTime);
    updateTimeoutId = setTimeout(() => {
      if (pendingMessage) {
        lastUpdateTime = Date.now();
        flushMessage(pendingMessage);
        pendingMessage = null;
      }
      updateTimeoutId = null;
    }, remaining);
  }
}

async function tryRestFallback(): Promise<ActivityToken[]> {
  try {
    const response = await fetch(ACTIVITY_REST_URL);
    const data = await response.json();
    const arr = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.activeTokens)
        ? data.activeTokens
        : Array.isArray(data)
          ? data
          : [];
    return normalizeTokens(arr);
  } catch (error) {
    console.error("[activity] REST fallback failed", error);
    return [];
  }
}

function loadCachedTokens(): ActivityToken[] {
  if (typeof window === "undefined") return [];
  try {
    const cached = window.localStorage.getItem("pepe-agent-activity-cache");
    const ts = window.localStorage.getItem("pepe-agent-activity-cache-ts");
    if (cached && ts) {
      const age = Date.now() - parseInt(ts, 10);
      if (age < 60 * 60 * 1000) return JSON.parse(cached) as ActivityToken[];
    }
  } catch (error) {
    console.warn("[activity] failed to load cache", error);
  }
  return [];
}

function cacheTokens(tokens: ActivityToken[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("pepe-agent-activity-cache", JSON.stringify(tokens));
    window.localStorage.setItem("pepe-agent-activity-cache-ts", Date.now().toString());
  } catch {
    /* noop */
  }
}

function getOrCreateActivityWebSocket(): Promise<WebSocket> {
  if (globalActivityWebSocket && globalActivityWebSocket.readyState === WebSocket.OPEN) {
    return Promise.resolve(globalActivityWebSocket);
  }
  if (isConnecting) {
    return new Promise((resolve) => {
      connectionCallbacks.push(resolve);
    });
  }
  isConnecting = true;
  notifyConnectionState("connecting");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ACTIVITY_WEBSOCKET_URL);
    inFlightActivityWebSocket = ws;

    ws.onopen = () => {
      inFlightActivityWebSocket = null;
      if (messageHandlers.length === 0) {
        isConnecting = false;
        ws.close(1000);
        resolve(ws);
        return;
      }
      globalActivityWebSocket = ws;
      isConnecting = false;
      reconnectAttempts = 0;
      clearReconnectTimeout();
      notifyConnectionState("connected");
      console.info("[activity] connected", ACTIVITY_WEBSOCKET_URL);
      connectionCallbacks.forEach((cb) => cb(ws));
      connectionCallbacks = [];
      resolve(ws);
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (!isActivityMessage(parsed)) return;
        const tokens = normalizeTokens(parsed.data);
        if (tokens.length === 0) return;
        cacheTokens(tokens);
        const message: ActivityMessage = {
          type: "update",
          data: tokens,
          timestamp: parsed.timestamp,
        };
        throttledMessageDispatch(message);
      } catch (error) {
        console.warn("[activity] parse error", error);
      }
    };

    ws.onclose = (event) => {
      globalActivityWebSocket = null;
      if (inFlightActivityWebSocket === ws) inFlightActivityWebSocket = null;
      isConnecting = false;
      notifyConnectionState("disconnected");
      if (event.code !== 1000) scheduleReconnect();
    };

    ws.onerror = (err) => {
      if (inFlightActivityWebSocket === ws) inFlightActivityWebSocket = null;
      isConnecting = false;
      notifyConnectionState("error");
      reject(err);
    };
  });
}

function registerActivityMessageHandler(handler: (message: ActivityMessage) => void): () => void {
  messageHandlers.push(handler);
  return () => {
    const i = messageHandlers.indexOf(handler);
    if (i > -1) messageHandlers.splice(i, 1);
  };
}

function registerConnectionStateHandler(handler: (state: ConnectionState) => void): () => void {
  connectionStateHandlers.push(handler);
  return () => {
    const i = connectionStateHandlers.indexOf(handler);
    if (i > -1) connectionStateHandlers.splice(i, 1);
  };
}

export interface InitOptions {
  onTokenUpdate: (tokens: ActivityToken[]) => void;
  onConnectionChange: (state: ConnectionState) => void;
  onError?: (error: string) => void;
}

export function initializeActivityWebSocket({
  onTokenUpdate,
  onConnectionChange,
  onError,
}: InitOptions): { cleanup: () => void } {
  const cached = loadCachedTokens();
  if (cached.length > 0) onTokenUpdate(cached);

  const unregisterMessage = registerActivityMessageHandler((message) => {
    onTokenUpdate(message.data);
  });

  const unregisterState = registerConnectionStateHandler((state) => {
    onConnectionChange(state);
    if (state === "error" || state === "disconnected") {
      void tryRestFallback().then((tokens) => {
        if (tokens.length > 0) onTokenUpdate(tokens);
        else if (onError) onError("Unable to load token data.");
      });
    }
  });

  getOrCreateActivityWebSocket().catch((error) => {
    console.error("[activity] init failed", error);
    void tryRestFallback().then((tokens) => {
      if (tokens.length > 0) onTokenUpdate(tokens);
      else if (onError) onError("Failed to connect to live data stream");
    });
  });

  return {
    cleanup: () => {
      unregisterMessage();
      unregisterState();
      if (messageHandlers.length === 0) {
        clearReconnectTimeout();
        if (updateTimeoutId) {
          clearTimeout(updateTimeoutId);
          updateTimeoutId = null;
        }
        pendingMessage = null;
        if (inFlightActivityWebSocket) {
          inFlightActivityWebSocket.close(1000);
          inFlightActivityWebSocket = null;
        }
        if (globalActivityWebSocket) {
          globalActivityWebSocket.close(1000);
          globalActivityWebSocket = null;
        }
      }
    },
  };
}
