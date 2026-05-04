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
  symbol: string;
  name: string;
  price?: number;
  liquidity?: number;
  volume24h?: number;
  oneMinGain?: number;
  threeMinGain?: number;
  fiveMinGain?: number;
  buyPressure5m?: number;
  updatesPerMinute?: number;
  signal?: string;
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

  ingest(tokens: ActivityToken[]) {
    if (!Array.isArray(tokens) || tokens.length === 0) return;
    for (const t of tokens) {
      if (!t || !t.tokenId) continue;
      this.map.set(t.tokenId, t);
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

export function useActivityFeed(): FeedSnapshot {
  const storeRef = useRef<FeedStore | null>(null);
  if (!storeRef.current) storeRef.current = new FeedStore();
  const store = storeRef.current;

  useEffect(() => {
    const es = new EventSource("/api/feed");
    let buf: ActivityToken[] = [];
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
        const data: ActivityToken[] = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.data)
            ? payload.data
            : [];
        if (data.length) {
          buf = buf.concat(data);
          if (!flushTimer) flushTimer = setTimeout(flush, 100);
        }
      } catch {
        /* drop malformed messages */
      }
    };

    const onError = () => store.setStatus("reconnecting");
    const onPing = () => {
      /* keep-alive */
    };

    es.addEventListener("tokens", onTokens);
    es.addEventListener("error", onError);
    es.addEventListener("ping", onPing);

    return () => {
      es.removeEventListener("tokens", onTokens);
      es.removeEventListener("error", onError);
      es.removeEventListener("ping", onPing);
      es.close();
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [store]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
