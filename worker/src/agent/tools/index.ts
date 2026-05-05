/**
 * Pepe MCP tool surface (Phase 3).
 *
 * Six custom tools registered via createSdkMcpServer. Phase 3 ships these as
 * stubs (except `get_top_tokens` and `kill_switch` which are real). Phase 4
 * wires Jupiter / ledger / trade-policy.
 *
 * Subscriber is injected — never imported directly — so tests and replay can
 * pass a fake. Same for the trade-policy check function.
 */
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { ActivitySubscriber, ActivityToken } from "../../activity/subscriber.ts";
import type { TradeIntent, PolicyResult } from "../trade-policy-stub.ts";

export type KillSwitchRef = { tripped: boolean };

export interface CreatePepeMcpServerArgs {
  subscriber: ActivitySubscriber;
  tradePolicyCheck: (intent: TradeIntent) => PolicyResult;
  killSwitchRef: KillSwitchRef;
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
  const { subscriber, tradePolicyCheck, killSwitchRef } = args;

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
    "Read the open positions ledger. Phase 3: stub — always returns empty. Phase 4 wires the real ledger.",
    {},
    async () => ({
      content: [{ type: "text", text: "[]" }],
    })
  );

  const getQuote = tool(
    "get_quote",
    "Fetch a Jupiter quote (read-only). Phase 3: not implemented.",
    {
      tokenIn: z.string().min(32),
      tokenOut: z.string().min(32),
      amount: z.string(),
      slippageBps: z.number().int().min(0).max(300).default(100),
    },
    async () => ({
      content: [
        { type: "text", text: "quote-not-yet-implemented (Phase 4)" },
      ],
      isError: true,
    })
  );

  const submitTrade = tool(
    "submit_trade",
    "Sign + submit a swap. Gated by trade-policy + PreToolUse hook + canUseTool. Phase 3: always denied. Provide a one-sentence `reason` Pepe can narrate.",
    {
      tokenIn: z.string().min(32),
      tokenOut: z.string().min(32),
      amountSol: z.number().positive().max(2.0),
      slippageBps: z.number().int().min(0).max(300).default(100),
      reason: z.string().min(8),
    },
    async (input) => {
      // Defense in depth: even if the hook + canUseTool somehow let this
      // through, the handler re-checks the policy. Phase 4 also wires the
      // real Jupiter swap here.
      if (killSwitchRef.tripped) {
        return {
          content: [{ type: "text", text: "denied: kill switch is tripped" }],
          isError: true,
        };
      }
      const decision = tradePolicyCheck(input as TradeIntent);
      if (!decision.allow) {
        return {
          content: [{ type: "text", text: `denied: ${decision.reason}` }],
          isError: true,
        };
      }
      // Should be unreachable in Phase 3.
      return {
        content: [
          {
            type: "text",
            text: "denied: submit path not implemented (Phase 4)",
          },
        ],
        isError: true,
      };
    }
  );

  const markPosition = tool(
    "mark_position",
    "Manually open or close a ledger entry. Phase 3: noop.",
    {
      tokenId: z.string(),
      action: z.enum(["open", "close"]),
      reason: z.string(),
    },
    async () => ({
      content: [{ type: "text", text: "noop in Phase 3" }],
    })
  );

  const killSwitch = tool(
    "kill_switch",
    "Trip the global kill switch. After this, all submit_trade calls deny. Use only if something looks catastrophically wrong.",
    {
      reason: z.string().min(4),
    },
    async ({ reason }) => {
      killSwitchRef.tripped = true;
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
