import type { TradeLedger } from "./trade/ledger.ts";

export type AgentPhase = "IDLE" | "WATCHING" | "CALLING" | "TRADING";

export type FeedStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "rest-fallback"
  | "stale";

export interface DecisionLogEntry {
  ts: number;
  symbol: string;
  action: "BUY" | "PASS" | "SELL" | "KILL" | "RESUME";
  reason: string;
}

export interface AgentStateSnapshot {
  phase: AgentPhase;
  selectedTokenId: string | null;
  callingSinceMs: number | null;
  walletSol: number;
  pnlUsd: number;
  openPositions: number;
  killSwitch: boolean;
  feedStatus: FeedStatus;
  walletPubkey: string | null;
  sessionId: string | null;
  lastDecisionLog: DecisionLogEntry[];
}

export interface StateStore {
  snapshot(): AgentStateSnapshot;
  setPhase(phase: AgentPhase): void;
  setSelectedToken(tokenId: string | null): void;
  setFeedStatus(s: FeedStatus): void;
  setSessionId(sessionId: string | null): void;
  recordDecision(entry: DecisionLogEntry): void;
  /** Auto-transition WATCHING/TRADING/CALLING → IDLE based on idle/grace timers. */
  tick(now: number): void;
}

export interface CreateStateStoreArgs {
  ledger: TradeLedger;
  killSwitchRef: { tripped: boolean };
  contentSessionId: string | null;
  walletPubkey: string | null;
  /**
   * Optional accessor returning the live SOL balance. When omitted, snapshot
   * reports `walletSol: 0` (legacy behavior).
   */
  balanceProvider?: () => number;
}

const MAX_DECISION_LOG = 10;
const CALLING_GRACE_MS = 2_000;
const TRADING_HOLD_MS = 2_000;
const IDLE_TIMEOUT_MS = 5_000;

export function createStateStore(args: CreateStateStoreArgs): StateStore {
  const { ledger, killSwitchRef, walletPubkey, balanceProvider } = args;

  let phase: AgentPhase = "IDLE";
  let selectedTokenId: string | null = null;
  let callingSinceMs: number | null = null;
  let lastTransitionMs: number = Date.now();
  let tradingSinceMs: number | null = null;
  let feedStatus: FeedStatus = "connecting";
  let sessionId: string | null = args.contentSessionId;
  const decisionLog: DecisionLogEntry[] = [];

  function snapshot(): AgentStateSnapshot {
    return {
      phase,
      selectedTokenId,
      callingSinceMs,
      walletSol: balanceProvider?.() ?? 0,
      pnlUsd: 0,
      openPositions: ledger.openPositions().length,
      killSwitch: killSwitchRef.tripped,
      feedStatus,
      walletPubkey,
      sessionId,
      lastDecisionLog: [...decisionLog],
    };
  }

  function setPhase(next: AgentPhase): void {
    const now = Date.now();
    phase = next;
    lastTransitionMs = now;
    if (next === "CALLING") {
      callingSinceMs = now;
      tradingSinceMs = null;
    } else if (next === "TRADING") {
      callingSinceMs = null;
      tradingSinceMs = now;
    } else {
      callingSinceMs = null;
      tradingSinceMs = null;
    }
  }

  function setSelectedToken(tokenId: string | null): void {
    selectedTokenId = tokenId;
    lastTransitionMs = Date.now();
  }

  function setFeedStatus(s: FeedStatus): void {
    feedStatus = s;
  }

  function setSessionId(s: string | null): void {
    sessionId = s;
  }

  function recordDecision(entry: DecisionLogEntry): void {
    decisionLog.push(entry);
    while (decisionLog.length > MAX_DECISION_LOG) decisionLog.shift();
    lastTransitionMs = Date.now();
  }

  function tick(now: number): void {
    // CALLING grace timeout: drop back to WATCHING after 2s with no transition.
    if (phase === "CALLING" && callingSinceMs !== null && now - callingSinceMs >= CALLING_GRACE_MS) {
      phase = "WATCHING";
      callingSinceMs = null;
      lastTransitionMs = now;
    }
    // TRADING hold: after 2s flip back to WATCHING.
    if (phase === "TRADING" && tradingSinceMs !== null && now - tradingSinceMs >= TRADING_HOLD_MS) {
      phase = "WATCHING";
      tradingSinceMs = null;
      lastTransitionMs = now;
    }
    // IDLE timeout: 5s with no transitions / decisions / token changes from
    // WATCHING. Don't pull CALLING/TRADING straight into IDLE.
    if (phase === "WATCHING" && now - lastTransitionMs >= IDLE_TIMEOUT_MS) {
      phase = "IDLE";
      selectedTokenId = null;
      lastTransitionMs = now;
    }
  }

  return {
    snapshot,
    setPhase,
    setSelectedToken,
    setFeedStatus,
    setSessionId,
    recordDecision,
    tick,
  };
}
