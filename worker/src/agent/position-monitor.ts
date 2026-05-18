/**
 * Position monitor — TP/SL/rug exit signaller (Phase 3).
 *
 * Polls Jupiter every `POLL_MS` for each open position. When the price
 * crosses a BRIEF §7.2 exit threshold (TP +30% / SL -15% / RUG -50% in one
 * tick), pushes a user-message into the agent loop telling it to submit a
 * sell. We do NOT auto-execute exits — the agent narrates and calls
 * submit_trade so the decision lives in the transcript + memory.
 *
 * SELL path: as of PLAN-real-go-live.md Phase 1, executeTrade supports
 * TOKEN→SOL. The agent receives an exit prompt from this monitor and calls
 * submit_trade with side="SELL", tokenIn=<mint>, tokenOut="SOL",
 * sellAmountTokens=<UI units from get_open_positions>.
 *
 * Phase 3: quote price is computed in SOL-per-UI-token (full tokens, not
 * atomic), matching `entryPriceSolPerToken`'s units. We quote one full
 * token (10^decimals atomic units) into SOL and read `outAmount` lamports.
 *
 * Refs:
 *   - worker/src/trade/ledger.ts: openPositions() shape (uses
 *     `entryPriceSolPerToken`, `tokenId`, `symbol`, `sizeSol`, `decimals`).
 *   - worker/src/trade/jupiter.ts: getQuote() signature.
 *   - BRIEF §7.2 exit rules.
 */
import type { TradeLedger } from "../trade/ledger.ts";
import type { AgentLoopHandle } from "./loop.ts";
import type { StateStore } from "../state.ts";
import { defaultRpcUrl, getQuote } from "../trade/jupiter.ts";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
// citation: @solana/spl-token@0.4 — getMint(connection, mintPk) returns
// MintInfo with `.decimals: number`. getAccount(connection, ata) returns
// `.amount: bigint`. Both used only on legacy-row backfill.
import {
  getMint,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { getPublicKey } from "../trade/wallet.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("agent.position-monitor");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const POLL_MS = 10_000;
const TP_GAIN = 0.30;
const SL_LOSS = -0.15;
const RUG_TICK = -0.50;
/**
 * Phase 11 (codex Phase 10 re-audit #2): hard ceiling around the spl-token
 * RPC calls (getMint, getAccount). Neither has an overall-await timeout —
 * a flaky validator or DNS stall would otherwise wedge the entire
 * setInterval body forever, blocking every other position's tick AND
 * pinning `running = true` so subsequent intervals do nothing. 10s is
 * generous enough for mainnet on a bad day and tight enough that one
 * stalled mint doesn't cost a TP/SL signal across all the others.
 *
 * Same constant as Phase 10's BALANCE_RPC_TIMEOUT_MS in index.ts so an
 * operator only learns one number. On timeout we log + continue to the
 * next position rather than crash the monitor.
 */
const MONITOR_RPC_TIMEOUT_MS = 10_000;

/**
 * Race a promise against a timeout. Mirrors the AbortSignal.timeout pattern
 * in index.ts's BALANCE_RPC_TIMEOUT_MS plumbing — uses the same primitive so
 * the two timeout sites read identically. On timeout: rejects with a
 * descriptive Error so the caller's catch sees a real error message instead
 * of a silent AbortError. Callers log + skip, never crash.
 *
 * Phase 12 (codex Phase 11 re-audit blocker #1): exported so tools/index.ts
 * can wrap the pre-BUY / post-BUY ATA balance reads in the same 10s ceiling.
 * Without an overall-await bound a hung getAccount call would wedge the
 * trade handler AFTER a confirmed swap — Jupiter's wsol unwrap landed, the
 * user's wallet changed, but we never get to recordTrade / openPosition.
 * Same ceiling as position-monitor's own backfill so an operator only learns
 * one number.
 */
export function withRpcTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      const signal = AbortSignal.timeout(MONITOR_RPC_TIMEOUT_MS);
      signal.addEventListener(
        "abort",
        () =>
          reject(
            new Error(`${label} timeout after ${MONITOR_RPC_TIMEOUT_MS}ms`),
          ),
        { once: true },
      );
    }),
  ]);
}
/**
 * Sanity bounds for current/entry price ratio. If the ratio falls outside
 * [1e-4, 1e4] on a tick we treat it as a decimals-misconfig safety net and
 * skip the tick — better to delay an exit by 10s than to emit a fake RUG.
 */
const RATIO_SANITY_MIN = 1e-4;
const RATIO_SANITY_MAX = 1e4;
/**
 * Jupiter quote's priceImpactPct above this threshold means the pool is
 * thin enough that our quote-based price isn't trustworthy as a trading
 * signal. We log a soft ILLIQUID warning but never auto-sell on it — it's
 * informational so the agent can narrate caution.
 */
const ILLIQUID_PRICE_IMPACT = 0.10;

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
          // Phase 3: ensure we have decimals before quoting. Legacy rows
          // pre-decimals-migration default to 9 (SOL-style) — if the value
          // looks wrong (0, NaN, missing), lazy-fetch from chain and persist
          // back so we only pay the RPC once per position.
          let decimals = pos.decimals;
          if (!Number.isFinite(decimals) || decimals <= 0) {
            try {
              const rpc = new Connection(defaultRpcUrl(), "confirmed");
              // Phase 11 (#2): wrap getMint in MONITOR_RPC_TIMEOUT_MS race.
              // spl-token has no overall-await timeout; a hung RPC would
              // wedge the whole monitor tick. On timeout: log + continue
              // to the next position (don't crash the monitor).
              const mintInfo = await withRpcTimeout(
                getMint(rpc, new PublicKey(pos.tokenId)),
                `getMint(${pos.tokenId})`,
              );
              decimals = mintInfo.decimals;
              args.ledger.setPositionDecimals(pos.tokenId, decimals);
              log.info(`backfilled decimals=${decimals} for ${pos.tokenId}`);
            } catch (err) {
              log.warn(`getMint backfill failed for ${pos.tokenId}: ${String(err)}`);
              continue;
            }
          }

          // Phase 10 (#1): legacy rows opened before the
          // tokensReceivedAtomic column have the SQL default '0'. Backfill
          // from the on-chain ATA so the agent sees the real balance the
          // next time it reads get_open_positions. Best-effort — a failure
          // here does NOT skip the tick (price math still works), it just
          // delays the backfill to the next interval.
          if (pos.tokensReceivedAtomic === "0") {
            try {
              const rpc = new Connection(defaultRpcUrl(), "confirmed");
              const ownerPk = new PublicKey(getPublicKey());
              const ata = getAssociatedTokenAddressSync(
                new PublicKey(pos.tokenId),
                ownerPk,
              );
              // Phase 11 (#2): wrap getAccount in MONITOR_RPC_TIMEOUT_MS
              // race. Same rationale as getMint above. Failure here is
              // best-effort backfill — we just leave the row at "0" and
              // try again next tick.
              const acct = await withRpcTimeout(
                getAccount(rpc, ata),
                `getAccount(${pos.tokenId})`,
              );
              args.ledger.setPositionTokensReceived(pos.tokenId, acct.amount);
              log.info(
                `backfilled tokensReceivedAtomic=${acct.amount.toString()} for ${pos.tokenId}`,
              );
            } catch (err) {
              log.warn(
                `tokensReceivedAtomic backfill failed for ${pos.tokenId}: ${String(err)}`,
              );
            }
          }

          // Quote ONE FULL TOKEN (10^decimals atomic units) into SOL.
          // outAmount comes back as lamports. SOL-per-UI-token =
          // outAmount / LAMPORTS_PER_SOL — directly comparable to
          // `entryPriceSolPerToken` which is also SOL-per-UI-token.
          const atomicPerToken = 10n ** BigInt(decimals);
          const q = await getQuote({
            inputMint: pos.tokenId,
            outputMint: SOL_MINT,
            amount: atomicPerToken.toString(),
            slippageBps: 100,
          });
          const lamportsOut = Number(q.outAmount);
          if (!Number.isFinite(lamportsOut) || lamportsOut <= 0) continue;
          const currentPriceSolPerToken = lamportsOut / LAMPORTS_PER_SOL;

          const entry = pos.entryPriceSolPerToken;
          if (!entry || entry <= 0) continue;

          // Decimals misconfig safety net: if our quote price is >1e4× or
          // <1e-4× the entry price, something is wrong (wrong decimals,
          // mint mismatch, illiquid weirdness). Skip this tick rather than
          // emit a phantom RUG/TP/SL signal.
          const ratio = currentPriceSolPerToken / entry;
          if (ratio < RATIO_SANITY_MIN || ratio > RATIO_SANITY_MAX) {
            log.warn(
              `decimals/price sanity skip for ${pos.tokenId}: ratio=${ratio.toExponential(2)} entry=${entry} current=${currentPriceSolPerToken}`,
            );
            continue;
          }

          // Phase 3: priceImpactPct comes back as a string-decimal (e.g.
          // "0.0123" == 1.23%). Above 10% the pool is thin and the quote
          // price isn't a reliable signal — log soft warning, do NOT exit
          // on this alone.
          const priceImpact = parseFloat(q.priceImpactPct ?? "0");
          if (Number.isFinite(priceImpact) && priceImpact > ILLIQUID_PRICE_IMPACT) {
            log.warn(
              `ILLIQUID ${pos.tokenId}: priceImpactPct=${priceImpact.toFixed(4)} (>${ILLIQUID_PRICE_IMPACT}); informational only`,
            );
          }

          const pnl = (currentPriceSolPerToken - entry) / entry;

          const prev = lastPrice.get(pos.tokenId);
          const tickDrop = prev
            ? (currentPriceSolPerToken - prev.price) / prev.price
            : 0;
          lastPrice.set(pos.tokenId, {
            price: currentPriceSolPerToken,
            ts: Date.now(),
          });

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
            // Phase 11 (codex Phase 10 re-audit H1): give the agent the
            // exact sellAmountTokens (UI units) to plug into submit_trade.
            // Pre-Phase-11: prompt referenced sizeSol but not the UI tokens
            // — the agent had to derive them from get_open_positions, and
            // any mismatch with the stored tokensReceivedAtomic produced an
            // insufficient_token_balance or partial-exit bug.
            //
            // We compute UI = atomic / 10^decimals via BigInt math (safe for
            // u64) then format as a decimal string. The agent passes the UI
            // value verbatim into submit_trade; the handler floors back to
            // atomic before sending to Jupiter, so this is exact.
            //
            // Legacy rows with tokensReceivedAtomic="0" (Phase 10 backfill
            // pending) fall back to "<pending-backfill>" so the agent narrates
            // the exit reason but waits for the next monitor tick to provide
            // a real number rather than guessing.
            let sellAmountTokensLabel = "<pending-backfill>";
            try {
              const atomic = BigInt(pos.tokensReceivedAtomic);
              if (atomic > 0n) {
                const denom = 10n ** BigInt(decimals);
                const whole = atomic / denom;
                const frac = atomic % denom;
                if (frac === 0n) {
                  sellAmountTokensLabel = whole.toString();
                } else {
                  // Pad the fractional part to `decimals` digits, then trim
                  // trailing zeros for readability. e.g. 1_999_999_999n with
                  // decimals=9 → "1.999999999"; trailing zeros become "1.5".
                  const fracStr = frac.toString().padStart(decimals, "0");
                  const fracTrimmed = fracStr.replace(/0+$/, "");
                  sellAmountTokensLabel = fracTrimmed.length > 0
                    ? `${whole.toString()}.${fracTrimmed}`
                    : whole.toString();
                }
              }
            } catch {
              // Unparseable tokensReceivedAtomic (shouldn't happen — schema
              // stores stringified bigint). Leave label as pending-backfill.
            }
            args.agent.injectUserMessage(
              `Exit signal for $${sym}: ${reason}\n` +
                `Position: tokenId=${pos.tokenId}, sizeSol=${pos.sizeSol}, decimals=${decimals}, tokensReceivedAtomic=${pos.tokensReceivedAtomic}.\n` +
                `Submit a sell now — use submit_trade with side="SELL", tokenIn=${pos.tokenId}, tokenOut=SOL, sellAmountTokens=${sellAmountTokensLabel}.\n` +
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
