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
import { DEFAULT_SLIPPAGE_BPS, SLIPPAGE_HARD_CAP_BPS, PER_TRADE_MAX_SOL } from "../../trade/policy.ts";
import type { TradeLedger } from "../../trade/ledger.ts";
import { executeTrade, getQuote as jupGetQuote, defaultRpcUrl } from "../../trade/jupiter.ts";
// spl-token getMint signature: getMint(connection, mintPubkey) → { decimals, ... }.
import { getMint } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
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

export function createPepeMcpServer(
  args: CreatePepeMcpServerArgs
): McpSdkServerConfigWithInstance {
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
            log.warn(`submit_trade not_landed txid=${result.txid}`);
            stateStore.recordDecision({
              ts: Date.now(),
              symbol: (side === "BUY" ? input.tokenOut : input.tokenIn).slice(0, 8),
              action: "PASS",
              reason: `not_landed ${result.txid}`,
            });
            stateStore.recordTradeResult(`not_landed ${result.txid}`, {
              side,
              txid: result.txid,
              outcome: "not_landed",
            });
            return {
              content: [
                {
                  type: "text",
                  text: `execute-failed: tx ${result.txid} did not land within timeout`,
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

  return createSdkMcpServer({
    name: "pepe",
    version: "0.1.0",
    tools: [
      getTopTokens,
      getOpenPositions,
      getQuote,
      submitTrade,
      markPosition,
      killSwitch,
    ],
  });
}
