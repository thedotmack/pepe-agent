/**
 * Node port of lib/activity/activity-websocket.ts (browser singleton).
 *
 * Subscribes to the public memedeck activity feed:
 *   - WS:   wss://api.memedeck.win/activity
 *   - REST: https://api.memedeck.win/api/activity/top/50
 *
 * Maintains an in-memory token map, throttles outbound emits to 1 Hz,
 * reconnects with exponential backoff, and falls back to REST polling
 * when the WS keeps failing.
 *
 * Consumers attach to the EventEmitter:
 *   - "tokens" -> ActivityToken[] snapshot (throttled)
 *   - "status" -> { status: SubscriberStatus }
 */
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { createLogger } from "../logger.ts";

const log = createLogger("activity");

const ACTIVITY_WEBSOCKET_URL =
  process.env.ACTIVITY_WS_URL ?? "wss://api.memedeck.win/activity";
const ACTIVITY_REST_URL =
  process.env.ACTIVITY_REST_URL ??
  "https://api.memedeck.win/api/activity/top/50";

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 800;
const THROTTLE_DELAY_MS = 1000;
const REST_FALLBACK_INTERVAL_MS = 5000;

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

export type SubscriberStatus =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "rest-fallback";

export interface ActivitySubscriber {
  emitter: EventEmitter;
  getSnapshot: () => ActivityToken[];
  getStatus: () => SubscriberStatus;
  stop: () => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isActivityMessage(
  v: unknown
): v is { type: "update"; data: unknown[]; timestamp: number } {
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
    if (typeof entry.updatesPerMinute === "number")
      t.updatesPerMinute = entry.updatesPerMinute;
    if (typeof entry.winRate === "number") t.winRate = entry.winRate;
    if (typeof entry.firstSeen === "number") t.firstSeen = entry.firstSeen;
    if (typeof entry.createdAt === "string") t.createdAt = entry.createdAt;
    if (
      entry.signal === "STRONG" ||
      entry.signal === "RISING" ||
      entry.signal === "WATCH" ||
      entry.signal === "FLAT"
    ) {
      t.signal = entry.signal;
    }
    if (typeof entry.tokenBeingAnalyzed === "boolean") {
      t.tokenBeingAnalyzed = entry.tokenBeingAnalyzed;
    }
    return [t];
  });
}

let singleton: ActivitySubscriber | null = null;

export function createActivitySubscriber(): ActivitySubscriber {
  if (singleton) return singleton;

  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  const tokens = new Map<string, ActivityToken>();
  let lastUpdateAt = 0;
  let lastEmitAt = 0;
  let pendingEmitTimer: NodeJS.Timeout | null = null;
  let status: SubscriberStatus = "idle";
  let stopped = false;

  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let restFallbackTimer: NodeJS.Timeout | null = null;

  function setStatus(next: SubscriberStatus) {
    if (status === next) return;
    status = next;
    emitter.emit("status", { status });
  }

  function snapshotArray(): ActivityToken[] {
    return Array.from(tokens.values());
  }

  function emitSnapshotThrottled() {
    const now = Date.now();
    if (now - lastEmitAt >= THROTTLE_DELAY_MS) {
      lastEmitAt = now;
      emitter.emit("tokens", snapshotArray());
      if (pendingEmitTimer) {
        clearTimeout(pendingEmitTimer);
        pendingEmitTimer = null;
      }
      return;
    }
    if (!pendingEmitTimer) {
      const remaining = THROTTLE_DELAY_MS - (now - lastEmitAt);
      pendingEmitTimer = setTimeout(() => {
        lastEmitAt = Date.now();
        emitter.emit("tokens", snapshotArray());
        pendingEmitTimer = null;
      }, remaining);
    }
  }

  function ingestTokens(incoming: ActivityToken[]) {
    if (incoming.length === 0) return;
    for (const t of incoming) tokens.set(t.tokenId, t);
    lastUpdateAt = Date.now();
    emitSnapshotThrottled();
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearRestFallbackTimer() {
    if (restFallbackTimer) {
      clearInterval(restFallbackTimer);
      restFallbackTimer = null;
    }
  }

  async function tryRestFallback(): Promise<void> {
    try {
      const res = await fetch(ACTIVITY_REST_URL);
      const data = (await res.json()) as unknown;
      let arr: unknown[] = [];
      if (isRecord(data) && Array.isArray((data as Record<string, unknown>).data)) {
        arr = (data as Record<string, unknown>).data as unknown[];
      } else if (
        isRecord(data) &&
        Array.isArray((data as Record<string, unknown>).activeTokens)
      ) {
        arr = (data as Record<string, unknown>).activeTokens as unknown[];
      } else if (Array.isArray(data)) {
        arr = data;
      }
      const normalized = normalizeTokens(arr);
      if (normalized.length > 0) {
        ingestTokens(normalized);
        log.debug(`REST fallback ingested ${normalized.length} tokens`);
      }
    } catch (err) {
      log.warn("REST fallback failed", { error: String(err) });
    }
  }

  function startRestFallback() {
    if (restFallbackTimer) return;
    setStatus("rest-fallback");
    log.warn(`switching to REST fallback at ${ACTIVITY_REST_URL}`);
    void tryRestFallback();
    restFallbackTimer = setInterval(() => {
      void tryRestFallback();
    }, REST_FALLBACK_INTERVAL_MS);
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log.error(
        `WS reconnect attempts exhausted (${MAX_RECONNECT_ATTEMPTS}); falling back to REST`
      );
      startRestFallback();
      return;
    }
    setStatus("reconnecting");
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectAttempts += 1;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  function connect() {
    if (stopped) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    setStatus("connecting");
    log.info(`connecting ${ACTIVITY_WEBSOCKET_URL}`);
    const sock = new WebSocket(ACTIVITY_WEBSOCKET_URL);
    ws = sock;

    sock.on("open", () => {
      reconnectAttempts = 0;
      clearReconnectTimer();
      clearRestFallbackTimer();
      setStatus("live");
      log.info(`connected ${ACTIVITY_WEBSOCKET_URL}`);
    });

    sock.on("message", (raw) => {
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf-8");
        const parsed = JSON.parse(text) as unknown;
        if (!isActivityMessage(parsed)) return;
        const incoming = normalizeTokens(parsed.data);
        ingestTokens(incoming);
      } catch (err) {
        log.warn("WS parse error", { error: String(err) });
      }
    });

    sock.on("close", (code) => {
      log.warn(`WS closed code=${code}`);
      ws = null;
      if (!stopped && code !== 1000) scheduleReconnect();
    });

    sock.on("error", (err) => {
      log.warn("WS error", { error: String(err) });
      // close handler will schedule reconnect
    });
  }

  // kick off
  connect();

  singleton = {
    emitter,
    getSnapshot: snapshotArray,
    getStatus: () => status,
    stop: () => {
      stopped = true;
      clearReconnectTimer();
      clearRestFallbackTimer();
      if (pendingEmitTimer) clearTimeout(pendingEmitTimer);
      if (ws) {
        try {
          ws.close(1000);
        } catch {
          /* noop */
        }
        ws = null;
      }
      emitter.removeAllListeners();
      singleton = null;
    },
  };

  return singleton;
}
