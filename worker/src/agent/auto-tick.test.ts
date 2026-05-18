/**
 * Phase 4 verification: auto-tick's turnIdle race fix.
 *
 * Before: turnIdle was flipped to `false` only when the agent emitted
 * `assistantText`. Between `injectUserMessage` and the first assistantText
 * token there could be several seconds; the 15s push interval could fire
 * mid-turn and inject another snapshot/decision turn, stacking work and
 * confusing the agent's reasoning.
 *
 * After: turnIdle = false is set at inject time (inside the pushInterval
 * body, right before each injectActivityContext / injectUserMessage call).
 * turnIdle = true is set only on `result` (turn fully resolved). The
 * existing `if (!turnIdle) return;` guard at the top of the pushInterval
 * body now actually skips work while a turn is in flight.
 *
 * Coverage:
 *   - First push fires (turnIdle starts true).
 *   - After first push, turnIdle is false and the next interval tick is
 *     skipped (no second inject).
 *   - When the agent's emitter fires `result`, turnIdle goes true again
 *     and the next interval tick injects.
 *
 * No real timers wall-clocked — we use a small pollMs (50ms) and wait just
 * past the interval boundary, same pattern as position-monitor-math.test.ts.
 *
 * Run: `bun test src/agent/auto-tick.test.ts` from `worker/`.
 */
import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";

process.env.AGENT_SHARED_SECRET = "test-shared-secret-32-chars-min-x";
process.env.SOLANA_NETWORK = "devnet";

import type { ActivitySubscriber, ActivityToken } from "../activity/subscriber.ts";
import type { AgentLoopHandle } from "./loop.ts";
import type { StateStore, AgentPhase } from "../state.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Build a snapshot that PASSES the auto-tick pre-filter (BRIEF §7.2 gates)
// so the candidate list is non-empty. Thresholds from policy.ts:
// fiveMinGain >= MIN_FIVE_MIN_GAIN, buyPressure5m >= MIN_BUY_PRESSURE_5M,
// liquidity >= MIN_LIQUIDITY_USD, updatesPerMinute >= MIN_UPDATES_PER_MINUTE.
function passingToken(symbol: string): ActivityToken {
  return {
    tokenId: `Mint${symbol}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    symbol,
    name: symbol,
    price: 0.001,
    liquidity: 1_000_000,
    volume24h: 5_000_000,
    fiveMinGain: 0.5,
    threeMinGain: 0.3,
    oneMinGain: 0.1,
    buyPressure5m: 0.95,
    updatesPerMinute: 30,
    signal: "STRONG",
  };
}

function fakeSubscriber(tokens: ActivityToken[]): ActivitySubscriber {
  return {
    getSnapshot: () => tokens,
    emitter: new EventEmitter(),
    stop: () => {},
    getStatus: () => "live",
  };
}

function fakeAgent(): AgentLoopHandle & {
  emitter: EventEmitter;
  injects: { kind: "user" | "context"; text: string }[];
} {
  const emitter = new EventEmitter();
  const injects: { kind: "user" | "context"; text: string }[] = [];
  return {
    emitter,
    injects,
    injectUserMessage: (text: string) => {
      injects.push({ kind: "user", text });
    },
    injectActivityContext: (text: string) => {
      injects.push({ kind: "context", text });
    },
    stop: () => {},
    getQueryHandle: () => null,
  };
}

function fakeStateStore(initialPhase: AgentPhase = "WATCHING"): StateStore {
  let phase: AgentPhase = initialPhase;
  return {
    snapshot: () => ({
      phase,
      selectedTokenId: null,
      callingSinceMs: null,
      walletSol: 1,
      pnlUsd: 0,
      openPositions: 0,
      killSwitch: false,
      feedStatus: "live",
      walletPubkey: null,
      sessionId: null,
      lastDecisionLog: [],
    }),
    setPhase: (next) => {
      phase = next;
    },
    setSelectedToken: () => {},
    setFeedStatus: () => {},
    setSessionId: () => {},
    recordDecision: () => {},
    recordTradeResult: () => {},
    tick: () => {},
  };
}

// Import auto-tick after the env is set so config.ts loads cleanly.
const { startAutoTick } = await import("./auto-tick.ts");

describe("auto-tick turnIdle race (Phase 4)", () => {
  it("first tick injects when turnIdle starts true", async () => {
    const agent = fakeAgent();
    const subscriber = fakeSubscriber([passingToken("AAA")]);
    const stateStore = fakeStateStore("WATCHING");

    const handle = startAutoTick({
      subscriber,
      agent,
      stateStore,
      pushIntervalMs: 50,
      decisionIntervalMs: 60_000,
    });
    await sleep(120);
    handle.stop();

    // First push should land — turnIdle started true. Auto-tick injects
    // a market_snapshot context AND (since lastDecisionAt starts at 0) a
    // forced decision turn in the same body — both happen on the same
    // tick, both flip turnIdle=false. Pre-fix nothing about the SECOND
    // inject would have ever happened.
    expect(agent.injects.length).toBeGreaterThanOrEqual(1);
    expect(agent.injects[0].kind).toBe("context");
    expect(agent.injects[0].text).toContain("market_snapshot");
  });

  it("does NOT push again while turnIdle is false (no `result` emitted between ticks)", async () => {
    const agent = fakeAgent();
    const subscriber = fakeSubscriber([passingToken("BBB")]);
    const stateStore = fakeStateStore("WATCHING");

    const handle = startAutoTick({
      subscriber,
      agent,
      stateStore,
      pushIntervalMs: 50,
      decisionIntervalMs: 60_000,
    });
    // Wait until first tick body completes (~120ms), then snapshot count.
    await sleep(120);
    const afterFirst = agent.injects.length;

    // Wait several more interval ticks. Without a `result` event the agent
    // stays busy (turnIdle=false) and subsequent ticks must skip entirely.
    await sleep(300);
    handle.stop();

    // No new injects after the first tick — turnIdle gate held.
    // Pre-fix: each 50ms interval would have pushed another snapshot, so
    // we'd see ~6 additional injects across 300ms.
    expect(agent.injects.length).toBe(afterFirst);
  });

  it("pushes again after the agent's emitter fires `result` (turnIdle reset)", async () => {
    const agent = fakeAgent();
    const subscriber = fakeSubscriber([passingToken("CCC")]);
    const stateStore = fakeStateStore("WATCHING");

    const handle = startAutoTick({
      subscriber,
      agent,
      stateStore,
      pushIntervalMs: 50,
      decisionIntervalMs: 60_000,
    });
    // First tick injects (count: 1 snapshot + possibly 1 decision).
    await sleep(120);
    const afterFirst = agent.injects.length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // Drain busy state via fake result event.
    agent.emitter.emit("result", { type: "result" });

    // Next interval tick injects again — at least one more inject lands.
    await sleep(120);
    handle.stop();

    expect(agent.injects.length).toBeGreaterThan(afterFirst);
  });

  it("skips push when phase is TRADING (existing guard, regression check)", async () => {
    const agent = fakeAgent();
    const subscriber = fakeSubscriber([passingToken("DDD")]);
    const stateStore = fakeStateStore("TRADING");

    const handle = startAutoTick({
      subscriber,
      agent,
      stateStore,
      pushIntervalMs: 50,
      decisionIntervalMs: 60_000,
    });
    await sleep(200);
    handle.stop();

    // No injects while in TRADING phase.
    expect(agent.injects.length).toBe(0);
  });
});

// ─── Phase 11 (codex Phase 10 re-audit H2): shared turnIdle plumbing ────
// Pre-Phase-11 the turnIdle flag lived inside startAutoTick's closure.
// A /chat injection would invoke agent.injectUserMessage directly, never
// flipping that flag — so auto-tick's 15s push could stack a snapshot
// injection on top of the in-flight chat turn. Phase 11 introduces a
// shared TurnIdleRef passed to BOTH sites.

describe("auto-tick + chat-stream shared turnIdleRef (Phase 11 H2)", () => {
  it("auto-tick respects a turnIdleRef flipped false externally (simulating /chat)", async () => {
    const { createTurnIdleRef } = await import("./auto-tick.ts");
    const agent = fakeAgent();
    const subscriber = fakeSubscriber([passingToken("EEE")]);
    const stateStore = fakeStateStore("WATCHING");

    // External code (e.g. chat-stream.ts) flips this BEFORE auto-tick's
    // first interval fires. auto-tick should see false and skip.
    const turnIdleRef = createTurnIdleRef();
    turnIdleRef.current = false;

    const handle = startAutoTick({
      subscriber,
      agent,
      stateStore,
      turnIdleRef,
      pushIntervalMs: 50,
      decisionIntervalMs: 60_000,
    });
    await sleep(200);
    handle.stop();

    // Pre-fix: auto-tick's private turnIdle would still be true, and it
    // would have pushed a snapshot even though /chat marked turn busy.
    // Post-fix: shared ref means auto-tick sees the false flip and skips.
    expect(agent.injects.length).toBe(0);
  });

  it("auto-tick resumes pushing after a `result` event resets the shared ref", async () => {
    const { createTurnIdleRef } = await import("./auto-tick.ts");
    const agent = fakeAgent();
    const subscriber = fakeSubscriber([passingToken("FFF")]);
    const stateStore = fakeStateStore("WATCHING");

    const turnIdleRef = createTurnIdleRef();
    turnIdleRef.current = false;

    const handle = startAutoTick({
      subscriber,
      agent,
      stateStore,
      turnIdleRef,
      pushIntervalMs: 50,
      decisionIntervalMs: 60_000,
    });
    // First few intervals must skip (turnIdleRef.current=false).
    await sleep(150);
    expect(agent.injects.length).toBe(0);

    // Simulate the chat turn ending — agent emits `result`. auto-tick's
    // listener should flip the SHARED ref back to true.
    agent.emitter.emit("result", { type: "result" });
    // The shared ref must now reflect that — direct check.
    expect(turnIdleRef.current).toBe(true);

    // Now the next interval should inject.
    await sleep(120);
    handle.stop();
    expect(agent.injects.length).toBeGreaterThanOrEqual(1);
  });

  it("auto-tick flips the shared ref false on its own inject (so chat-stream / external code can read it)", async () => {
    const { createTurnIdleRef } = await import("./auto-tick.ts");
    const agent = fakeAgent();
    const subscriber = fakeSubscriber([passingToken("GGG")]);
    const stateStore = fakeStateStore("WATCHING");

    // Start with ref idle=true so the first tick injects.
    const turnIdleRef = createTurnIdleRef();
    expect(turnIdleRef.current).toBe(true);

    const handle = startAutoTick({
      subscriber,
      agent,
      stateStore,
      turnIdleRef,
      pushIntervalMs: 50,
      decisionIntervalMs: 60_000,
    });
    await sleep(120);
    handle.stop();

    // After auto-tick injected, the shared ref must be false — proving
    // auto-tick's inject side updates the same object the /chat side
    // observes. (If auto-tick wrote to a private flag this would be true.)
    expect(agent.injects.length).toBeGreaterThanOrEqual(1);
    expect(turnIdleRef.current).toBe(false);
  });
});
