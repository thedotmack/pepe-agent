"use client";

import { create } from "zustand";
import type { ActivityToken, ConnectionState } from "./activity-websocket";

export interface ActivityState {
  tokens: ActivityToken[];
  connectionState: ConnectionState;
  isConnected: boolean;
  lastUpdated: number;
  error: string | null;
  setTokens: (tokens: ActivityToken[]) => void;
  setConnectionState: (state: ConnectionState) => void;
  setError: (error: string | null) => void;
  getTopTokens: (limit: number) => ActivityToken[];
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  tokens: [],
  connectionState: "disconnected",
  isConnected: false,
  lastUpdated: 0,
  error: null,
  setTokens: (tokens) =>
    set({
      tokens,
      lastUpdated: Date.now(),
      error: null,
    }),
  setConnectionState: (connectionState) =>
    set({
      connectionState,
      isConnected: connectionState === "connected",
    }),
  setError: (error) => set({ error }),
  getTopTokens: (limit: number) => get().tokens.slice(0, limit),
}));
