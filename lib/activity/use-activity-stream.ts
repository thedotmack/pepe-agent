"use client";

import { useEffect } from "react";
import { initializeActivityWebSocket } from "./activity-websocket";
import { useActivityStore } from "./activity-store";

let initialized = false;

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
    if (initialized) return;
    initialized = true;
    const { cleanup } = initializeActivityWebSocket({
      onTokenUpdate: setTokens,
      onConnectionChange: setConnectionState,
      onError: setError,
    });
    return () => {
      initialized = false;
      cleanup();
    };
  }, [setTokens, setConnectionState, setError]);
}
