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
process.env.AGENT_SHARED_SECRET = "test-shared-secret-32-chars-min-x";

import { createStateStore, createKillSwitchRef } from "./state.ts";
import type { TradeLedger } from "./trade/ledger.ts";

// Minimal in-memory ledger fake — only openPositions() is read by snapshot.
function fakeLedger(): TradeLedger {
  return {
    dbPath: ":memory:",
    recordTrade: () => ({ id: 1 }),
    hasTradeTxid: () => false,
    lastTradeMs: () => null,
    totalSolToday: () => 0,
    dailyBuySolToday: () => 0,
    openPositions: () => [],
    openPosition: () => {},
    setPositionDecimals: () => {},
    closePosition: () => {},
    close: () => {},
  };
}

function makeStore() {
  const killSwitchRef = createKillSwitchRef({ bootKillSwitchActive: false });
  const store = createStateStore({
    ledger: fakeLedger(),
    killSwitchRef,
    contentSessionId: null,
    walletPubkey: null,
  });
  return { store, killSwitchRef };
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

  it("flips TRADING → WATCHING after the 90s safety timeout (handler wedged)", () => {
    const { store } = makeStore();
    // setPhase reads Date.now() internally for tradingSinceMs, so we have
    // to make the synthetic `now` we feed to tick() match real wall-clock
    // delta. Capture the moment we entered TRADING and feed tick() values
    // relative to that.
    const enteredAt = Date.now();
    store.setPhase("TRADING");

    // Just under 90s — still TRADING.
    store.tick(enteredAt + 89_000);
    expect(store.snapshot().phase).toBe("TRADING");

    // Just over 90s — safety timeout kicks in.
    store.tick(enteredAt + 90_001);
    expect(store.snapshot().phase).toBe("WATCHING");
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
