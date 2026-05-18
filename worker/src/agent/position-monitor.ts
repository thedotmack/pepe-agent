/**
 * Position monitor — TP/SL/rug exit signaller (Phase 3).
 *
 * Polls Jupiter every `POLL_MS` for each open position. When the price
 * crosses a BRIEF §7.2 exit threshold (TP +30% / SL -15% / RUG -50% in one
 * tick), pushes a user-message into the agent loop telling it to submit a
 * sell. We do NOT auto-execute exits — the agent narrates and calls
 * submit_trade so the decision lives in the transcript + memory.
 *
 * CAVEAT — Jupiter execution is BUY-only today:
 *   `worker/src/trade/jupiter.ts:executeTrade()` throws when `inputMint !==
 *   SOL_MINT`. That means an exit prompt from this monitor that triggers
 *   submit_trade(tokenIn=<mint>, tokenOut=SOL) will fail in the handler
 *   with "executeTrade currently only supports SOL→TOKEN; SELL path lands
 *   in Phase 5". The position stays open and the error surfaces to the
 *   agent. SELL wiring is intentionally out of scope for this phase.
 *
 * Refs:
 *   - worker/src/trade/ledger.ts: openPositions() shape (uses
 *     `entryPriceSolPerToken`, `tokenId`, `symbol`, `sizeSol`).
 *   - worker/src/trade/jupiter.ts: getQuote() signature.
 *   - BRIEF §7.2 exit rules.
 */
import type { TradeLedger } from "../trade/ledger.ts";
import type { AgentLoopHandle } from "./loop.ts";
import type { StateStore } from "../state.ts";
import { getQuote } from "../trade/jupiter.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("agent.position-monitor");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const POLL_MS = 10_000;
const TP_GAIN = 0.30;
const SL_LOSS = -0.15;
const RUG_TICK = -0.50;

// Quote amount in atomic units of the token-in. We don't know token
// decimals here, so we use a flat 1e6 atomic units. That's "enough sample"
// for a price estimate — the resulting per-atomic-unit price is what we
// compare against `entryPriceSolPerToken`.
const QUOTE_TOKEN_AMOUNT_ATOMIC = "1000000";

interface PriceMemo {
  price: number;
  ts: number;
}

export interface CreatePositionMonitorArgs {
  ledger: TradeLedger;
  agent: AgentLoopHandle;
  stateStore: StateStore;
  /** Default 10_000ms. */
  pollMs?: number;
}

export interface PositionMonitorHandle {
  stop: () => void;
}

export function startPositionMonitor(
  args: CreatePositionMonitorArgs,
): PositionMonitorHandle {
  const pollMs = args.pollMs ?? POLL_MS;
  const lastPrice = new Map<string, PriceMemo>();
  let stopped = false;
  let running = false;

  const interval = setInterval(async () => {
    if (stopped) return;
    if (running) return; // re-entrancy guard if Jupiter is slow
    const positions = args.ledger.openPositions();
    if (positions.length === 0) return;
    const phase = args.stateStore.snapshot().phase;
    if (phase === "TRADING" || phase === "CALLING") return;

    running = true;
    try {
      for (const pos of positions) {
        try {
          // Quote QUOTE_TOKEN_AMOUNT_ATOMIC atomic units of the position
          // token into SOL. `outAmount` returns lamports (1e9 lamports/SOL).
          // Price = lamports_out / 1e9 / amount_in_atomic, giving SOL per
          // atomic-token unit — comparable to `entryPriceSolPerToken`.
          const q = await getQuote({
            inputMint: pos.tokenId,
            outputMint: SOL_MINT,
            amount: QUOTE_TOKEN_AMOUNT_ATOMIC,
            slippageBps: 100,
          });
          const lamportsOut = Number(q.outAmount);
          if (!Number.isFinite(lamportsOut) || lamportsOut <= 0) continue;
          const currentPriceSol =
            lamportsOut / 1e9 / Number(QUOTE_TOKEN_AMOUNT_ATOMIC);

          const entry = pos.entryPriceSolPerToken;
          if (!entry || entry <= 0) continue;
          const pnl = (currentPriceSol - entry) / entry;

          const prev = lastPrice.get(pos.tokenId);
          const tickDrop = prev ? (currentPriceSol - prev.price) / prev.price : 0;
          lastPrice.set(pos.tokenId, { price: currentPriceSol, ts: Date.now() });

          const sym = pos.symbol ?? pos.tokenId.slice(0, 6);
          let reason: string | null = null;
          if (tickDrop <= RUG_TICK) {
            reason = `RUG — price dropped ${(tickDrop * 100).toFixed(0)}% in one tick. OUT.`;
          } else if (pnl >= TP_GAIN) {
            reason = `TP — +${(pnl * 100).toFixed(0)}%. Taking profit on $${sym}.`;
          } else if (pnl <= SL_LOSS) {
            reason = `SL — ${(pnl * 100).toFixed(0)}%. Cutting $${sym}.`;
          }

          if (reason) {
            log.info(`exit signal for ${sym} (${pos.tokenId}): ${reason}`);
            args.agent.injectUserMessage(
              `Exit signal: ${reason}\n` +
                `Position: tokenId=${pos.tokenId}, sizeSol=${pos.sizeSol}.\n` +
                `Submit a sell now — use submit_trade with tokenIn=${pos.tokenId}, tokenOut=SOL.\n` +
                `Narrate the exit in one sentence.`,
            );
            // One exit at a time — let the turn resolve before re-evaluating.
            return;
          }
        } catch (err) {
          log.warn(`quote failed for ${pos.tokenId}: ${String(err)}`);
        }
      }
    } finally {
      running = false;
    }
  }, pollMs);
  if (typeof interval.unref === "function") interval.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}
