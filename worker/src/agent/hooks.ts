/**
 * Declarative SDK hooks for the Pepe-Agent.
 *
 * Hook callback shape verified against
 * /Users/alexnewman/Scripts/claude-mem/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:
 *   - HookCallback (line 726-728): `(input, toolUseID, { signal }) => Promise<HookJSONOutput>`
 *   - HookJSONOutput (line 744): `AsyncHookJSONOutput | SyncHookJSONOutput`
 *   - SyncHookJSONOutput (line 5290-5299): has optional `hookSpecificOutput`
 *   - PreToolUseHookSpecificOutput (line 1964-1970): `{ hookEventName: 'PreToolUse', permissionDecision?, permissionDecisionReason?, updatedInput?, additionalContext? }`
 *   - PreToolUseHookInput (line 1957-1962): `{ hook_event_name, tool_name, tool_input, tool_use_id, ... }`
 */
import type {
  HookCallback,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type { TradeIntent, PolicyContext } from "../trade/policy.ts";
import { checkTradePolicy } from "../trade/policy.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("agent.hooks");

/**
 * PreToolUse hook factory for `mcp__pepe__submit_trade`.
 *
 * Calls the trade-policy module (defense-in-depth: same check runs in
 * canUseTool and the handler).
 */
export function createTradePolicyHook(policyContext: PolicyContext): HookCallback {
  return async (input, _toolUseId, _ctx) => {
    const pre = input as PreToolUseHookInput;
    const intent = pre.tool_input as TradeIntent;
    const result = checkTradePolicy(intent, policyContext);
    if (!result.allow) {
      log.warn(`trade denied by hook: ${result.reason}`);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.reason,
        },
      };
    }
    // Allow by default — empty SyncHookJSONOutput.
    return {};
  };
}
