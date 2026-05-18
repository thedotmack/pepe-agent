import type { TradeLedger } from "./trade/ledger.ts";

/**
 * Phase 4 kill switch. Exposes both a boolean for legacy call sites and an
 * AbortSignal so in-flight Jupiter sends can subscribe and abort the
 * rebroadcast/confirm loop when /kill fires mid-trade. The signal is
 * replaced (not un-aborted) on reset() because AbortSignal can't be reused
 * once aborted.
 */
export interface KillSwitchRef {
  tripped: boolean;
  /** True if the worker booted with KILL_SWITCH=1 in env. /unkill refuses to
   *  clear this without an explicit KILL_SWITCH_OVERRIDE=1 confirmation. */
  bootKillSwitchActive: boolean;
  /** Aborts the moment trip() is called. Replaced (new signal) on reset(). */
  signal: AbortSignal;
  trip(): void;
  reset(): void;
}

export function createKillSwitchRef(args: { bootKillSwitchActive: boolean }): KillSwitchRef {
  // Initial controller. trip() aborts this controller and flips `tripped`.
  // reset() throws this controller away and installs a new one so future
  // trades get a fresh, un-aborted signal.
  let controller = new AbortController();
  const ref: KillSwitchRef = {
    tripped: false,
    bootKillSwitchActive: args.bootKillSwitchActive,
    signal: controller.signal,
    trip() {
      if (this.tripped) return;
      this.tripped = true;
      controller.abort();
    },
    reset() {
      this.tripped = false;
      controller = new AbortController();
      // Reassign exposed signal so subscribers reading `ref.signal` see the
      // new (un-aborted) one. Existing listeners on the old signal are dead
      // weight but harmless — they fire once on its prior abort, if any.
      this.signal = controller.signal;
    },
  };
  return ref;
}

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
  /**
   * Phase 4: called by the trade handler when an executeTrade attempt fully
   * resolves (ok / failed_onchain / not_landed / landed_after_timeout /
   * no_token_account). Clears the TRADING phase. Without this the state
   * machine would otherwise stay TRADING until the 90s safety timeout fires.
   */
  recordTradeResult(reason: string): void;
  /** Auto-transition WATCHING/TRADING/CALLING → IDLE based on idle/grace timers. */
  tick(now: number): void;
}

export interface CreateStateStoreArgs {
  ledger: TradeLedger;
  /** Phase 4: KillSwitchRef now exposes a `signal: AbortSignal` so in-flight
   *  trades can compose it. Reads still only need `tripped`. */
  killSwitchRef: Pick<KillSwitchRef, "tripped">;
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
/**
 * Phase 4: TRADING phase now clears on `recordTradeResult(...)`, not on a
 * timer. This is the safety net only: if a trade handler never calls
 * recordTradeResult (crash mid-handler, await wedged), force WATCHING after
 * 90s so the agent isn't stuck. 90s matches the Jupiter CONFIRM_TIMEOUT_MS
 * upper bound (worker/src/trade/jupiter.ts:36) plus headroom.
 */
const TRADING_SAFETY_TIMEOUT_MS = 90_000;
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

  function recordTradeResult(_reason: string): void {
    // Phase 4: trade handler reports completion (any variant). Only clear
    // TRADING — never reach in from outside if we were never in TRADING.
    if (phase === "TRADING") {
      phase = "WATCHING";
      tradingSinceMs = null;
      lastTransitionMs = Date.now();
    }
  }

  function tick(now: number): void {
    // CALLING grace timeout: drop back to WATCHING after 2s with no transition.
    if (phase === "CALLING" && callingSinceMs !== null && now - callingSinceMs >= CALLING_GRACE_MS) {
      phase = "WATCHING";
      callingSinceMs = null;
      lastTransitionMs = now;
    }
    // Phase 4: TRADING phase no longer auto-flips on a timer. It clears
    // ONLY when recordTradeResult fires (handler resolved any variant) or
    // when the 90s safety timeout fires (handler got stuck/crashed). The
    // 90s is a backstop, not the primary mechanism. See state.test.ts for
    // the contract.
    if (
      phase === "TRADING" &&
      tradingSinceMs !== null &&
      now - tradingSinceMs >= TRADING_SAFETY_TIMEOUT_MS
    ) {
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
    recordTradeResult,
    tick,
  };
}
