/**
 * Trade policy — single source of truth (Phase 4).
 *
 * Caps from BRIEF-pepe-hq.md (canon, lines 201-228 of the brief):
 *   - per-trade ≤ 0.25 SOL
 *   - daily total ≤ 2.0 SOL
 *   - cooldown ≥ 30s since last trade
 *   - ≤ 5 open positions
 *   - default slippage 100bps, hard ceiling 300bps
 *   - kill switch tripped ⇒ deny
 *   - no wallet configured ⇒ deny (cannot sign)
 *
 * Called from THREE sites (defense in depth):
 *   1. PreToolUse hook       (worker/src/agent/hooks.ts)
 *   2. canUseTool gate       (worker/src/agent/loop.ts)
 *   3. submit_trade handler  (worker/src/agent/tools/index.ts)
 */
import type { TradeLedger } from "./ledger.ts";

/**
 * A normalized trade intent passed to checkTradePolicy.
 *
 * Field semantics by side (Phase 5 — side-aware policy):
 *   BUY:  tokenIn = SOL_MINT (or "SOL"), tokenOut = mint being bought,
 *         amountSol = SOL spent (positive).
 *   SELL: tokenIn = mint being sold, tokenOut = SOL_MINT (or "SOL"),
 *         amountSol = 0 (a SELL produces SOL; it doesn't consume it). The
 *         per-trade SOL cap and daily BUY cap don't apply on SELL.
 *
 * Adding `side` removes the structural lie from the old shape, where SELL
 * call-sites had to fake amountSol=0 and reverse in/out without anything in
 * the type telling the policy which direction this trade goes.
 */
export type TradeIntent = {
  side: "BUY" | "SELL";
  tokenIn: string;
  tokenOut: string;
  amountSol: number;
  slippageBps: number;
  reason: string;
};

export type PolicyResult = { allow: true } | { allow: false; reason: string };

export const PER_TRADE_MAX_SOL = 0.25;
export const DAILY_MAX_SOL = 2.0;
export const COOLDOWN_MS = 30_000;
export const MAX_OPEN_POSITIONS = 5;
export const DEFAULT_SLIPPAGE_BPS = 100;
export const SLIPPAGE_HARD_CAP_BPS = 300;

// BRIEF §7.2 entry gates — single source of truth. Imported by auto-tick.ts
// so the agent only sees candidates that meet our thesis bar.
export const MIN_FIVE_MIN_GAIN = 0.15;
export const MIN_BUY_PRESSURE_5M = 0.7;
export const MIN_LIQUIDITY_USD = 50_000;
export const MIN_UPDATES_PER_MINUTE = 20;

// BRIEF §7.4 + §10 — when wallet drops below this, narrate "TANK EMPTY".
export const TANK_EMPTY_THRESHOLD_SOL = 0.05;

export interface PolicyContext {
  ledger: TradeLedger;
  killSwitchTripped: () => boolean;
  walletAvailable: boolean;
  now: () => number;
  /**
   * Wallet SOL balance accessor. Optional with `() => Infinity` default so
   * existing call-sites and tests keep working. When provided, gates
   * trades on the BRIEF §7.4 TANK-EMPTY threshold.
   */
  walletSolBalance?: () => number;
}

export function checkTradePolicy(
  intent: TradeIntent,
  ctx: PolicyContext
): PolicyResult {
  if (ctx.killSwitchTripped()) {
    return { allow: false, reason: "kill switch tripped" };
  }
  if (!ctx.walletAvailable) {
    return {
      allow: false,
      reason: "no wallet configured (set AGENT_WALLET_PRIVATE_KEY_BASE58)",
    };
  }
  // TANK-EMPTY gates BUYs only. SELLs are emergency exits — the whole
  // point of selling at low SOL is to recover SOL. Audit finding #4
  // (PLAN-real-go-live.md Phase 5).
  const walletSolBalance = ctx.walletSolBalance ?? (() => Infinity);
  if (intent.side === "BUY" && walletSolBalance() < TANK_EMPTY_THRESHOLD_SOL) {
    return {
      allow: false,
      reason: `TANK EMPTY (wallet < ${TANK_EMPTY_THRESHOLD_SOL} SOL)`,
    };
  }
  // amountSol / per-trade cap apply to BUYs only. SELL doesn't consume SOL
  // (it produces it), and the position size was already capped at entry,
  // so a SELL is not bounded by PER_TRADE_MAX_SOL. amountSol on a SELL
  // intent is 0 by convention; we don't reject it.
  if (intent.side === "BUY") {
    if (!Number.isFinite(intent.amountSol) || intent.amountSol <= 0) {
      return { allow: false, reason: "amountSol must be > 0" };
    }
    if (intent.amountSol > PER_TRADE_MAX_SOL) {
      return {
        allow: false,
        reason: `per-trade cap ${PER_TRADE_MAX_SOL} SOL exceeded (got ${intent.amountSol})`,
      };
    }
  }
  if (intent.slippageBps > SLIPPAGE_HARD_CAP_BPS) {
    return {
      allow: false,
      reason: `slippage ${intent.slippageBps}bps over cap ${SLIPPAGE_HARD_CAP_BPS}bps`,
    };
  }

  const last = ctx.ledger.lastTradeMs();
  if (last !== null) {
    const elapsed = ctx.now() - last;
    if (elapsed < COOLDOWN_MS) {
      const remainingSec = Math.max(
        1,
        Math.round((COOLDOWN_MS - elapsed) / 1000)
      );
      return {
        allow: false,
        reason: `cooldown active (${remainingSec}s remaining)`,
      };
    }
  }

  // Daily cap is a *capital-deployment* cap, not a churn cap. It must count
  // BUY SOL only — netting SELLs in would let a wash-trade pattern (sell $X,
  // buy $X) understate daily exposure and slip past the cap. SELLs are
  // unbounded by the daily cap; their notional was bounded at entry.
  if (intent.side === "BUY") {
    const todayBuyTotal = ctx.ledger.dailyBuySolToday();
    if (todayBuyTotal + intent.amountSol > DAILY_MAX_SOL) {
      return {
        allow: false,
        reason: `daily cap ${DAILY_MAX_SOL} SOL would be exceeded (today=${todayBuyTotal.toFixed(
          3
        )}, new=${intent.amountSol})`,
      };
    }
  }

  if (ctx.ledger.openPositions().length >= MAX_OPEN_POSITIONS) {
    return {
      allow: false,
      reason: `max open positions (${MAX_OPEN_POSITIONS}) reached`,
    };
  }

  return { allow: true };
}
