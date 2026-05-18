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
  type PolicyContext,
  type TradeIntent,
  PER_TRADE_MAX_SOL,
  DAILY_MAX_SOL,
  COOLDOWN_MS,
  MAX_OPEN_POSITIONS,
  SLIPPAGE_HARD_CAP_BPS,
  TANK_EMPTY_THRESHOLD_SOL,
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
    totalSolToday: () => state.totalSolToday,
    // Phase 5: policy reads dailyBuySolToday for the daily cap. We back it
    // by the same fake field — production reads the same SQL row.
    dailyBuySolToday: () => state.totalSolToday,
    openPositions: () =>
      Array.from({ length: state.openPositionsCount }, (_, i) => ({
        tokenId: `tok${i}`,
        symbol: null,
        entryPriceSolPerToken: 0.001,
        sizeSol: 0.05,
        openedAt: 0,
        decimals: 6,
      })),
    openPosition: () => {},
    setPositionDecimals: () => {},
    closePosition: () => {},
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

  it("SELL: still denied during cooldown", () => {
    const now = 1_000_000_000;
    const r = checkTradePolicy(
      validSellIntent,
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
});
