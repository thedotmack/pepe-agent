/**
 * Phase 4 verification: the state machine's TRADING phase is no longer
 * cleared by a 2-second timer. It clears ONLY when `recordTradeResult` is
 * called (the trade handler resolved an executeTrade variant) OR after the
 * 90-second safety timeout (handler crashed / wedged).
 *
 * Coverage:
 *   - TRADING does NOT auto-flip after the old TRADING_HOLD_MS=2s window.
 *   - recordTradeResult while in TRADING immediately flips to WATCHING.
 *   - 90s safety timeout flips TRADING → WATCHING when recordTradeResult
 *     never fires (simulating a wedged handler).
 *   - recordTradeResult outside TRADING is a no-op (defensive: handler
 *     calls it on early denies that may have already flipped phase).
 *
 * Run: `bun test src/state.test.ts` from `worker/`.
 *
 * No real timers wall-clocked. We drive the tick() function manually with
 * synthetic `now` values — same pattern bun/jest fake timers would give us
 * but cheaper (the state machine is pure-function modulo the closure clock).
 */
import { describe, it, expect } from "bun:test";

// config.ts validates AGENT_SHARED_SECRET at module load — set before import.
// Phase 7 H2 hazard: static ES imports are hoisted ahead of these assignments,
// so any module that transitively loads config.ts (e.g. jupiter.ts, which
// state.ts now depends on) MUST be imported dynamically below.
process.env.AGENT_SHARED_SECRET = "test-shared-secret-32-chars-min-x";
process.env.SOLANA_NETWORK = "devnet";

import type { TradeLedger } from "./trade/ledger.ts";

// Phase 7 H2: state.ts derives its safety timeout from CONFIRM_TIMEOUT_MS
// (worker/src/trade/jupiter.ts) + 5s headroom. Both modules trigger
// config.ts validation at load time, so we dynamic-import them AFTER the
// process.env assignments above. Mirrors the pattern in
// jupiter-sell.test.ts / jupiter-confirm.test.ts.
const { createStateStore, createKillSwitchRef } = await import("./state.ts");
const { CONFIRM_TIMEOUT_MS } = await import("./trade/jupiter.ts");

// Minimal in-memory ledger fake — captures recordPhaseEvent so the Phase 7
// H4 test can assert the meta payload landed.
type PhaseEventRow = {
  id: number;
  ts: number;
  side: string | null;
  txid: string | null;
  outcome: string | null;
  reason: string;
};
function fakeLedger(): TradeLedger & { phaseEvents: PhaseEventRow[] } {
  const phaseEvents: PhaseEventRow[] = [];
  let nextId = 1;
  return {
    dbPath: ":memory:",
    recordTrade: () => ({ id: 1 }),
    hasTradeTxid: () => false,
    lastTradeMs: () => null,
    dailyBuySolToday: () => 0,
    openPositions: () => [],
    openPosition: () => {},
    setPositionDecimals: () => {},
    // Phase 10 (#1): TradeLedger now requires setPositionTokensReceived for
    // backfilling legacy rows; state tests don't exercise it, inert noop.
    setPositionTokensReceived: () => {},
    closePosition: () => {},
    recordPhaseEvent: (input) => {
      phaseEvents.push({
        id: nextId++,
        ts: Date.now(),
        side: input.side ?? null,
        txid: input.txid ?? null,
        outcome: input.outcome ?? null,
        reason: input.reason,
      });
    },
    recentPhaseEvents: (limit = 50) => phaseEvents.slice(-limit).reverse(),
    close: () => {},
    phaseEvents,
  };
}

function makeStore() {
  const killSwitchRef = createKillSwitchRef({ bootKillSwitchActive: false });
  const ledger = fakeLedger();
  const store = createStateStore({
    ledger,
    killSwitchRef,
    contentSessionId: null,
    walletPubkey: null,
  });
  return { store, killSwitchRef, ledger };
}

describe("StateStore TRADING phase (Phase 4)", () => {
  it("does NOT auto-flip out of TRADING after 2 seconds (legacy TRADING_HOLD_MS removed)", () => {
    const { store } = makeStore();
    const t0 = 1_000_000_000;
    store.setPhase("TRADING");
    expect(store.snapshot().phase).toBe("TRADING");

    // Advance well past the old 2s window.
    store.tick(t0 + 2_500);
    expect(store.snapshot().phase).toBe("TRADING");

    // Even 30s in we should still be TRADING (under the 90s safety net).
    store.tick(t0 + 30_000);
    expect(store.snapshot().phase).toBe("TRADING");
  });

  it("flips TRADING → WATCHING when recordTradeResult fires", () => {
    const { store } = makeStore();
    store.setPhase("TRADING");
    expect(store.snapshot().phase).toBe("TRADING");

    store.recordTradeResult("executed fake-txid");
    expect(store.snapshot().phase).toBe("WATCHING");
  });

  it("flips TRADING → WATCHING after the safety timeout (handler wedged)", () => {
    const { store } = makeStore();
    // setPhase reads Date.now() internally for tradingSinceMs, so we have
    // to make the synthetic `now` we feed to tick() match real wall-clock
    // delta. Capture the moment we entered TRADING and feed tick() values
    // relative to that.
    const enteredAt = Date.now();
    store.setPhase("TRADING");

    // Phase 7 H2: TRADING_SAFETY_TIMEOUT_MS = CONFIRM_TIMEOUT_MS + 5_000.
    // Just under the threshold — still TRADING.
    const safety = CONFIRM_TIMEOUT_MS + 5_000;
    store.tick(enteredAt + safety - 1_000);
    expect(store.snapshot().phase).toBe("TRADING");

    // Just over the threshold — safety timeout kicks in.
    store.tick(enteredAt + safety + 1);
    expect(store.snapshot().phase).toBe("WATCHING");
  });

  it("Phase 7 H4: recordTradeResult persists meta to ledger.recordPhaseEvent", () => {
    const { store, ledger } = makeStore();
    store.setPhase("TRADING");

    store.recordTradeResult("executed 5xfake", {
      side: "BUY",
      txid: "5xfake",
      outcome: "ok",
    });

    expect(ledger.phaseEvents.length).toBe(1);
    const ev = ledger.phaseEvents[0];
    expect(ev.side).toBe("BUY");
    expect(ev.txid).toBe("5xfake");
    expect(ev.outcome).toBe("ok");
    expect(ev.reason).toBe("executed 5xfake");
  });

  it("Phase 7 H4: recordTradeResult persists a row even when phase was not TRADING (denial trail)", () => {
    // Denied trades early-return through recordTradeResult before the phase
    // ever flipped to TRADING (kill-switch / policy denial). The meta must
    // still land in phase_events so a human can reconcile every attempt.
    const { store, ledger } = makeStore();
    expect(store.snapshot().phase).toBe("IDLE");

    store.recordTradeResult("policy: kill switch tripped", {
      side: "BUY",
      outcome: "denied_kill_switch",
    });

    expect(ledger.phaseEvents.length).toBe(1);
    expect(ledger.phaseEvents[0].outcome).toBe("denied_kill_switch");
    expect(ledger.phaseEvents[0].txid).toBeNull();
  });

  it("recordTradeResult outside TRADING is a no-op (does not stomp WATCHING/IDLE/CALLING)", () => {
    const { store } = makeStore();

    // Start in IDLE.
    expect(store.snapshot().phase).toBe("IDLE");
    store.recordTradeResult("stray call");
    expect(store.snapshot().phase).toBe("IDLE");

    // CALLING should not be cleared by trade-result event.
    store.setPhase("CALLING");
    expect(store.snapshot().phase).toBe("CALLING");
    store.recordTradeResult("stray call");
    expect(store.snapshot().phase).toBe("CALLING");

    // WATCHING stays WATCHING.
    store.setPhase("WATCHING");
    expect(store.snapshot().phase).toBe("WATCHING");
    store.recordTradeResult("stray call");
    expect(store.snapshot().phase).toBe("WATCHING");
  });
});

describe("KillSwitchRef AbortSignal (Phase 4)", () => {
  it("signal aborts when trip() is called", () => {
    const ref = createKillSwitchRef({ bootKillSwitchActive: false });
    expect(ref.tripped).toBe(false);
    expect(ref.signal.aborted).toBe(false);

    ref.trip();
    expect(ref.tripped).toBe(true);
    expect(ref.signal.aborted).toBe(true);
  });

  it("reset() replaces the signal with a fresh (un-aborted) one", () => {
    const ref = createKillSwitchRef({ bootKillSwitchActive: false });
    ref.trip();
    expect(ref.signal.aborted).toBe(true);

    const oldSignal = ref.signal;
    ref.reset();

    expect(ref.tripped).toBe(false);
    // Old signal stays aborted (AbortSignal can't un-abort), but ref.signal
    // is now a different signal — un-aborted.
    expect(oldSignal.aborted).toBe(true);
    expect(ref.signal).not.toBe(oldSignal);
    expect(ref.signal.aborted).toBe(false);
  });

  it("trip() is idempotent (calling twice does not throw)", () => {
    const ref = createKillSwitchRef({ bootKillSwitchActive: false });
    ref.trip();
    ref.trip(); // must not throw
    expect(ref.tripped).toBe(true);
    expect(ref.signal.aborted).toBe(true);
  });

  it("bootKillSwitchActive is preserved across reset()", () => {
    const ref = createKillSwitchRef({ bootKillSwitchActive: true });
    expect(ref.bootKillSwitchActive).toBe(true);
    ref.trip();
    ref.reset();
    // bootKillSwitchActive describes how the worker started — never
    // cleared by reset(). /unkill still requires KILL_SWITCH_OVERRIDE=1.
    expect(ref.bootKillSwitchActive).toBe(true);
  });
});
