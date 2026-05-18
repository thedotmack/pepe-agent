/**
 * Pepe MCP tool surface (Phase 4).
 *
 * Six custom tools registered via createSdkMcpServer. Phase 4 wires the
 * real Jupiter swap + ledger + trade-policy. submit_trade now actually
 * executes when policy allows.
 *
 * Subscriber, ledger, mem-client, and policy are injected — never imported
 * directly — so tests and replay can pass fakes.
 */
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { ActivitySubscriber, ActivityToken } from "../../activity/subscriber.ts";
import type { TradeIntent, PolicyResult } from "../../trade/policy.ts";
import {
  DEFAULT_SLIPPAGE_BPS,
  SLIPPAGE_HARD_CAP_BPS,
  PER_TRADE_MAX_SOL,
  checkRouteLiquidity,
} from "../../trade/policy.ts";
import type { TradeLedger } from "../../trade/ledger.ts";
import { executeTrade, getQuote as jupGetQuote, defaultRpcUrl } from "../../trade/jupiter.ts";
// spl-token getMint signature: getMint(connection, mintPubkey) → { decimals, ... }.
// Phase 11 (codex Phase 10 re-audit #4): also need getAccount +
// getAssociatedTokenAddressSync + TokenAccountNotFoundError so the BUY flow
// can read the actual on-chain ATA balance post-confirm instead of trusting
// the quote.outAmount promise (which is the QUOTED output, not the
// slippage-adjusted reality).
import {
  getMint,
  getAccount,
  getAssociatedTokenAddressSync,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { getPublicKey } from "../../trade/wallet.ts";
import type { ClaudeMemClient } from "../../memory/claude-mem-client.ts";
import type { StateStore, KillSwitchRef as StateKillSwitchRef } from "../../state.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("agent.tools");

// Re-export under the legacy name so loop.ts (which imports KillSwitchRef
// from this module) keeps working. Phase 4: the shape now exposes
// `signal: AbortSignal` and `trip()` / `reset()`. Tool handler only reads
// `tripped` + `signal` — the trip()/reset() side is server-owned.
export type KillSwitchRef = StateKillSwitchRef;

export interface CreatePepeMcpServerArgs {
  subscriber: ActivitySubscriber;
  tradePolicyCheck: (intent: TradeIntent) => PolicyResult;
  killSwitchRef: KillSwitchRef;
  ledger: TradeLedger;
  memClient: ClaudeMemClient;
  contentSessionId: string;
  stateStore: StateStore;
}

const SignalEnum = z.enum(["STRONG", "RISING", "WATCH", "FLAT"]);

function rankToken(t: ActivityToken): number {
  // Cheap default ranking: 5m gain, then volume.
  const gain = t.fiveMinGain ?? t.threeMinGain ?? t.oneMinGain ?? 0;
  const vol = t.volume24h ?? 0;
  return gain * 1000 + vol / 1_000_000;
}

/**
 * Phase 11 (codex Phase 10 re-audit #4): read the post-BUY ATA balance and
 * return the delta over the pre-BUY balance. This is the EXACT on-chain
 * quantity that landed, after slippage. Falls back to BigInt(quoteOutAmount)
 * if either the post-balance read fails OR the delta is non-positive
 * (defensive — shouldn't happen on an "ok" / "landed_after_timeout" result).
 *
 * Why post-confirm-balance over quote.outAmount:
 *   - quote.outAmount is the QUOTED output (best-case fill).
 *   - actual on-chain fill is up to slippageBps below quoted (default 100bps
 *     ⇒ up to 1% less).
 *   - storing the quote value overstates the position size, causing later
 *     SELL paths to over-request and hit insufficient_token_balance on exit.
 *
 * If even the fallback BigInt parse fails (malformed quote), return 0n so
 * the row stores "0" and position-monitor's lazy backfill recovers from the
 * ATA on the next tick.
 */
async function readPostBuyDelta(
  outputMint: string,
  preBuyBalance: bigint,
  quoteOutAmount: string,
): Promise<bigint> {
  try {
    const rpc = new Connection(defaultRpcUrl(), "confirmed");
    const ownerPk = new PublicKey(getPublicKey());
    const ata = getAssociatedTokenAddressSync(new PublicKey(outputMint), ownerPk);
    const acct = await getAccount(rpc, ata);
    const delta = acct.amount - preBuyBalance;
    if (delta > 0n) return delta;
    // Defensive: a non-positive delta on a confirmed BUY means either
    // (a) we misread the pre-balance (race with another process touching
    // the same ATA — shouldn't happen but isn't impossible), or
    // (b) the tx landed but the swap somehow netted to 0 tokens — also
    // shouldn't happen for an "ok" status. Fall back to the quote so the
    // position row stores a plausible value; backfill from ATA fixes it
    // next monitor tick if reality diverges further.
    log.warn(
      `post-BUY delta non-positive (${delta.toString()}) for ${outputMint}; falling back to quote.outAmount`,
    );
  } catch (err) {
    log.warn(
      `post-BUY balance read failed for ${outputMint} (will fall back to quote.outAmount): ${String(err)}`,
    );
  }
  // Fallback: parse the quote's outAmount. If THAT also fails, return 0n —
  // position-monitor's lazy backfill recovers the real value from the ATA.
  try {
    return BigInt(quoteOutAmount);
  } catch {
    log.warn(
      `quote.outAmount not bigint-parseable: ${String(quoteOutAmount)}; deferring to ATA backfill`,
    );
    return 0n;
  }
}

/**
 * Phase 7 H3: build the raw SdkMcpToolDefinition[] from the same args
 * shape. Exposed so tests can invoke a tool's `.handler(input, undefined)`
 * directly without going through the MCP transport layer. Production
 * boot still wraps these via createSdkMcpServer in createPepeMcpServer
 * below.
 */
export function createPepeTools(args: CreatePepeMcpServerArgs) {
  const {
    subscriber,
    tradePolicyCheck,
    killSwitchRef,
    ledger,
    memClient,
    contentSessionId,
    stateStore,
  } = args;

  const getTopTokens = tool(
    "get_top_tokens",
    "Read the current in-memory activity snapshot from the WSS subscriber. Filtered + ranked. Use this every time you need fresh market state.",
    {
      limit: z.number().int().positive().max(50).default(10),
      signal: SignalEnum.optional(),
    },
    async ({ limit, signal }) => {
      const snapshot = subscriber.getSnapshot();
      const filtered = signal
        ? snapshot.filter((t) => t.signal === signal)
        : snapshot;
      const ranked = [...filtered]
        .sort((a, b) => rankToken(b) - rankToken(a))
        .slice(0, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(ranked) }],
      };
    }
  );

  const getOpenPositions = tool(
    "get_open_positions",
    "Read the open positions ledger.",
    {},
    async () => {
      const positions = ledger.openPositions();
      return {
        content: [{ type: "text", text: JSON.stringify(positions) }],
      };
    }
  );

  const getQuote = tool(
    "get_quote",
    "Fetch a Jupiter quote (read-only). Use to preview pricing + slippage before submitting a trade. Pass `tokenIn`/`tokenOut` as base58 mint addresses (or 'SOL' for native SOL). `amount` is in atomic units of `tokenIn` — for SOL that's lamports.",
    {
      tokenIn: z.string().min(3),
      tokenOut: z.string().min(3),
      amount: z.string(),
      slippageBps: z
        .number()
        .int()
        .min(0)
        .max(SLIPPAGE_HARD_CAP_BPS)
        .default(DEFAULT_SLIPPAGE_BPS),
    },
    async (input) => {
      try {
        const quote = await jupGetQuote({
          inputMint: input.tokenIn,
          outputMint: input.tokenOut,
          amount: input.amount,
          slippageBps: input.slippageBps,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(quote) }],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `quote-failed: ${String(err)}` },
          ],
          isError: true,
        };
      }
    }
  );

  const submitTrade = tool(
    "submit_trade",
    "Sign + submit a swap. `side` defaults to BUY (SOL→token, takes `amountSol`). For SELL pass `side=\"SELL\"`, `tokenIn=<mint>`, `tokenOut=\"SOL\"`, and `sellAmountTokens` in UI units (the exact value from get_open_positions if exiting a known position). Gated by trade-policy + PreToolUse hook + canUseTool. Provide a one-sentence `reason` Pepe can narrate.",
    {
      tokenIn: z.string().min(3),
      tokenOut: z.string().min(3),
      side: z.enum(["BUY", "SELL"]).default("BUY"),
      amountSol: z.number().positive().max(PER_TRADE_MAX_SOL).optional(),
      sellAmountTokens: z.number().positive().optional(),
      slippageBps: z
        .number()
        .int()
        .min(0)
        .max(SLIPPAGE_HARD_CAP_BPS)
        .default(DEFAULT_SLIPPAGE_BPS),
      reason: z.string().min(8),
    },
    async (input) => {
      // Phase 5: flash dot-matrix during the attempt — flip BEFORE policy check.
      stateStore.setPhase("TRADING");

      const side = input.side;

      // Defense-in-depth: even if hook + canUseTool somehow let this through,
      // the handler re-checks the policy.
      if (killSwitchRef.tripped) {
        stateStore.recordDecision({
          ts: Date.now(),
          symbol: "?",
          action: "PASS",
          reason: "kill switch tripped",
        });
        stateStore.recordTradeResult("kill switch tripped", {
          side,
          outcome: "denied_kill_switch",
        });
        return {
          content: [{ type: "text", text: "denied: kill switch is tripped" }],
          isError: true,
        };
      }

      if (side === "BUY" && input.amountSol === undefined) {
        stateStore.recordTradeResult("BUY requires amountSol", {
          side,
          outcome: "denied_missing_amount",
        });
        return {
          content: [{ type: "text", text: "denied: BUY requires amountSol" }],
          isError: true,
        };
      }
      if (side === "SELL" && input.sellAmountTokens === undefined) {
        stateStore.recordTradeResult("SELL requires sellAmountTokens", {
          side,
          outcome: "denied_missing_amount",
        });
        return {
          content: [{ type: "text", text: "denied: SELL requires sellAmountTokens" }],
          isError: true,
        };
      }

      // Phase 5: TradeIntent now carries `side` so checkTradePolicy can
      // apply BUY-only gates (TANK_EMPTY, per-trade cap, daily cap) without
      // a handler-side carve-out. SELL intent has amountSol=0 by convention
      // (a SELL produces SOL; it doesn't consume it) — policy ignores it.
      const intent: TradeIntent = {
        side,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountSol: side === "BUY" ? (input.amountSol as number) : 0,
        slippageBps: input.slippageBps,
        reason: input.reason,
      };
      const decision = tradePolicyCheck(intent);
      if (!decision.allow) {
        stateStore.recordDecision({
          ts: Date.now(),
          symbol: "?",
          action: "PASS",
          reason: decision.reason,
        });
        stateStore.recordTradeResult(`policy: ${decision.reason}`, {
          side,
          outcome: "denied_policy",
        });
        return {
          content: [{ type: "text", text: `denied: ${decision.reason}` }],
          isError: true,
        };
      }

      // Both BUY and SELL need mint decimals: BUY persists them on the
      // position row so position-monitor's price math is unit-correct; SELL
      // converts UI tokens → atomic uint64 for Jupiter. Anti-pattern guard
      // from PLAN-real-go-live.md Phase 1 / Phase 3: never hardcode decimals.
      let sellAmountAtomic: bigint | undefined;
      let mintDecimals: number | undefined;
      try {
        const rpc = new Connection(defaultRpcUrl(), "confirmed");
        // BUY: decimals of tokenOut (the bought token).
        // SELL: decimals of tokenIn (the sold token == position mint).
        const mintForDecimals = side === "BUY" ? input.tokenOut : input.tokenIn;
        const mintInfo = await getMint(rpc, new PublicKey(mintForDecimals));
        mintDecimals = mintInfo.decimals;
      } catch (err) {
        log.error(`getMint failed for ${side} ${input.tokenIn}→${input.tokenOut}: ${String(err)}`);
        stateStore.recordTradeResult(`mint-fetch-failed: ${String(err)}`, {
          side,
          outcome: "mint_fetch_failed",
        });
        return {
          content: [{ type: "text", text: `denied: could not fetch mint info: ${String(err)}` }],
          isError: true,
        };
      }
      if (side === "SELL") {
        const atomicPerToken = 10n ** BigInt(mintDecimals);
        // Floor: don't request more than the user asked, even if float repr
        // would round up.
        const ui = input.sellAmountTokens as number;
        const whole = BigInt(Math.floor(ui));
        const frac = BigInt(Math.floor((ui - Math.floor(ui)) * Number(atomicPerToken)));
        sellAmountAtomic = whole * atomicPerToken + frac;
        if (sellAmountAtomic <= 0n) {
          stateStore.recordTradeResult("SELL amount rounds to 0", {
            side,
            outcome: "denied_zero_amount",
          });
          return {
            content: [{ type: "text", text: "denied: SELL amount rounds to 0 atomic units" }],
            isError: true,
          };
        }
      }

      // Phase 11 (codex Phase 10 re-audit #3): route-liquidity gate.
      // Auto-tick prefilters candidates by liquidity / buy-pressure / 5m gain
      // before suggesting them to the agent, but a /chat-driven trade attempt
      // skips that prefilter entirely — the agent can steer toward any mint.
      // This gate puts the floor back: a preview quote with no route OR a
      // priceImpactPct over the 50% hard ceiling is denied here, regardless
      // of how the agent picked the mint. Denial happens BEFORE we sign and
      // broadcast, so it costs only the Jupiter /quote roundtrip.
      //
      // The trade goes through with a fresh quote inside executeTrade — by
      // the time we get to network the route may differ slightly, but the
      // structural check (route exists + impact bounded) is the same. Race
      // window is small (<100ms typical), and the gate is sufficient to
      // match auto-tick's prefilter intent at the trade boundary.
      try {
        // Mirror executeTrade's amountAtomic computation so the preview quote
        // matches what executeTrade will fetch:
        //   BUY  → SOL atomic units (lamports = round(amountSol * 1e9))
        //   SELL → input-token atomic uint64 (computed above)
        const previewAmount =
          side === "BUY"
            ? BigInt(Math.round((input.amountSol as number) * 1e9)).toString()
            : (sellAmountAtomic as bigint).toString();
        const previewQuote = await jupGetQuote({
          inputMint: input.tokenIn,
          outputMint: input.tokenOut,
          amount: previewAmount,
          slippageBps: input.slippageBps,
        });
        const liquidity = checkRouteLiquidity(previewQuote);
        if (!liquidity.allow) {
          log.warn(
            `submit_trade route-liquidity denied: ${liquidity.reason} for ${input.tokenIn}→${input.tokenOut}`,
          );
          stateStore.recordDecision({
            ts: Date.now(),
            symbol: (side === "BUY" ? input.tokenOut : input.tokenIn).slice(0, 8),
            action: "PASS",
            reason: `route-liquidity: ${liquidity.reason}`,
          });
          stateStore.recordTradeResult(`route-liquidity: ${liquidity.reason}`, {
            side,
            outcome: "denied_route_liquidity",
          });
          return {
            content: [
              { type: "text", text: `denied: ${liquidity.reason}` },
            ],
            isError: true,
          };
        }
      } catch (err) {
        // Preview quote failed — log warn but proceed. executeTrade's own
        // quote fetch will retry and surface a structured error path
        // (no_token_account, insufficient_token_balance, or thrown). Failing
        // closed here would create a false-positive deny when Jupiter is
        // flaky; failing open here means a momentary Jupiter blip doesn't
        // mask a legitimate trade attempt. Trade-off documented for codex.
        log.warn(
          `submit_trade route-liquidity preview quote failed (continuing to executeTrade): ${String(err)}`,
        );
      }

      // Phase 4: tight kill switch check just before send. The PreToolUse
      // hook + canUseTool both check kill switch state at decision time, but
      // a /kill that races between those gates and this line would otherwise
      // slip through. Cheap to re-check; expensive to be wrong.
      if (killSwitchRef.tripped) {
        log.warn("submit_trade aborted pre-send: kill switch tripped mid-trade");
        stateStore.recordDecision({
          ts: Date.now(),
          symbol: (side === "BUY" ? input.tokenOut : input.tokenIn).slice(0, 8),
          action: "PASS",
          reason: "kill switch tripped mid-trade (pre-send)",
        });
        stateStore.recordTradeResult("kill switch tripped mid-trade (pre-send)", {
          side,
          outcome: "denied_kill_switch_mid",
        });
        return {
          content: [{ type: "text", text: "denied: kill switch tripped mid-trade" }],
          isError: true,
        };
      }

      let txid: string;
      let executedPriceSolPerToken: number | null;
      // Phase 11 (codex Phase 10 re-audit #4): track the exact uint64 of
      // non-SOL tokens received on a BUY by reading the on-chain ATA balance
      // delta around the trade, NOT by trusting quote.outAmount.
      // quote.outAmount is the QUOTED output Jupiter promised, which differs
      // from the slippage-adjusted real value that landed on-chain (especially
      // with the 100bps default slippage tolerance — actual fill can be
      // anywhere up to 1% below quoted). Storing the quote value would
      // overstate the position size and cause SELL paths to over-request,
      // hitting insufficient_token_balance on exit.
      //
      // Pre-BUY ATA balance is captured here (may be 0n if the ATA doesn't
      // exist yet — common for a fresh mint, Jupiter creates it during the
      // swap with wrapAndUnwrapSol). Post-BUY balance is read after
      // executeTrade returns "ok" / "landed_after_timeout". Delta is what
      // landed on-chain. SELL path is unaffected — its tokensReceivedAtomic
      // was set at the prior BUY.
      let tokensReceivedAtomic: bigint = 0n;
      let preBuyBalance: bigint = 0n;
      if (side === "BUY") {
        try {
          const rpc = new Connection(defaultRpcUrl(), "confirmed");
          const ownerPk = new PublicKey(getPublicKey());
          const ata = getAssociatedTokenAddressSync(
            new PublicKey(input.tokenOut),
            ownerPk,
          );
          const acct = await getAccount(rpc, ata);
          preBuyBalance = acct.amount;
        } catch (err) {
          // Most common case: ATA doesn't exist yet (Jupiter will create it
          // during the swap). TokenAccountNotFoundError ⇒ pre-balance is 0n,
          // which is the correct value. Other errors get logged but don't
          // abort the trade — we'll fall back to BigInt(quote.outAmount) for
          // tokensReceivedAtomic in the post-branch if post-balance read also
          // fails.
          if (!(err instanceof TokenAccountNotFoundError)) {
            log.warn(
              `pre-BUY balance read failed for ${input.tokenOut} (will fall back to quote.outAmount on success): ${String(err)}`,
            );
          }
        }
      }
      // landedLate is true only on the "landed_after_timeout" path — caller
      // records the trade and closes the position (it did land) but notes
      // the late-landing in the reason for downstream reconciliation.
      let landedLate = false;
      try {
        // Phase 4: thread killSwitchRef.signal as externalSignal so a /kill
        // during the rebroadcast/confirm loop aborts the loop, signAndSend
        // returns not_landed, and we report execute-failed below.
        const result = await executeTrade(
          side === "BUY"
            ? {
                inputMint: input.tokenIn,
                outputMint: input.tokenOut,
                amountSol: input.amountSol as number,
                slippageBps: input.slippageBps,
                decimals: mintDecimals as number,
                externalSignal: killSwitchRef.signal,
              }
            : {
                inputMint: input.tokenIn,
                outputMint: input.tokenOut,
                sellAmountAtomic: sellAmountAtomic as bigint,
                slippageBps: input.slippageBps,
                decimals: mintDecimals as number,
                externalSignal: killSwitchRef.signal,
              },
        );
        switch (result.status) {
          case "ok":
            txid = result.txid;
            executedPriceSolPerToken = result.executedPriceSolPerToken;
            // Phase 11 (codex Phase 10 re-audit #4): read post-confirm ATA
            // balance for the actual delta, NOT quote.outAmount (the quote's
            // PROMISED output, which differs from the slippage-adjusted real
            // fill). Fall back to quote.outAmount only if the ATA read fails
            // — better an approximate value than 0n, and position-monitor's
            // lazy backfill will correct it next tick. SELL path unaffected.
            if (side === "BUY") {
              tokensReceivedAtomic = await readPostBuyDelta(
                input.tokenOut,
                preBuyBalance,
                result.quote.outAmount,
              );
            }
            break;
          case "landed_after_timeout":
            // Tx landed on-chain but confirmTransaction missed it. Record
            // the trade + close the position (the on-chain effect happened)
            // and flag it for human-reviewable reconciliation.
            log.warn(
              `submit_trade landed_after_timeout txid=${result.txid} status=${JSON.stringify(result.value)}`,
            );
            txid = result.txid;
            executedPriceSolPerToken = result.executedPriceSolPerToken;
            // Phase 11 (#4): same as "ok" — the tx did land, so reading the
            // post-confirm ATA delta gives the real on-chain quantity. The
            // tx landed late but the chain effect is real, so the balance
            // read is valid.
            if (side === "BUY") {
              tokensReceivedAtomic = await readPostBuyDelta(
                input.tokenOut,
                preBuyBalance,
                result.quote.outAmount,
              );
            }
            landedLate = true;
            break;
          case "no_token_account": {
            log.warn(`submit_trade no_token_account: ${result.reason}`);
            stateStore.recordDecision({
              ts: Date.now(),
              symbol: input.tokenIn.slice(0, 8),
              action: "PASS",
              reason: `no_token_account: ${result.reason}`,
            });
            stateStore.recordTradeResult(`no_token_account: ${result.reason}`, {
              side,
              outcome: "no_token_account",
            });
            return {
              content: [
                { type: "text", text: `execute-failed: no_token_account: ${result.reason}` },
              ],
              isError: true,
            };
          }
          case "insufficient_token_balance": {
            // Phase 7 H1: distinct from no_token_account. ATA exists but
            // holds less than requested. Surface the exact numbers so the
            // narration is accurate and a future re-attempt can use the
            // available balance.
            log.warn(
              `submit_trade insufficient_token_balance: requested=${result.requested} available=${result.available}`,
            );
            stateStore.recordDecision({
              ts: Date.now(),
              symbol: input.tokenIn.slice(0, 8),
              action: "PASS",
              reason: `insufficient_token_balance: ${result.reason}`,
            });
            stateStore.recordTradeResult(
              `insufficient_token_balance: ${result.reason}`,
              { side, outcome: "insufficient_token_balance" },
            );
            return {
              content: [
                {
                  type: "text",
                  text: `execute-failed: insufficient_token_balance (requested=${result.requested}, available=${result.available})`,
                },
              ],
              isError: true,
            };
          }
          case "failed_onchain": {
            log.warn(
              `submit_trade failed_onchain txid=${result.txid} err=${JSON.stringify(result.err)}`,
            );
            stateStore.recordDecision({
              ts: Date.now(),
              symbol: (side === "BUY" ? input.tokenOut : input.tokenIn).slice(0, 8),
              action: "PASS",
              reason: `failed_onchain ${result.txid}: ${JSON.stringify(result.err)}`,
            });
            stateStore.recordTradeResult(`failed_onchain ${result.txid}`, {
              side,
              txid: result.txid,
              outcome: "failed_onchain",
            });
            return {
              content: [
                {
                  type: "text",
                  text: `execute-failed: tx ${result.txid} failed on-chain (${JSON.stringify(result.err)})`,
                },
              ],
              isError: true,
            };
          }
          case "not_landed": {
            // Phase 10 (codex re-audit #5): pre-send-abort returns txid=null
            // with reason="aborted before send"; post-send-timeout returns a
            // real txid. The decision log + trade-result narrate both cases
            // so a reviewer can tell from /phase-events whether the kill
            // switch caught us in time or whether the tx is sitting
            // somewhere on the wire.
            const txLabel = result.txid ?? "<not-sent>";
            const reasonLabel = result.reason
              ? `${result.reason} (${txLabel})`
              : `not_landed ${txLabel}`;
            log.warn(`submit_trade not_landed txid=${txLabel} reason=${result.reason ?? "(post-send timeout)"}`);
            stateStore.recordDecision({
              ts: Date.now(),
              symbol: (side === "BUY" ? input.tokenOut : input.tokenIn).slice(0, 8),
              action: "PASS",
              reason: reasonLabel,
            });
            stateStore.recordTradeResult(reasonLabel, {
              side,
              // Only attach txid when we actually broadcast. A null txid
              // here would otherwise pollute the phase_events row with a
              // signature that doesn't exist on-chain.
              ...(result.txid ? { txid: result.txid } : {}),
              outcome: "not_landed",
            });
            return {
              content: [
                {
                  type: "text",
                  text: result.txid
                    ? `execute-failed: tx ${result.txid} did not land within timeout`
                    : `execute-failed: ${result.reason ?? "aborted before send"} (no tx broadcast)`,
                },
              ],
              isError: true,
            };
          }
          default: {
            // Phase 4: exhaustiveness — any new ExecuteTradeResult variant
            // becomes a compile error here, so failure paths can't be
            // silently added without updating the handler.
            const _exhaustive: never = result;
            throw new Error(
              `unhandled ExecuteTradeResult variant: ${JSON.stringify(_exhaustive)}`,
            );
          }
        }
      } catch (err) {
        log.error(`submit_trade execute failed: ${String(err)}`);
        stateStore.recordDecision({
          ts: Date.now(),
          symbol: (side === "BUY" ? input.tokenOut : input.tokenIn).slice(0, 8),
          action: "PASS",
          reason: `execute-failed: ${String(err)}`,
        });
        stateStore.recordTradeResult(`execute-failed: ${String(err)}`, {
          side,
          outcome: "execute_threw",
        });
        return {
          content: [
            { type: "text", text: `execute-failed: ${String(err)}` },
          ],
          isError: true,
        };
      }

      // landedLate paths annotate the trade row so a human can reconcile
      // later — the tx did land, but confirmation arrived past our 90s
      // window, so price + slippage might be staler than usual.
      const recordReason = landedLate
        ? `${input.reason} [landed-after-timeout: reconcile]`
        : input.reason;
      try {
        if (side === "BUY") {
          if (!ledger.hasTradeTxid(txid)) {
            ledger.recordTrade({
              tokenIn: input.tokenIn,
              tokenOut: input.tokenOut,
              side: "BUY",
              amountSol: input.amountSol as number,
              txid,
              executedPriceSolPerToken,
              reason: recordReason,
            });
          }
          ledger.openPosition({
            tokenId: input.tokenOut,
            entryPriceSolPerToken: executedPriceSolPerToken ?? 0,
            sizeSol: input.amountSol as number,
            decimals: mintDecimals as number,
            // Phase 10 (#1): persist the exact uint64 received so the SELL
            // path can size exits precisely, instead of inferring tokens =
            // sizeSol / entryPrice (slippage-corrupted).
            tokensReceivedAtomic,
          });

          stateStore.recordDecision({
            ts: Date.now(),
            symbol: input.tokenOut.slice(0, 8),
            action: "BUY",
            reason: recordReason,
          });
          stateStore.setSelectedToken(input.tokenOut);
        } else {
          // SELL: record trade row, then close the position. The position is
          // keyed by mint (tokenId == tokenIn for SELL). On-chain
          // confirmation succeeded above (status === "ok" or
          // "landed_after_timeout").
          if (!ledger.hasTradeTxid(txid)) {
            ledger.recordTrade({
              tokenIn: input.tokenIn,
              tokenOut: input.tokenOut,
              side: "SELL",
              // amountSol on a SELL row records realized SOL proceeds; quote.outAmount
              // is lamports for SELL.
              amountSol: 0,
              txid,
              executedPriceSolPerToken,
              reason: recordReason,
            });
          }
          ledger.closePosition(input.tokenIn);

          stateStore.recordDecision({
            ts: Date.now(),
            symbol: input.tokenIn.slice(0, 8),
            action: "SELL",
            reason: recordReason,
          });
          stateStore.setSelectedToken(null);
        }
      } catch (err) {
        log.error(`post-trade bookkeeping failed after txid ${txid}: ${String(err)}`);
        try {
          stateStore.recordDecision({
            ts: Date.now(),
            symbol: (side === "BUY" ? input.tokenOut : input.tokenIn).slice(0, 8),
            action: side,
            reason: `executed ${txid}; bookkeeping failed, do not retry automatically`,
          });
          if (side === "BUY") stateStore.setSelectedToken(input.tokenOut);
          else stateStore.setSelectedToken(null);
          stateStore.recordTradeResult(`bookkeeping-failed ${txid}`, {
            side,
            txid,
            outcome: "bookkeeping_failed",
          });
        } catch (stateErr) {
          log.error(`state recovery failed for executed txid ${txid}: ${String(stateErr)}`);
        }
        return {
          content: [
            {
              type: "text",
              text: `executed ${txid}; local bookkeeping failed and needs reconciliation before another trade`,
            },
          ],
        };
      }

      // Record the decision in claude-mem so future sessions see it
      // (plan Phase 4 step 5, line 388).
      try {
        await memClient.recordObservation({
          contentSessionId,
          tool_name: "trade-executed",
          tool_input: JSON.stringify({ ...intent, side, sellAmountTokens: input.sellAmountTokens }),
          tool_response: JSON.stringify({ txid, executedPriceSolPerToken, side }),
          cwd: process.cwd(),
          platformSource: "pepe-agent-worker",
        });
      } catch (err) {
        log.warn(`claude-mem record failed (non-fatal): ${String(err)}`);
      }

      // Phase 4: trade fully resolved (ok or landed_after_timeout). Clear
      // TRADING phase via recordTradeResult so the state machine flips
      // back to WATCHING (replaces the old TRADING_HOLD_MS auto-flip).
      stateStore.recordTradeResult(`executed ${txid}`, {
        side,
        txid,
        outcome: landedLate ? "landed_after_timeout" : "ok",
      });

      return {
        content: [{ type: "text", text: `executed ${txid}` }],
      };
    }
  );

  const markPosition = tool(
    "mark_position",
    "Manually open or close a ledger entry. Use when you've decided to exit a position (action=close) or to record an entry that bypassed submit_trade.",
    {
      tokenId: z.string(),
      action: z.enum(["open", "close"]),
      symbol: z.string().optional(),
      entryPriceSolPerToken: z.number().optional(),
      sizeSol: z.number().optional(),
      reason: z.string(),
    },
    async ({ tokenId, action, symbol, entryPriceSolPerToken, sizeSol, reason }) => {
      if (action === "close") {
        ledger.closePosition(tokenId);
        stateStore.recordDecision({
          ts: Date.now(),
          symbol: symbol ?? tokenId.slice(0, 8),
          action: "SELL",
          reason,
        });
        stateStore.setSelectedToken(null);
        return { content: [{ type: "text", text: `closed ${tokenId} (${reason})` }] };
      }
      if (entryPriceSolPerToken === undefined || sizeSol === undefined) {
        return {
          content: [
            {
              type: "text",
              text: "open requires entryPriceSolPerToken + sizeSol",
            },
          ],
          isError: true,
        };
      }
      // Manual entry path — we don't fetch decimals here. Use 0 (sentinel)
      // so position-monitor's lazy-backfill (`!Number.isFinite || <= 0`)
      // triggers on the first tick and writes the correct mint decimals via
      // setPositionDecimals. A default of 9 (SOL) would silently bypass
      // backfill and corrupt the unit math for any non-9-decimal token.
      ledger.openPosition({
        tokenId,
        symbol,
        entryPriceSolPerToken,
        sizeSol,
        decimals: 0,
      });
      stateStore.setSelectedToken(tokenId);
      return { content: [{ type: "text", text: `opened ${tokenId} (${reason})` }] };
    }
  );

  const killSwitch = tool(
    "kill_switch",
    "Trip the global kill switch. After this, all submit_trade calls deny. Use only if something looks catastrophically wrong.",
    {
      reason: z.string().min(4),
    },
    async ({ reason }) => {
      // Phase 4: trip() also aborts the kill-switch AbortSignal so an in-
      // flight signAndSend rebroadcast loop exits.
      killSwitchRef.trip();
      log.warn(`kill switch tripped: ${reason}`);
      return {
        content: [
          { type: "text", text: `killed (reason: ${reason})` },
        ],
      };
    }
  );

  return {
    getTopTokens,
    getOpenPositions,
    getQuote,
    submitTrade,
    markPosition,
    killSwitch,
  };
}

/**
 * Production entry point — wraps the tool definitions from createPepeTools
 * in an MCP SDK server config. Tests bypass this wrapper and use the raw
 * tools directly.
 */
export function createPepeMcpServer(
  args: CreatePepeMcpServerArgs,
): McpSdkServerConfigWithInstance {
  const tools = createPepeTools(args);
  return createSdkMcpServer({
    name: "pepe",
    version: "0.1.0",
    tools: [
      tools.getTopTokens,
      tools.getOpenPositions,
      tools.getQuote,
      tools.submitTrade,
      tools.markPosition,
      tools.killSwitch,
    ],
  });
}
