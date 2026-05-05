/**
 * Trade-policy stub for Phase 3.
 *
 * This module intentionally always denies. Phase 4 replaces it with the real
 * `worker/src/trade/policy.ts` that enforces:
 *   - per-trade ≤ 0.25 SOL
 *   - daily ≤ 2.0 SOL
 *   - cooldown ≥ 30s
 *   - max 5 open positions
 *   - slippageBps cap = 300
 *
 * Same signature as the eventual real policy so swap-in is mechanical.
 * Called from BOTH the PreToolUse hook AND the canUseTool gate AND the
 * submit_trade handler — defense in depth.
 */
export type TradeIntent = {
  tokenIn: string;
  tokenOut: string;
  amountSol: number;
  slippageBps: number;
  reason: string;
};

export type PolicyResult = { allow: true } | { allow: false; reason: string };

export function checkTradePolicy(_intent: TradeIntent): PolicyResult {
  return { allow: false, reason: "trade-policy not yet wired (Phase 4)" };
}
