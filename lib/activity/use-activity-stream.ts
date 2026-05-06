"use client";

import { useEffect } from "react";
import { initializeActivityWebSocket } from "./activity-websocket";
import { useActivityStore } from "./activity-store";

let mountCount = 0;
let sharedCleanup: (() => void) | null = null;

/**
 * Initializes the singleton activity websocket exactly once and pipes
 * updates into the Zustand store. Safe to call from any component;
 * subsequent calls are no-ops.
 */
export function useActivityStream(): void {
  const setTokens = useActivityStore((s) => s.setTokens);
  const setConnectionState = useActivityStore((s) => s.setConnectionState);
  const setError = useActivityStore((s) => s.setError);

  useEffect(() => {
    mountCount += 1;
    if (mountCount === 1) {
      const { cleanup } = initializeActivityWebSocket({
        onTokenUpdate: setTokens,
        onConnectionChange: setConnectionState,
        onError: setError,
      });
      sharedCleanup = cleanup;
    }
    return () => {
      mountCount = Math.max(0, mountCount - 1);
      if (mountCount === 0) {
        sharedCleanup?.();
        sharedCleanup = null;
      }
    };
  }, [setTokens, setConnectionState, setError]);
}
