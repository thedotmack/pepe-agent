/**
 * Pepe-Agent SDK loop (Phase 3).
 *
 * Streaming-input pattern copied from
 *   /Users/alexnewman/Scripts/claude-mem/.claude/worktrees/agent-a135126714b0709c6/src/services/worker/SDKAgent.ts:145-471
 *
 * SDK type references (sdk.d.ts):
 *   - query() at 2225-2228
 *   - SDKUserMessage at 3481-3500 (note: shouldQuery: false for context-only injection)
 *   - Options.mcpServers at 1442
 *   - Options.hooks at 1287-1299
 *   - Options.canUseTool at 146-188 + 1191-1194
 *   - HookCallback at 726-728, PreToolUseHookSpecificOutput at 1964-1970
 *   - McpStdioServerConfig at 1050-1059
 *   - thinking: { type: 'adaptive' } at 5351-5354
 */
import { EventEmitter, on } from "node:events";
import {
  query,
  type Options,
  type SDKUserMessage,
  type SDKMessage,
  type Query,
  type CanUseTool,
} from "@anthropic-ai/claude-agent-sdk";

import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import type { ActivitySubscriber } from "../activity/subscriber.ts";

import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { createPepeMcpServer, type KillSwitchRef } from "./tools/index.ts";
import { checkTradePolicy, type TradeIntent } from "./trade-policy-stub.ts";
import { tradePolicyHook } from "./hooks.ts";

const log = createLogger("agent.loop");

const PEPE_TRADE_TOOL = "mcp__pepe__submit_trade";

export interface CreateAgentLoopArgs {
  subscriber: ActivitySubscriber;
  killSwitchRef: KillSwitchRef;
}

export interface AgentLoopHandle {
  /** Force a new assistant turn with the given user text. */
  injectUserMessage: (text: string) => void;
  /** Inject context that should NOT trigger an assistant turn (shouldQuery: false). */
  injectActivityContext: (text: string) => void;
  /** Stop the loop. */
  stop: () => void;
  /** EventEmitter for outbound assistant text / result / system events. */
  emitter: EventEmitter;
  /** Underlying Query (for advanced control: setMcpServers, getContextUsage, etc.). */
  getQueryHandle: () => Query | null;
}

function extractAssistantText(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;
  const content = msg.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

export function createAgentLoop(args: CreateAgentLoopArgs): AgentLoopHandle & { start: () => void } {
  const { subscriber, killSwitchRef } = args;

  const outbound = new EventEmitter();
  outbound.setMaxListeners(50);
  const agentInput = new EventEmitter();
  agentInput.setMaxListeners(50);

  let queryHandle: Query | null = null;
  let stopped = false;
  let runPromise: Promise<void> | null = null;

  // ─── canUseTool: secondary gate for submit_trade (defense in depth) ─────
  const canUseTool: CanUseTool = async (toolName, input, _ctx) => {
    if (toolName === PEPE_TRADE_TOOL) {
      const result = checkTradePolicy(input as unknown as TradeIntent);
      if (!result.allow) {
        return { behavior: "deny", message: `policy: ${result.reason}` };
      }
    }
    return { behavior: "allow", updatedInput: input };
  };

  async function* messageGenerator(): AsyncIterableIterator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: SYSTEM_PROMPT },
      parent_tool_use_id: null,
      isSynthetic: true,
    };

    for await (const args of on(agentInput, "user")) {
      if (stopped) break;
      yield (args as unknown[])[0] as SDKUserMessage;
    }
  }

  const options: Options = {
    model: config.ANTHROPIC_MODEL,
    // The SDK ships native binaries as optional npm deps and falls over on
    // node:slim arm64 (mis-detects musl). Point at the global `claude` from
    // `npm i -g @anthropic-ai/claude-code` so we never depend on the bundled
    // native variant.
    ...(config.CLAUDE_CODE_PATH
      ? { pathToClaudeCodeExecutable: config.CLAUDE_CODE_PATH }
      : {}),
    mcpServers: {
      "mcp-search": {
        type: "stdio",
        command: "bun",
        args: [`${config.CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.cjs`],
      },
      pepe: createPepeMcpServer({
        subscriber,
        tradePolicyCheck: checkTradePolicy,
        killSwitchRef,
      }),
    },
    hooks: {
      PreToolUse: [
        {
          matcher: PEPE_TRADE_TOOL,
          hooks: [tradePolicyHook],
        },
      ],
    },
    canUseTool,
    thinking: { type: "adaptive" },
    maxBudgetUsd: config.AGENT_MAX_BUDGET_USD,
    // Lock down MCP/setting scope: do NOT inherit user/project settings or
    // user-scope MCP servers (gmail, drive, vercel, etc.). The agent gets
    // exactly the servers we wired in `mcpServers:` and nothing else.
    // Mirrors the claude-mem worker pattern (SDKAgent.ts:165-168).
    settingSources: [],
    strictMcpConfig: true,
  };

  function start(): void {
    if (runPromise) {
      log.warn("agent loop already started — ignoring duplicate start()");
      return;
    }
    log.info(
      `starting agent loop (model=${options.model}, mcp=mcp-search,pepe, plugin_root=${config.CLAUDE_PLUGIN_ROOT})`
    );
    try {
      const q = query({ prompt: messageGenerator(), options });
      queryHandle = q;
      runPromise = (async () => {
        try {
          for await (const message of q as AsyncIterable<SDKMessage>) {
            if (stopped) break;
            if (message.type === "assistant") {
              const text = extractAssistantText(message);
              if (text) {
                outbound.emit("assistantText", text);
              }
            } else if (message.type === "result") {
              outbound.emit("result", message);
            } else if (message.type === "system") {
              const sys = message as { subtype?: string; mcp_servers?: { name: string; status: string }[] };
              if (sys.subtype === "init" && sys.mcp_servers) {
                const connected = sys.mcp_servers
                  .map((s) => `${s.name}=${s.status}`)
                  .join(", ");
                log.info(`mcp servers: ${connected}`);
              } else {
                log.debug(`system: ${sys.subtype ?? "unknown"}`);
              }
            }
          }
        } catch (err) {
          if (!stopped) log.error(`agent loop crashed: ${String(err)}`);
          outbound.emit("error", err);
        } finally {
          log.info("agent loop exited");
        }
      })();
    } catch (err) {
      // Some SDK paths may throw synchronously on bad config (e.g. missing API key).
      log.error(`agent loop failed to start: ${String(err)}`);
      outbound.emit("error", err);
    }
  }

  function injectUserMessage(text: string): void {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    agentInput.emit("user", msg);
  }

  function injectActivityContext(text: string): void {
    // shouldQuery:false → appended to transcript without forcing a turn,
    // merged into the next real user message. (sdk.d.ts:3491-3493)
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      isSynthetic: true,
      shouldQuery: false,
    };
    agentInput.emit("user", msg);
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    try {
      if (queryHandle && typeof queryHandle.interrupt === "function") {
        await queryHandle.interrupt();
      }
    } catch (err) {
      log.warn(`interrupt failed: ${String(err)}`);
    }
    agentInput.removeAllListeners();
    outbound.removeAllListeners();
  }

  return {
    start,
    injectUserMessage,
    injectActivityContext,
    stop: () => {
      void stop();
    },
    emitter: outbound,
    getQueryHandle: () => queryHandle,
  };
}
