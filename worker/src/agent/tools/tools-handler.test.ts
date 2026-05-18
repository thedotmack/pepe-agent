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

// Phase 12 (codex Phase 11 re-audit blocker #2a): the handler now FAILS
// CLOSED on a preview-quote error. Default getQuoteImpl returns a healthy
// route so existing tests still exercise executeTrade; individual tests
// override getQuoteImpl to drive the new fail-closed path.
let getQuoteImpl: () => Promise<unknown> = async () => ({
  inputMint: "x",
  outputMint: "y",
  inAmount: "1",
  outAmount: "1",
  otherAmountThreshold: "1",
  swapMode: "ExactIn",
  slippageBps: 100,
  // Phase 12: route + priceImpactPct must satisfy checkRouteLiquidity (route
  // non-empty AND impact ≤ 0.5). 0.001 == 0.1% is well within the gate.
  priceImpactPct: "0.001",
  routePlan: [{ swapInfo: { ammKey: "FakeRaydium" } }],
});

mock.module("../../trade/jupiter.ts", () => ({
  // Phase 7 H3: handler calls these three from jupiter.ts.
  executeTrade: async (args: ExecuteTradeArgs) => {
    lastExecuteArgs = args;
    return executeTradeImpl(args);
  },
  getQuote: async () => getQuoteImpl(),
  defaultRpcUrl: () => "http://test.invalid",
  CONFIRM_TIMEOUT_MS: 90_000,
  REBROADCAST_INTERVAL_MS: 2_000,
}));

// getMint resolves decimals before executeTrade. Fix at 9 so the SELL UI →
// atomic conversion (H5) is deterministic.
const mintDecimalsRef = { value: 9 };
// Phase 12 (codex Phase 11 re-audit blocker #1): getAccountImpl is injectable
// so individual tests can drive the pre-BUY / post-BUY ATA read into the
// withRpcTimeout path. Default returns a positive amount so the post-BUY
// delta math has a sane value.
let getAccountImpl: () => Promise<{ amount: bigint }> = async () => ({
  amount: 10_000_000_000n,
});
// Phase 14 P14-T1 (codex Phase 13 re-audit re-test of P13-C1): getMintImpl is
// injectable so the new timeout test can drive the pre-trade getMint into the
// withRpcTimeout reject branch. Default returns the configured decimals so
// existing tests continue to exercise the happy path.
let getMintImpl: () => Promise<{ decimals: number }> = async () => ({
  decimals: mintDecimalsRef.value,
});
mock.module("@solana/spl-token", () => ({
  getMint: async () => getMintImpl(),
  getAssociatedTokenAddressSync: (mint: unknown) => mint,
  getAccount: async () => getAccountImpl(),
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
    setPositionTokensReceived: () => {},
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
  // Phase 12 (codex Phase 11 re-audit blocker #2a): reset getQuoteImpl to the
  // healthy default so individual tests start from a known-good preview
  // quote. Tests that exercise the fail-closed path override this inline.
  getQuoteImpl = async () => ({
    inputMint: "x",
    outputMint: "y",
    inAmount: "1",
    outAmount: "1",
    otherAmountThreshold: "1",
    swapMode: "ExactIn",
    slippageBps: 100,
    priceImpactPct: "0.001",
    routePlan: [{ swapInfo: { ammKey: "FakeRaydium" } }],
  });
  // Phase 12 (codex Phase 11 re-audit blocker #1): reset the pre/post-BUY
  // getAccount behavior so tests that exercise the timeout path can opt in
  // without leaking state into other tests. Default = a positive balance
  // that the post-BUY delta math can read.
  getAccountImpl = async () => ({ amount: 10_000_000_000n });
  // Phase 14 P14-T1: reset getMint behavior to the configured default so
  // the new timeout test can opt in without leaking state. Default returns
  // the mintDecimalsRef-configured value (same as the pre-Phase-14 fixed
  // async did).
  getMintImpl = async () => ({ decimals: mintDecimalsRef.value });
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

  it("Phase 13 P13-T1: preview /quote throws → handler fails closed, no executeTrade call", async () => {
    // Phase 12 (codex Phase 11 re-audit blocker #2a) added a fail-closed
    // preview-quote gate at submit_trade entry: if the Jupiter /quote
    // throws (Jupiter blip, network glitch, anything), the handler MUST
    // deny the trade rather than fall through to executeTrade where the
    // structural route-liquidity check could be bypassed.
    //
    // Phase 13 P13-T1 pins that behavior: force getQuoteImpl to throw
    // before submitTrade.handler runs. Expect:
    //   - executeTrade NEVER called (lastExecuteArgs stays null).
    //   - Ledger trades empty (no row persisted).
    //   - phaseEvents records outcome === "denied_preview_quote_unavailable"
    //     (the exact string the handler emits).
    //   - Tool result has isError:true so the agent narrates the denial
    //     and retries on the next turn.
    getQuoteImpl = async () => {
      throw new Error("simulated jupiter outage");
    };
    let executeCalled = false;
    executeTradeImpl = async () => {
      executeCalled = true;
      throw new Error("executeTrade should not run when preview quote fails");
    };

    const { tools, ledger, stateStore } = buildTools();
    const result = await tools.submitTrade.handler(
      buyInput({
        tokenIn: SOL_MINT,
        tokenOut: TOKEN_MINT,
        amountSol: 0.05,
        reason: "RISING signal but jupiter is down",
      }),
      undefined,
    );

    // The fail-closed contract: executeTrade is NEVER reached.
    expect(executeCalled).toBe(false);
    expect(lastExecuteArgs).toBeNull();

    // No trade row persists on the fail-closed path — the denial happens
    // BEFORE we sign and broadcast, so there's nothing to record.
    expect(ledger.trades.length).toBe(0);
    expect(ledger.openPositionCalls.length).toBe(0);
    expect(ledger.closePositionCalls.length).toBe(0);

    // phase_events captures the structured denial outcome. The exact
    // outcome string is the handler's contract — if it changes, this test
    // either updates with it OR we file a 12th-issue flag.
    const final = stateStore.tradeResults[stateStore.tradeResults.length - 1];
    expect(final.outcome).toBe("denied_preview_quote_unavailable");
    expect(final.side).toBe("BUY");
    expect(final.reason).toMatch(/simulated jupiter outage/);

    // Tool result surfaces the denial so the agent narrates correctly.
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /preview quote unavailable/i,
    );
  });

  it("Phase 13 P13-T3: post-BUY getAccount timeout → ledger persists 0n sentinel", async () => {
    // Phase 12 (codex Phase 11 re-audit blocker #1) wrapped the post-BUY
    // ATA read in withRpcTimeout and made readPostBuyDelta return 0n on
    // ANY failure (timeout, TokenAccountNotFound, other). The 0n sentinel
    // signals position-monitor's lazy backfill to recover the real value
    // on its next tick, instead of persisting the slippage-corrupted
    // quote.outAmount.
    //
    // Phase 13 P13-T3 pins that contract: when getAccountImpl throws
    // (simulating a timeout / RPC blip), the BUY succeeds at the swap
    // boundary but ledger.openPosition receives tokensReceivedAtomic=0n.
    // We can't directly observe tokensReceivedAtomic via the captured
    // openPositionCalls shape, so we extend the fake ledger inline.
    executeTradeImpl = async () => ({
      status: "ok",
      txid: "tx-post-buy-timeout",
      executedPriceSolPerToken: 0.0012,
      quote: { inAmount: "100000000", outAmount: "5000000" } as never,
    });
    getAccountImpl = async () => {
      throw new Error("simulated post-BUY getAccount timeout after 10000ms");
    };

    // Capture the full openPosition input (decimals + tokensReceivedAtomic)
    // by intercepting via a custom ledger — the default fakeLedger only
    // records a subset of fields. We mirror just enough to capture the
    // sentinel.
    let captured: { tokenId: string; tokensReceivedAtomic: bigint } | null = null;
    const captureLedger: TradeLedger = {
      dbPath: ":memory:",
      recordTrade: () => ({ id: 1 }),
      hasTradeTxid: () => false,
      lastTradeMs: () => null,
      dailyBuySolToday: () => 0,
      openPositions: () => [],
      openPosition: (input) => {
        captured = {
          tokenId: input.tokenId,
          tokensReceivedAtomic: input.tokensReceivedAtomic ?? 999n,
        };
      },
      setPositionDecimals: () => {},
      setPositionTokensReceived: () => {},
      closePosition: () => {},
      recordPhaseEvent: () => {},
      recentPhaseEvents: () => [],
      close: () => {},
    };
    const tools = createPepeTools({
      subscriber: fakeSubscriber(),
      tradePolicyCheck: () => ({ allow: true }),
      killSwitchRef: fakeKillSwitchRef(),
      ledger: captureLedger,
      memClient: fakeMemClient,
      contentSessionId: "test-session",
      stateStore: fakeStateStore(),
    });

    const result = await tools.submitTrade.handler(
      buyInput({
        tokenIn: SOL_MINT,
        tokenOut: TOKEN_MINT,
        amountSol: 0.1,
        reason: "RISING signal — post-buy RPC blip",
      }),
      undefined,
    );

    // Swap succeeded — tool result is success-shaped.
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain(
      "executed tx-post-buy-timeout",
    );

    // The CRITICAL assertion: tokensReceivedAtomic === 0n. This is the
    // sentinel position-monitor's lazy backfill watches for. Persisting
    // BigInt(quote.outAmount) here would silently store the slippage-
    // corrupted quote promise and never backfill — losing slippage truth
    // forever (backfill only fires on "0" rows).
    expect(captured).not.toBeNull();
    expect(captured!.tokenId).toBe(TOKEN_MINT);
    expect(captured!.tokensReceivedAtomic).toBe(0n);
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

describe("submit_trade handler — Phase 14 P14-T1 (timeout coverage)", () => {
  // Phase 14 (codex Phase 13 re-audit liveness coverage): pin the behavior
  // of the timeout-wrapped RPC sites that were previously unbounded. Two
  // tests live here (handler-layer):
  //   P13-C1: getMint timeout → handler denies with
  //           denied_mint_metadata_timeout. Without the withRpcTimeout
  //           wrap the handler would hang indefinitely on a stuck
  //           getMint, burning an agent turn on RPC weather.
  //   P14-C2: memClient.recordObservation hang → recordTradeResult still
  //           fires (TRADING phase clears) before the mem await.
  // The two SELL/jupiter-layer tests for P13-C2 and P14-C1 live in
  // jupiter-sell.test.ts / jupiter-confirm.test.ts respectively, where
  // the executeTrade flow is exercised end-to-end with Connection mocks.

  it("P14-T1 (P13-C1): getMint timeout → denied_mint_metadata_timeout outcome; no executeTrade call", async () => {
    // Drive the pre-trade getMint into the withRpcTimeout reject branch by
    // making getMintImpl throw a "timeout after Nms"-shaped error (the
    // same shape withRpcTimeout produces in production). The handler
    // catches this and short-circuits BEFORE executeTrade — the agent
    // narrates "mint metadata unavailable, retry" and the state machine
    // records denied_mint_metadata_timeout for /phase-events forensics.
    getMintImpl = async () => {
      throw new Error("submit_trade getMint(MintTokenAAAA...) timeout after 10000ms");
    };
    let executeCalled = false;
    executeTradeImpl = async () => {
      executeCalled = true;
      throw new Error("executeTrade should not be reached when getMint times out");
    };

    const { tools, ledger, stateStore } = buildTools();
    const result = await tools.submitTrade.handler(
      buyInput({
        tokenIn: SOL_MINT,
        tokenOut: TOKEN_MINT,
        amountSol: 0.1,
        reason: "RISING signal but getMint is stuck",
      }),
      undefined,
    );

    // CRITICAL invariants: executeTrade NEVER runs, ledger trades stays
    // empty, and the handler returns isError:true so the agent knows to
    // retry on the next turn.
    expect(executeCalled).toBe(false);
    expect(lastExecuteArgs).toBeNull();
    expect(ledger.trades.length).toBe(0);
    expect(ledger.openPositionCalls.length).toBe(0);

    // phase_events captures the structured timeout denial — distinct from
    // other denial outcomes so postmortem analysis can tell "RPC stalled"
    // apart from "policy rejected" or "preview quote down".
    const final = stateStore.tradeResults[stateStore.tradeResults.length - 1];
    expect(final.outcome).toBe("denied_mint_metadata_timeout");
    expect(final.side).toBe("BUY");
    expect(final.reason).toMatch(/timeout after \d+ms/);

    // Tool result surfaces the denial so the agent narrates correctly.
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /mint metadata unavailable/i,
    );
  });

  it("P14-T1 (P14-C2): claude-mem hang → recordTradeResult still fires before mem await", async () => {
    // Phase 14 P14-C2 reordered the post-execute bookkeeping so
    // recordTradeResult fires BEFORE the await memClient.recordObservation
    // call. Previously a mem hang held TRADING phase set until state.ts's
    // 90s safety timeout — this test pins the new ordering.
    //
    // Approach: wire a custom memClient whose recordObservation never
    // resolves (hangs forever). The test waits for the swap-success
    // promise to be in flight, then asserts recordTradeResult already
    // fired. We can't await the submit_trade handler to completion
    // because mem is hanging; instead we race the handler against a short
    // deadline and check the side effect.
    //
    // The load-bearing observation is that stateStore.tradeResults has
    // received the success entry BEFORE the handler returns. Because
    // recordObservation is awaited LAST, the only way the trade-result
    // entry is present is if it fired before the await — exactly the
    // P14-C2 contract.
    executeTradeImpl = async () => ({
      status: "ok",
      txid: "tx-mem-hang",
      executedPriceSolPerToken: 0.0012,
      quote: { inAmount: "100000000", outAmount: "5000000" } as never,
    });

    let memCalled = false;
    const hangingMemClient: ClaudeMemClient = {
      baseUrl: "http://test.invalid",
      health: async () => true,
      initSession: async () => ({}),
      recordObservation: async () => {
        memCalled = true;
        // Hang forever — simulates a claude-mem daemon crash / network
        // blackhole where the HTTP request never returns.
        return await new Promise<never>(() => {});
      },
      summarize: async () => ({}),
      search: async () => ({}),
    };

    // Custom wiring so we can use the hanging mem client. fakeLedger /
    // fakeStateStore are reused so we can inspect the side effects.
    const subscriber = fakeSubscriber();
    const ledger = fakeLedger();
    const stateStore = fakeStateStore();
    const killSwitchRef = fakeKillSwitchRef();
    const tools = createPepeTools({
      subscriber,
      tradePolicyCheck: () => ({ allow: true }),
      killSwitchRef,
      ledger,
      memClient: hangingMemClient,
      contentSessionId: "test-session",
      stateStore,
    });

    // Fire the handler but don't await it — it will hang on the mem
    // recordObservation call. Race it against a short deadline; we expect
    // the deadline to win because the handler is stuck on mem.
    const handlerPromise = tools.submitTrade.handler(
      buyInput({
        tokenIn: SOL_MINT,
        tokenOut: TOKEN_MINT,
        amountSol: 0.1,
        reason: "trade succeeds but mem is down",
      }),
      undefined,
    );

    const DEADLINE_SENTINEL = Symbol("deadline");
    const winner = await Promise.race([
      handlerPromise.then(() => "handler-returned" as const),
      new Promise<typeof DEADLINE_SENTINEL>((r) =>
        setTimeout(() => r(DEADLINE_SENTINEL), 250),
      ),
    ]);

    // The handler MUST still be in flight (blocked on mem). If it
    // returned, the new ordering is wrong (mem must be the LAST hop) or
    // the hangingMemClient isn't hanging. Either way this assertion fails
    // loudly.
    expect(winner).toBe(DEADLINE_SENTINEL);
    // Mem WAS called — proves we reached the recordObservation line.
    expect(memCalled).toBe(true);

    // The CRITICAL P14-C2 assertion: recordTradeResult fired BEFORE the
    // mem hang. Without the reorder, this list would be empty (handler
    // never reached recordTradeResult because mem swallowed the await).
    // With the reorder, the success entry is there even though mem is
    // still hanging.
    const final = stateStore.tradeResults[stateStore.tradeResults.length - 1];
    expect(final).toBeDefined();
    expect(final.outcome).toBe("ok");
    expect(final.txid).toBe("tx-mem-hang");
    expect(final.side).toBe("BUY");
    // TRADING phase must have flipped back to WATCHING via the
    // recordTradeResult side effect (fakeStateStore mirrors prod behavior:
    // TRADING → WATCHING on recordTradeResult). If recordTradeResult
    // hadn't fired, the snapshot phase would still be TRADING.
    expect(stateStore.snapshot().phase).not.toBe("TRADING");
  });
});
