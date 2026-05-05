"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * useActivityFeed
 *
 * Subscribes to /api/feed via EventSource, batches incoming token updates
 * into a Map<tokenId, ActivityToken>, and exposes a snapshot via
 * useSyncExternalStore so React can read it without rerendering on every
 * burst of WS messages.
 */

export type ActivityToken = {
  tokenId: string;
  id?: string;
  mint?: string;
  address?: string;
  symbol: string;
  name: string;
  price?: number;
  liquidity?: number;
  volume24h?: number;
  createdAt?: string;
  oneMinGain?: number;
  twoMinGain?: number;
  threeMinGain?: number;
  fourMinGain?: number;
  fiveMinGain?: number;
  buyPressure5m?: number;
  updatesPerMinute?: number;
  signal?: "STRONG" | "RISING" | "WATCH" | "FLAT" | string;
  winRate?: number;
  tokenBeingAnalyzed?: boolean;
  firstSeen?: number;
};

export type FeedStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "rest-fallback"
  | "stale";

export type FeedSnapshot = {
  rows: ActivityToken[];
  status: FeedStatus;
  lastUpdated: number;
};

class FeedStore {
  private map = new Map<string, ActivityToken>();
  private listeners = new Set<() => void>();
  private cachedSnapshot: FeedSnapshot;

  status: FeedStatus = "connecting";
  lastUpdated = 0;

  constructor() {
    this.cachedSnapshot = { rows: [], status: this.status, lastUpdated: 0 };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): FeedSnapshot => this.cachedSnapshot;

  private notify() {
    this.cachedSnapshot = {
      rows: Array.from(this.map.values()),
      status: this.status,
      lastUpdated: this.lastUpdated,
    };
    this.listeners.forEach((l) => l());
  }

  ingest(tokens: unknown[]) {
    if (!Array.isArray(tokens) || tokens.length === 0) return;
    for (const raw of tokens) {
      const token = normalizeToken(raw);
      if (!token) continue;
      this.map.set(token.tokenId, token);
    }
    this.lastUpdated = Date.now();
    this.status = "live";
    this.notify();
  }

  setStatus(s: FeedStatus) {
    if (this.status === s) return;
    this.status = s;
    this.notify();
  }
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function normalizeGain(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.abs(value) > 2 ? value / 100 : value;
}

function normalizeToken(raw: unknown): ActivityToken | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const tokenId = readString(record, [
    "tokenId",
    "id",
    "mint",
    "mintAddress",
    "address",
    "tokenAddress",
  ]);
  if (!tokenId) return null;

  const symbol = readString(record, ["symbol", "ticker", "tokenSymbol"]) ?? "???";
  return {
    tokenId,
    id: readString(record, ["id"]),
    mint: readString(record, ["mint", "mintAddress"]),
    address: readString(record, ["address", "tokenAddress"]),
    symbol,
    name: readString(record, ["name", "tokenName"]) ?? symbol,
    price: readNumber(record, ["price", "priceUsd", "usdPrice"]),
    createdAt: readString(record, ["createdAt", "created_at"]),
    liquidity: readNumber(record, ["liquidity", "liquidityUsd", "liquidityUSD"]),
    volume24h: readNumber(record, ["volume24h", "volume24H", "volumeUsd24h", "volume"]),
    oneMinGain: normalizeGain(readNumber(record, ["oneMinGain", "gain1m", "priceChange1m"])),
    twoMinGain: normalizeGain(readNumber(record, ["twoMinGain", "gain2m", "priceChange2m"])),
    threeMinGain: normalizeGain(readNumber(record, ["threeMinGain", "gain3m", "priceChange3m"])),
    fourMinGain: normalizeGain(readNumber(record, ["fourMinGain", "gain4m", "priceChange4m"])),
    fiveMinGain: normalizeGain(readNumber(record, ["fiveMinGain", "gain5m", "priceChange5m"])),
    buyPressure5m: readNumber(record, ["buyPressure5m", "buyPressure", "pressure5m"]),
    updatesPerMinute: readNumber(record, [
      "updatesPerMinute",
      "updatesPerMin",
      "updates1m",
      "updateRate",
    ]),
    winRate: readNumber(record, ["winRate", "win_rate"]),
    tokenBeingAnalyzed:
      typeof record.tokenBeingAnalyzed === "boolean"
        ? record.tokenBeingAnalyzed
        : undefined,
    firstSeen: readNumber(record, ["firstSeen", "first_seen", "discoveredAt"]),
    signal: readString(record, ["signal", "status", "tag"]),
  };
}

export function useActivityFeed(): FeedSnapshot {
  const storeRef = useRef<FeedStore | null>(null);
  if (!storeRef.current) storeRef.current = new FeedStore();
  const store = storeRef.current;

  useEffect(() => {
    const es = new EventSource("/api/feed");
    let buf: unknown[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (buf.length) {
        store.ingest(buf);
        buf = [];
      }
      flushTimer = null;
    };

    const onTokens = (e: Event) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data);
        const data: unknown[] = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.tokens)
              ? payload.tokens
            : [];
        if (data.length) {
          buf = buf.concat(data);
          if (!flushTimer) flushTimer = setTimeout(flush, 100);
        }
      } catch {
        /* drop malformed messages */
      }
    };

    const onStatus = (e: Event) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data);
        if (payload?.mode === "rest-fallback") store.setStatus("rest-fallback");
        if (payload?.mode === "live") store.setStatus("live");
      } catch {
        /* drop malformed status */
      }
    };

    const onError = () => store.setStatus("reconnecting");
    const onPing = () => {
      /* keep-alive */
    };
    const staleTimer = setInterval(() => {
      if (store.lastUpdated && Date.now() - store.lastUpdated > 15_000) {
        store.setStatus("stale");
      }
    }, 2_500);

    es.addEventListener("tokens", onTokens);
    es.addEventListener("status", onStatus);
    es.addEventListener("error", onError);
    es.addEventListener("ping", onPing);

    return () => {
      es.removeEventListener("tokens", onTokens);
      es.removeEventListener("status", onStatus);
      es.removeEventListener("error", onError);
      es.removeEventListener("ping", onPing);
      es.close();
      if (flushTimer) clearTimeout(flushTimer);
      clearInterval(staleTimer);
    };
  }, [store]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
