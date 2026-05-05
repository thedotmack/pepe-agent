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
import { executeTrade, getQuote as jupGetQuote } from "../../trade/jupiter.ts";
import type { ClaudeMemClient } from "../../memory/claude-mem-client.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("agent.tools");

export type KillSwitchRef = { tripped: boolean };

export interface CreatePepeMcpServerArgs {
  subscriber: ActivitySubscriber;
  tradePolicyCheck: (intent: TradeIntent) => PolicyResult;
  killSwitchRef: KillSwitchRef;
  ledger: TradeLedger;
  memClient: ClaudeMemClient;
  contentSessionId: string;
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
    "Sign + submit a swap. Gated by trade-policy + PreToolUse hook + canUseTool. Provide a one-sentence `reason` Pepe can narrate.",
    {
      tokenIn: z.string().min(3),
      tokenOut: z.string().min(3),
      amountSol: z.number().positive().max(PER_TRADE_MAX_SOL),
      slippageBps: z
        .number()
        .int()
        .min(0)
        .max(SLIPPAGE_HARD_CAP_BPS)
        .default(DEFAULT_SLIPPAGE_BPS),
      reason: z.string().min(8),
    },
    async (input) => {
      // Defense-in-depth: even if hook + canUseTool somehow let this through,
      // the handler re-checks the policy.
      if (killSwitchRef.tripped) {
        return {
          content: [{ type: "text", text: "denied: kill switch is tripped" }],
          isError: true,
        };
      }
      const intent: TradeIntent = {
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountSol: input.amountSol,
        slippageBps: input.slippageBps,
        reason: input.reason,
      };
      const decision = tradePolicyCheck(intent);
      if (!decision.allow) {
        return {
          content: [{ type: "text", text: `denied: ${decision.reason}` }],
          isError: true,
        };
      }

      let txid: string;
      let executedPriceSolPerToken: number | null;
      try {
        const result = await executeTrade({
          inputMint: input.tokenIn,
          outputMint: input.tokenOut,
          amountSol: input.amountSol,
          slippageBps: input.slippageBps,
        });
        txid = result.txid;
        executedPriceSolPerToken = result.executedPriceSolPerToken;
      } catch (err) {
        log.error(`submit_trade execute failed: ${String(err)}`);
        return {
          content: [
            { type: "text", text: `execute-failed: ${String(err)}` },
          ],
          isError: true,
        };
      }

      // Record into ledger. SOL→TOKEN is BUY; we open a position for the
      // output token. The agent calls `mark_position` to close.
      ledger.recordTrade({
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        side: "BUY",
        amountSol: input.amountSol,
        txid,
        executedPriceSolPerToken,
        reason: input.reason,
      });
      ledger.openPosition({
        tokenId: input.tokenOut,
        entryPriceSolPerToken: executedPriceSolPerToken ?? 0,
        sizeSol: input.amountSol,
      });

      // Record the decision in claude-mem so future sessions see it
      // (plan Phase 4 step 5, line 388).
      try {
        await memClient.recordObservation({
          contentSessionId,
          tool_name: "trade-executed",
          tool_input: JSON.stringify(intent),
          tool_response: JSON.stringify({ txid, executedPriceSolPerToken }),
          cwd: process.cwd(),
          platformSource: "pepe-agent-worker",
        });
      } catch (err) {
        log.warn(`claude-mem record failed (non-fatal): ${String(err)}`);
      }

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
      ledger.openPosition({
        tokenId,
        symbol,
        entryPriceSolPerToken,
        sizeSol,
      });
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
      killSwitchRef.tripped = true;
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
