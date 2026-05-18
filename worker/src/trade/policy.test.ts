/**
 * Trade-policy unit tests.
 *
 * Run with `bun test src/trade/policy.test.ts` from `worker/`.
 *
 * Uses an in-memory fake ledger — never touches SQLite. The real ledger is
 * trivially exercised by integration tests (devnet smoke).
 */
import { describe, it, expect } from "bun:test";
import {
  checkTradePolicy,
  checkRouteLiquidity,
  type PolicyContext,
  type TradeIntent,
  PER_TRADE_MAX_SOL,
  DAILY_MAX_SOL,
  COOLDOWN_MS,
  MAX_OPEN_POSITIONS,
  SLIPPAGE_HARD_CAP_BPS,
  TANK_EMPTY_THRESHOLD_SOL,
  ROUTE_LIQUIDITY_MAX_PRICE_IMPACT,
} from "./policy.ts";
import type { TradeLedger } from "./ledger.ts";

interface FakeLedgerState {
  lastTradeMs: number | null;
  totalSolToday: number;
  openPositionsCount: number;
}

function fakeLedger(state: FakeLedgerState): TradeLedger {
  return {
    dbPath: ":memory:",
    recordTrade: () => ({ id: 1 }),
    hasTradeTxid: () => false,
    lastTradeMs: () => state.lastTradeMs,
    // Phase 5: policy reads dailyBuySolToday for the daily cap. The internal
    // fake field is still named `totalSolToday` (test-only convention).
    // Phase 8 (O5): the legacy `totalBuySolToday` ledger method was deleted
    // — zero production callers, identical SQL to dailyBuySolToday. This
    // fake no longer needs to stub the redundant method.
    dailyBuySolToday: () => state.totalSolToday,
    openPositions: () =>
      Array.from({ length: state.openPositionsCount }, (_, i) => ({
        tokenId: `tok${i}`,
        symbol: null,
        entryPriceSolPerToken: 0.001,
        sizeSol: 0.05,
        openedAt: 0,
        decimals: 6,
        // Phase 10 (#1): TradeLedger now exposes the exact uint64 of tokens
        // received at entry. Test fakes return '0' (legacy backfill marker)
        // because the policy tests don't exercise the SELL-sizing path.
        tokensReceivedAtomic: "0",
      })),
    openPosition: () => {},
    setPositionDecimals: () => {},
    setPositionTokensReceived: () => {},
    closePosition: () => {},
    // Phase 7 H4: policy never writes to phase_events, so these are inert
    // for the policy tests. Included to satisfy the TradeLedger interface.
    recordPhaseEvent: () => {},
    recentPhaseEvents: () => [],
    close: () => {},
  };
}

const validIntent: TradeIntent = {
  side: "BUY",
  tokenIn: "SOL",
  tokenOut: "So22222222222222222222222222222222222222222",
  amountSol: 0.05,
  slippageBps: 100,
  reason: "RISING signal + STRONG buy pressure",
};

const validSellIntent: TradeIntent = {
  side: "SELL",
  tokenIn: "So22222222222222222222222222222222222222222",
  tokenOut: "SOL",
  amountSol: 0,
  slippageBps: 100,
  reason: "exit: -10% from entry",
};

function ctx(overrides: Partial<PolicyContext> & { state?: Partial<FakeLedgerState> } = {}): PolicyContext {
  const state: FakeLedgerState = {
    lastTradeMs: null,
    totalSolToday: 0,
    openPositionsCount: 0,
    ...(overrides.state ?? {}),
  };
  return {
    ledger: fakeLedger(state),
    killSwitchTripped: () => false,
    walletAvailable: true,
    now: () => 1_000_000_000,
    // Phase 6: default to a healthy balance so existing BUY tests stay
    // green. Tests that exercise UNKNOWN or TANK_EMPTY behavior override
    // this explicitly. Audit finding #9.
    // Phase 8 (O6): derive the default from TANK_EMPTY_THRESHOLD_SOL so a
    // future tweak to the tank-empty floor doesn't leave this stranded at
    // 1.5 with no apparent connection. 30× threshold = 1.5 SOL = healthy
    // by any reasonable definition.
    walletSolBalance: () => TANK_EMPTY_THRESHOLD_SOL * 30,
    ...overrides,
  };
}

describe("checkTradePolicy", () => {
  it("allows a clean trade", () => {
    const r = checkTradePolicy(validIntent, ctx());
    expect(r.allow).toBe(true);
  });

  it("denies when kill switch is tripped", () => {
    const r = checkTradePolicy(validIntent, ctx({ killSwitchTripped: () => true }));
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/kill switch/);
  });

  it("denies when wallet is not available", () => {
    const r = checkTradePolicy(validIntent, ctx({ walletAvailable: false }));
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/no wallet/);
  });

  it("denies amountSol <= 0", () => {
    const r = checkTradePolicy({ ...validIntent, amountSol: 0 }, ctx());
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/amountSol/);
  });

  it("denies per-trade cap exceeded", () => {
    const r = checkTradePolicy(
      { ...validIntent, amountSol: PER_TRADE_MAX_SOL + 0.01 },
      ctx()
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/per-trade cap/);
  });

  it("allows per-trade cap exactly", () => {
    const r = checkTradePolicy(
      { ...validIntent, amountSol: PER_TRADE_MAX_SOL },
      ctx()
    );
    expect(r.allow).toBe(true);
  });

  it("denies slippage over hard cap", () => {
    const r = checkTradePolicy(
      { ...validIntent, slippageBps: SLIPPAGE_HARD_CAP_BPS + 1 },
      ctx()
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/slippage/);
  });

  it("denies during cooldown", () => {
    const now = 1_000_000_000;
    const r = checkTradePolicy(
      validIntent,
      ctx({
        now: () => now,
        state: { lastTradeMs: now - COOLDOWN_MS + 5_000, totalSolToday: 0, openPositionsCount: 0 },
      })
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/cooldown/);
  });

  it("allows after cooldown", () => {
    const now = 1_000_000_000;
    const r = checkTradePolicy(
      validIntent,
      ctx({
        now: () => now,
        state: { lastTradeMs: now - COOLDOWN_MS - 1, totalSolToday: 0, openPositionsCount: 0 },
      })
    );
    expect(r.allow).toBe(true);
  });

  it("denies when daily cap would be exceeded", () => {
    const r = checkTradePolicy(
      { ...validIntent, amountSol: 0.1 },
      ctx({ state: { lastTradeMs: null, totalSolToday: DAILY_MAX_SOL - 0.05, openPositionsCount: 0 } })
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/daily cap/);
  });

  it("denies when at max open positions", () => {
    const r = checkTradePolicy(
      validIntent,
      ctx({ state: { lastTradeMs: null, totalSolToday: 0, openPositionsCount: MAX_OPEN_POSITIONS } })
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/max open positions/);
  });

  it("allows when below max open positions", () => {
    const r = checkTradePolicy(
      validIntent,
      ctx({ state: { lastTradeMs: null, totalSolToday: 0, openPositionsCount: MAX_OPEN_POSITIONS - 1 } })
    );
    expect(r.allow).toBe(true);
  });

  // ─── Phase 5: side-aware policy (BUY vs SELL) ──────────────────────────

  it("BUY: denies at TANK_EMPTY threshold (regression)", () => {
    const r = checkTradePolicy(
      validIntent,
      ctx({ walletSolBalance: () => TANK_EMPTY_THRESHOLD_SOL - 0.001 })
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/TANK EMPTY/);
  });

  it("SELL: allows at TANK_EMPTY threshold (emergency exit)", () => {
    // The whole point of selling at low SOL is to recover SOL.
    const r = checkTradePolicy(
      validSellIntent,
      ctx({ walletSolBalance: () => TANK_EMPTY_THRESHOLD_SOL - 0.001 })
    );
    expect(r.allow).toBe(true);
  });

  it("BUY: denies when daily BUY cap would be exceeded (regression)", () => {
    const r = checkTradePolicy(
      { ...validIntent, amountSol: 0.1 },
      ctx({ state: { lastTradeMs: null, totalSolToday: DAILY_MAX_SOL - 0.05, openPositionsCount: 0 } })
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/daily cap/);
  });

  it("SELL: allows even when daily BUY cap is hit", () => {
    // SELLs don't count against the BUY cap because the daily cap measures
    // *capital deployed*, not churn.
    const r = checkTradePolicy(
      validSellIntent,
      ctx({ state: { lastTradeMs: null, totalSolToday: DAILY_MAX_SOL + 5, openPositionsCount: 0 } })
    );
    expect(r.allow).toBe(true);
  });

  it("SELL: not bounded by PER_TRADE_MAX_SOL even though amountSol is 0", () => {
    // amountSol=0 on a SELL would otherwise hit the "amountSol must be > 0"
    // gate. The side-aware check skips it for SELL.
    const r = checkTradePolicy(validSellIntent, ctx());
    expect(r.allow).toBe(true);
  });

  it("SELL: still denied if kill switch tripped", () => {
    const r = checkTradePolicy(validSellIntent, ctx({ killSwitchTripped: () => true }));
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/kill switch/);
  });

  it("SELL: still denied if no wallet configured", () => {
    const r = checkTradePolicy(validSellIntent, ctx({ walletAvailable: false }));
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/no wallet/);
  });

  it("SELL: allowed during cooldown — emergency exits bypass cooldown gate (Phase 10)", () => {
    // Phase 10 (codex re-audit #13): cooldown is a BUY-only rate-limit. A
    // SELL is an emergency exit; throttling it would mean a TP/SL/RUG signal
    // gets stuck behind 30s of dead air while the position bleeds. Mirrors
    // the TANK_EMPTY / per-trade / daily-cap pattern: BUYs are gated, SELLs
    // are always allowed when the trade is structurally valid.
    const now = 1_000_000_000;
    const r = checkTradePolicy(
      validSellIntent,
      ctx({
        now: () => now,
        state: { lastTradeMs: now - COOLDOWN_MS + 5_000, totalSolToday: 0, openPositionsCount: 0 },
      })
    );
    expect(r.allow).toBe(true);
  });

  it("BUY: still denied during cooldown (regression — preserve existing rate-limit)", () => {
    // Companion to the SELL-during-cooldown test above: the BUY cooldown
    // gate must keep firing. Adding the BUY-only guard to the cooldown
    // section must NOT relax the existing per-buy rate-limit.
    const now = 1_000_000_000;
    const r = checkTradePolicy(
      validIntent,
      ctx({
        now: () => now,
        state: { lastTradeMs: now - COOLDOWN_MS + 5_000, totalSolToday: 0, openPositionsCount: 0 },
      })
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/cooldown/);
  });

  it("SELL: still denied if slippage over hard cap", () => {
    const r = checkTradePolicy(
      { ...validSellIntent, slippageBps: SLIPPAGE_HARD_CAP_BPS + 1 },
      ctx()
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/slippage/);
  });

  // ─── Phase 11: max-open-positions is BUY-only (codex re-audit) ─────────
  // Pre-Phase-11: gate denied BOTH BUY and SELL at MAX_OPEN_POSITIONS.
  // That deadlocked emergency exits — when you're at cap you can never sell
  // *because* you have positions to sell. Mirrors the TANK_EMPTY / cooldown
  // pattern: BUYs are gated, SELLs always allowed when otherwise valid.

  it("BUY: still denied at MAX_OPEN_POSITIONS (regression)", () => {
    const r = checkTradePolicy(
      validIntent,
      ctx({
        state: {
          lastTradeMs: null,
          totalSolToday: 0,
          openPositionsCount: MAX_OPEN_POSITIONS,
        },
      })
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/max open positions/);
  });

  it("SELL: allowed at MAX_OPEN_POSITIONS — emergency exit must bypass position cap", () => {
    // Phase 11: a SELL at the position cap is exactly the case the cap
    // exists to enable — exiting one of the open positions. Throttling
    // here would deadlock the loop. Hard regression test.
    const r = checkTradePolicy(
      validSellIntent,
      ctx({
        state: {
          lastTradeMs: null,
          totalSolToday: 0,
          openPositionsCount: MAX_OPEN_POSITIONS,
        },
      })
    );
    expect(r.allow).toBe(true);
  });

  // ─── Phase 6: UNKNOWN balance state (audit finding #9) ─────────────────
  // The accessor returns `number | null`. `null` means RPC failed or the
  // poll never succeeded. UNKNOWN must deny BUYs (never fail open) but
  // allow SELLs (you must be able to exit when RPC is flaky).

  it("BUY: denies when wallet balance is UNKNOWN (null)", () => {
    const r = checkTradePolicy(
      validIntent,
      ctx({ walletSolBalance: () => null })
    );
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/UNKNOWN/);
  });

  it("SELL: allows even when wallet balance is UNKNOWN (null)", () => {
    // SELL must succeed even if RPC is down — emergency exit takes priority.
    const r = checkTradePolicy(
      validSellIntent,
      ctx({ walletSolBalance: () => null })
    );
    expect(r.allow).toBe(true);
  });

  it("BUY: denies when walletSolBalance accessor is missing from context (in-policy default null)", () => {
    // Hand-build a context with NO walletSolBalance to verify the policy's
    // own `?? (() => null)` fallback denies BUY (never fail open). This is
    // the direct regression test for audit finding #9: the old default was
    // `() => Infinity`, which would have allowed this trade.
    const r = checkTradePolicy(validIntent, {
      ledger: ctx().ledger,
      killSwitchTripped: () => false,
      walletAvailable: true,
      now: () => 1_000_000_000,
      // walletSolBalance INTENTIONALLY omitted — exercises the in-policy default.
    });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/UNKNOWN/);
  });

  it("SELL: allowed when walletSolBalance accessor is missing from context", () => {
    const r = checkTradePolicy(validSellIntent, {
      ledger: ctx().ledger,
      killSwitchTripped: () => false,
      walletAvailable: true,
      now: () => 1_000_000_000,
    });
    expect(r.allow).toBe(true);
  });

  it("BUY: allowed at healthy SOL balance (regression)", () => {
    const r = checkTradePolicy(
      validIntent,
      ctx({ walletSolBalance: () => 1.5 })
    );
    expect(r.allow).toBe(true);
  });

  it("SELL: allowed at healthy SOL balance (regression)", () => {
    const r = checkTradePolicy(
      validSellIntent,
      ctx({ walletSolBalance: () => 1.5 })
    );
    expect(r.allow).toBe(true);
  });
});

// ─── Phase 11 (codex Phase 10 re-audit #3): route-liquidity gate ─────────
// checkRouteLiquidity runs at the trade boundary in tools/index.ts to put
// the auto-tick prefilter floor back when /chat steers a trade attempt at
// an arbitrary mint. Pure function — no context, just the quote shape.

describe("checkRouteLiquidity", () => {
  it("allows a healthy quote with a route and low price impact", () => {
    const r = checkRouteLiquidity({
      routePlan: [{ swapInfo: { ammKey: "RaydiumXxX" } }],
      priceImpactPct: "0.01",
    });
    expect(r.allow).toBe(true);
  });

  it("denies a quote with empty routePlan", () => {
    // Jupiter found no route — submitting would either revert on-chain or
    // burn lamports for nothing. Hard deny regardless of priceImpactPct.
    const r = checkRouteLiquidity({
      routePlan: [],
      priceImpactPct: "0.0",
    });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/route/i);
  });

  it("denies a quote with priceImpactPct above the hard ceiling", () => {
    // Above 50% the pool is illiquid enough that executed price drifts wildly
    // from quoted price — no BUY/SELL outcome is worth that.
    const r = checkRouteLiquidity({
      routePlan: [{}],
      priceImpactPct: String(ROUTE_LIQUIDITY_MAX_PRICE_IMPACT + 0.01),
    });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/priceImpactPct/);
  });

  it("allows a quote exactly at the hard ceiling (boundary)", () => {
    // Strict `>` so exactly-50% is allowed. The position-monitor's softer
    // 10% threshold is informational; the 50% ceiling is the structural
    // deny line, and the boundary case should pass.
    const r = checkRouteLiquidity({
      routePlan: [{}],
      priceImpactPct: String(ROUTE_LIQUIDITY_MAX_PRICE_IMPACT),
    });
    expect(r.allow).toBe(true);
  });

  it("denies a quote with non-numeric priceImpactPct", () => {
    // Defensive: if Jupiter returns something we can't parse, refuse the
    // trade rather than accept an unknown. Better one failed trade than a
    // silent slippage event.
    const r = checkRouteLiquidity({
      routePlan: [{}],
      priceImpactPct: "not-a-number",
    });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/priceImpactPct/);
  });
});
