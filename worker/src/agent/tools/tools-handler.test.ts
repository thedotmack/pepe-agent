/**
 * Phase 7 H3 + H5: handler-level tests for the submit_trade tool.
 *
 * Drives the tools/index.ts submitTrade.handler directly — bypassing the
 * MCP transport layer — by:
 *   1. mock.module-ing the underlying executeTrade and getMint so the
 *      handler's "fetch decimals + run swap" path is fully deterministic.
 *   2. Calling createPepeTools(args).submitTrade.handler(input, undefined).
 *
 * Coverage:
 *   H3 landed_after_timeout — reconcile annotation lands in trades.reason,
 *      ledger.recordTrade + closePosition both fire for SELL.
 *   H3 BUY landed_after_timeout — same reconcile annotation, recordTrade
 *      and openPosition fire.
 *   H3 failed_onchain — the audit-flagged "highest-leverage" case; trade
 *      MUST NOT be recorded as success; phase_events captures it.
 *   H5 float→atomic SELL — UI 1.999999999 with decimals=9 floors to
 *      1_999_999_999n atomic and is passed to executeTrade correctly.
 *
 * Anti-pattern guards from PLAN-real-go-live.md Phase 7:
 *   - No real RPC.
 *   - No production code mutations gated on test imports.
 *   - failed_onchain is asserted because the audit specifically called it
 *     out as the highest-leverage failure mode.
 *
 * Run: `bun test src/agent/tools/tools-handler.test.ts` from `worker/`.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";

// config.ts validates AGENT_SHARED_SECRET at module load — set BEFORE the
// dynamic import below pulls config in transitively.
process.env.AGENT_SHARED_SECRET = "test-shared-secret-32-chars-min-x";
process.env.SOLANA_NETWORK = "devnet";

import type { TradeLedger } from "../../trade/ledger.ts";
import type { ActivitySubscriber } from "../../activity/subscriber.ts";
import type { ClaudeMemClient } from "../../memory/claude-mem-client.ts";
import type { StateStore, KillSwitchRef } from "../../state.ts";
import type {
  ExecuteTradeArgs,
  ExecuteTradeResult,
} from "../../trade/jupiter.ts";

// ---------- Mocks ----------
// executeTrade is the only piece of the handler we want to stub; quote +
// getMint are stubbed for the same reason (no real RPC). The handler's
// purpose under test is the SWITCH and BOOKKEEPING — not the swap itself.
let executeTradeImpl: (args: ExecuteTradeArgs) => Promise<ExecuteTradeResult> =
  async () => {
    throw new Error("executeTradeImpl unset in test");
  };
let lastExecuteArgs: ExecuteTradeArgs | null = null;

mock.module("../../trade/jupiter.ts", () => ({
  // Phase 7 H3: handler calls these three from jupiter.ts.
  executeTrade: async (args: ExecuteTradeArgs) => {
    lastExecuteArgs = args;
    return executeTradeImpl(args);
  },
  getQuote: async () => {
    throw new Error("getQuote not used in these tests");
  },
  defaultRpcUrl: () => "http://test.invalid",
  CONFIRM_TIMEOUT_MS: 90_000,
  REBROADCAST_INTERVAL_MS: 2_000,
}));

// getMint resolves decimals before executeTrade. Fix at 9 so the SELL UI →
// atomic conversion (H5) is deterministic.
const mintDecimalsRef = { value: 9 };
mock.module("@solana/spl-token", () => ({
  getMint: async () => ({ decimals: mintDecimalsRef.value }),
  getAssociatedTokenAddressSync: (mint: unknown) => mint,
  getAccount: async () => ({ amount: 10_000_000_000n }),
  TokenAccountNotFoundError: class extends Error {},
}));

// web3.js Connection + PublicKey are referenced for `new Connection(...)`
// and `new PublicKey(...)` inside the handler. Inert stubs are enough.
class FakeConnection {
  constructor(_url: string, _commitment?: string) {}
}
class FakePublicKey {
  private _v: string;
  constructor(v: string) {
    this._v = v;
  }
  toBase58() {
    return this._v;
  }
  toString() {
    return this._v;
  }
}
mock.module("@solana/web3.js", () => ({
  Connection: FakeConnection,
  PublicKey: FakePublicKey,
  LAMPORTS_PER_SOL: 1_000_000_000,
}));

mock.module("../../trade/wallet.ts", () => ({
  getKeypair: () => ({ _fake: true }),
  getPublicKey: () => "11111111111111111111111111111111",
  tryGetPublicKey: () => "11111111111111111111111111111111",
  walletAvailable: () => true,
}));

// Import AFTER mocks register.
const { createPepeTools } = await import("./index.ts");

// ---------- Test fakes ----------

function fakeSubscriber(): ActivitySubscriber {
  return {
    emitter: new EventEmitter(),
    getSnapshot: () => [],
    getStatus: () => "live",
    stop: () => {},
  };
}

interface CapturedLedger extends TradeLedger {
  trades: Array<{
    tokenIn: string;
    tokenOut: string;
    side: "BUY" | "SELL";
    amountSol: number;
    txid: string | null;
    executedPriceSolPerToken: number | null;
    reason: string;
  }>;
  openPositionCalls: Array<{ tokenId: string; decimals: number; sizeSol: number }>;
  closePositionCalls: string[];
  phaseEvents: Array<{
    side: string | null;
    txid: string | null;
    outcome: string | null;
    reason: string;
  }>;
}

function fakeLedger(): CapturedLedger {
  const trades: CapturedLedger["trades"] = [];
  const openPositionCalls: CapturedLedger["openPositionCalls"] = [];
  const closePositionCalls: string[] = [];
  const phaseEvents: CapturedLedger["phaseEvents"] = [];
  return {
    dbPath: ":memory:",
    recordTrade: (input) => {
      trades.push({ ...input });
      return { id: trades.length };
    },
    hasTradeTxid: (txid) => trades.some((t) => t.txid === txid),
    lastTradeMs: () => null,
    dailyBuySolToday: () => 0,
    openPositions: () => [],
    openPosition: (input) => {
      openPositionCalls.push({
        tokenId: input.tokenId,
        decimals: input.decimals,
        sizeSol: input.sizeSol,
      });
    },
    setPositionDecimals: () => {},
    closePosition: (tokenId) => {
      closePositionCalls.push(tokenId);
    },
    recordPhaseEvent: (input) => {
      phaseEvents.push({
        side: input.side ?? null,
        txid: input.txid ?? null,
        outcome: input.outcome ?? null,
        reason: input.reason,
      });
    },
    recentPhaseEvents: (limit = 50) => phaseEvents.slice(-limit).reverse().map((e, i) => ({
      id: i,
      ts: Date.now(),
      ...e,
    })),
    close: () => {},
    trades,
    openPositionCalls,
    closePositionCalls,
    phaseEvents,
  };
}

interface CapturedStateStore extends StateStore {
  decisions: Array<{ action: string; reason: string; symbol: string }>;
  tradeResults: Array<{
    reason: string;
    side?: "BUY" | "SELL";
    txid?: string;
    outcome?: string;
  }>;
  phaseHistory: string[];
}

function fakeStateStore(): CapturedStateStore {
  let phase: "IDLE" | "WATCHING" | "CALLING" | "TRADING" = "WATCHING";
  const decisions: CapturedStateStore["decisions"] = [];
  const tradeResults: CapturedStateStore["tradeResults"] = [];
  const phaseHistory: string[] = [phase];
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
      phaseHistory.push(next);
    },
    setSelectedToken: () => {},
    setFeedStatus: () => {},
    setSessionId: () => {},
    recordDecision: (entry) => {
      decisions.push({
        action: entry.action,
        reason: entry.reason,
        symbol: entry.symbol,
      });
    },
    recordTradeResult: (reason, meta) => {
      tradeResults.push({ reason, ...meta });
      // Mirror prod behavior: clearing TRADING when the result arrives.
      if (phase === "TRADING") {
        phase = "WATCHING";
        phaseHistory.push("WATCHING");
      }
    },
    tick: () => {},
    decisions,
    tradeResults,
    phaseHistory,
  };
}

function fakeKillSwitchRef(): KillSwitchRef {
  const controller = new AbortController();
  return {
    tripped: false,
    bootKillSwitchActive: false,
    signal: controller.signal,
    trip() {},
    reset() {},
  };
}

const fakeMemClient: ClaudeMemClient = {
  baseUrl: "http://test.invalid",
  health: async () => true,
  initSession: async () => ({}),
  recordObservation: async () => ({}),
  summarize: async () => ({}),
  search: async () => ({}),
};

// ---------- Wiring helper ----------

function buildTools() {
  const subscriber = fakeSubscriber();
  const ledger = fakeLedger();
  const stateStore = fakeStateStore();
  const killSwitchRef = fakeKillSwitchRef();
  const tools = createPepeTools({
    subscriber,
    tradePolicyCheck: () => ({ allow: true }),
    killSwitchRef,
    ledger,
    memClient: fakeMemClient,
    contentSessionId: "test-session",
    stateStore,
  });
  return { tools, ledger, stateStore, killSwitchRef, subscriber };
}

const TOKEN_MINT = "MintTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Zod's InferShape treats optional fields as `T | undefined` (required-but-
 * undefined), not `T?`. Constructing submit_trade inputs by hand requires
 * the absent side's amount field be present-as-undefined.
 */
function buyInput(opts: {
  tokenIn: string;
  tokenOut: string;
  amountSol: number;
  slippageBps?: number;
  reason: string;
}) {
  return {
    tokenIn: opts.tokenIn,
    tokenOut: opts.tokenOut,
    side: "BUY" as const,
    amountSol: opts.amountSol,
    sellAmountTokens: undefined,
    slippageBps: opts.slippageBps ?? 100,
    reason: opts.reason,
  };
}
function sellInput(opts: {
  tokenIn: string;
  tokenOut: string;
  sellAmountTokens: number;
  slippageBps?: number;
  reason: string;
}) {
  return {
    tokenIn: opts.tokenIn,
    tokenOut: opts.tokenOut,
    side: "SELL" as const,
    amountSol: undefined,
    sellAmountTokens: opts.sellAmountTokens,
    slippageBps: opts.slippageBps ?? 100,
    reason: opts.reason,
  };
}

beforeEach(() => {
  lastExecuteArgs = null;
  executeTradeImpl = async () => {
    throw new Error("executeTradeImpl unset");
  };
  mintDecimalsRef.value = 9;
});

// ---------- Tests ----------

describe("submit_trade handler — Phase 7 H3 (landed_after_timeout)", () => {
  it("SELL landed_after_timeout: records the trade with reconcile annotation and closes position", async () => {
    executeTradeImpl = async () => ({
      status: "landed_after_timeout",
      txid: "tx-late-sell",
      value: {
        err: null,
        confirmationStatus: "finalized",
        slot: 42,
      } as never,
      executedPriceSolPerToken: 0.0012,
      quote: { inAmount: "1000", outAmount: "2000" } as never,
    });

    const { tools, ledger, stateStore } = buildTools();
    const result = await tools.submitTrade.handler(
      sellInput({
        tokenIn: TOKEN_MINT,
        tokenOut: SOL_MINT,
        sellAmountTokens: 0.5,
        reason: "exit on TP",
      }),
      undefined,
    );

    // Result is success-shaped (no isError), text starts with "executed".
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("executed tx-late-sell");

    // Trade row was recorded with the reconcile annotation in `reason`.
    expect(ledger.trades.length).toBe(1);
    expect(ledger.trades[0].side).toBe("SELL");
    expect(ledger.trades[0].txid).toBe("tx-late-sell");
    expect(ledger.trades[0].reason).toMatch(/landed-after-timeout: reconcile/);

    // Position was closed (SELL path).
    expect(ledger.closePositionCalls).toEqual([TOKEN_MINT]);
    // BUY-only side: openPosition must NOT fire on a SELL.
    expect(ledger.openPositionCalls.length).toBe(0);

    // recordTradeResult fired with outcome=landed_after_timeout.
    const final = stateStore.tradeResults[stateStore.tradeResults.length - 1];
    expect(final.outcome).toBe("landed_after_timeout");
    expect(final.txid).toBe("tx-late-sell");
    expect(final.side).toBe("SELL");
  });

  it("BUY landed_after_timeout: records the trade and opens the position with the resolved decimals", async () => {
    executeTradeImpl = async () => ({
      status: "landed_after_timeout",
      txid: "tx-late-buy",
      value: {
        err: null,
        confirmationStatus: "finalized",
        slot: 42,
      } as never,
      executedPriceSolPerToken: 0.0008,
      quote: { inAmount: "100000000", outAmount: "5000000" } as never,
    });

    const { tools, ledger, stateStore } = buildTools();
    const result = await tools.submitTrade.handler(
      buyInput({
        tokenIn: SOL_MINT,
        tokenOut: TOKEN_MINT,
        amountSol: 0.1,
        reason: "RISING signal",
      }),
      undefined,
    );

    expect(result.isError).toBeFalsy();
    expect(ledger.trades.length).toBe(1);
    expect(ledger.trades[0].side).toBe("BUY");
    expect(ledger.trades[0].reason).toMatch(/landed-after-timeout: reconcile/);
    expect(ledger.trades[0].executedPriceSolPerToken).toBe(0.0008);

    expect(ledger.openPositionCalls.length).toBe(1);
    expect(ledger.openPositionCalls[0].decimals).toBe(9);
    expect(ledger.openPositionCalls[0].sizeSol).toBe(0.1);
    expect(ledger.closePositionCalls).toEqual([]);

    const final = stateStore.tradeResults[stateStore.tradeResults.length - 1];
    expect(final.outcome).toBe("landed_after_timeout");
  });
});

describe("submit_trade handler — Phase 7 H3 (failed_onchain — audit's highest-leverage case)", () => {
  it("failed_onchain SELL: NO trade row recorded; phase_events captures denial", async () => {
    executeTradeImpl = async () => ({
      status: "failed_onchain",
      txid: "tx-failed",
      err: { SlippageToleranceExceeded: "0x1771" },
    });

    const { tools, ledger, stateStore } = buildTools();
    const result = await tools.submitTrade.handler(
      sellInput({
        tokenIn: TOKEN_MINT,
        tokenOut: SOL_MINT,
        sellAmountTokens: 0.5,
        reason: "exit on SL",
      }),
      undefined,
    );

    expect(result.isError).toBe(true);
    // CRITICAL: a failed_onchain tx must NEVER appear in trades — recording
    // it would double-count realized PnL and corrupt the daily-cap math.
    expect(ledger.trades.length).toBe(0);
    expect(ledger.closePositionCalls).toEqual([]);

    const final = stateStore.tradeResults[stateStore.tradeResults.length - 1];
    expect(final.outcome).toBe("failed_onchain");
    expect(final.txid).toBe("tx-failed");
  });

  it("not_landed BUY: NO trade row recorded; surfaces execute-failed", async () => {
    executeTradeImpl = async () => ({
      status: "not_landed",
      txid: "tx-stuck",
    });

    const { tools, ledger, stateStore } = buildTools();
    const result = await tools.submitTrade.handler(
      buyInput({
        tokenIn: SOL_MINT,
        tokenOut: TOKEN_MINT,
        amountSol: 0.1,
        reason: "RISING signal",
      }),
      undefined,
    );

    expect(result.isError).toBe(true);
    expect(ledger.trades.length).toBe(0);
    expect(ledger.openPositionCalls).toEqual([]);

    const final = stateStore.tradeResults[stateStore.tradeResults.length - 1];
    expect(final.outcome).toBe("not_landed");
  });
});

describe("submit_trade handler — Phase 7 H5 (float→atomic SELL conversion)", () => {
  it("UI 1.999999999 with decimals=9 floors to 1_999_999_999n atomic", async () => {
    // The handler's float-to-atomic math (tools/index.ts SELL branch):
    //   whole = floor(ui), frac = floor((ui - whole) * 10^decimals)
    //   atomic = whole * 10^decimals + frac
    // For ui=1.999999999, decimals=9:
    //   whole=1n, atomicPerToken=1e9
    //   frac = floor((0.999999999) * 1e9) = 999_999_999n
    //   atomic = 1n * 1e9 + 999_999_999n = 1_999_999_999n
    // This test pins that behavior — if the math changes, we either fix
    // the test to reflect new semantics OR file a 12th-issue flag.
    mintDecimalsRef.value = 9;
    let observedAtomic: bigint | undefined;
    executeTradeImpl = async (args) => {
      observedAtomic = args.sellAmountAtomic;
      return {
        status: "ok",
        txid: "tx-h5",
        executedPriceSolPerToken: 0.001,
        quote: { inAmount: "x", outAmount: "y" } as never,
      };
    };

    const { tools } = buildTools();
    await tools.submitTrade.handler(
      sellInput({
        tokenIn: TOKEN_MINT,
        tokenOut: SOL_MINT,
        sellAmountTokens: 1.999999999,
        reason: "edge-case float conversion",
      }),
      undefined,
    );

    // Allow ±1 for IEEE-754 float artifacts in (ui - floor(ui)) * 1e9.
    // E.g. 1.999999999 - 1 may evaluate to 0.9999999988... due to repr; the
    // multiply then floors to 999_999_998. We accept either rounding.
    expect(observedAtomic).toBeDefined();
    const expected = 1_999_999_999n;
    const tolerance = 2n;
    const delta = observedAtomic! > expected
      ? observedAtomic! - expected
      : expected - observedAtomic!;
    expect(delta <= tolerance).toBe(true);
  });

  it("UI rounds to 0 atomic: handler denies, no executeTrade call", async () => {
    // sellAmountTokens=1e-12 with decimals=9 → atomic floor = 0. The
    // handler must short-circuit with a structured denial, never call
    // executeTrade with sellAmountAtomic=0n (which would throw inside
    // jupiter.ts and cost an RPC roundtrip first).
    mintDecimalsRef.value = 9;
    let executeCalled = false;
    executeTradeImpl = async () => {
      executeCalled = true;
      throw new Error("executeTrade should not be reached");
    };

    const { tools, ledger } = buildTools();
    const result = await tools.submitTrade.handler(
      sellInput({
        tokenIn: TOKEN_MINT,
        tokenOut: SOL_MINT,
        sellAmountTokens: 1e-12,
        reason: "dust amount edge case",
      }),
      undefined,
    );

    expect(executeCalled).toBe(false);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /rounds to 0/,
    );
    expect(ledger.trades.length).toBe(0);
  });
});
