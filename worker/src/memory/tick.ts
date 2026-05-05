/**
 * Memory tick loop. Every MEMORY_TICK_MS:
 *   - Read the latest snapshot from the activity subscriber.
 *   - If empty or claude-mem is down, skip.
 *   - Compute top-10 by updatesPerMinute, signal counts, market condition.
 *   - POST observation to claude-mem (raw fields — let it build the XML).
 */
import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import type { ActivitySubscriber, ActivityToken } from "../activity/subscriber.ts";
import { classifyMarket, countSignals } from "../activity/classify.ts";
import type { ClaudeMemClient } from "./claude-mem-client.ts";
import { getContentSessionId } from "./session.ts";

const log = createLogger("memory");

export interface MemoryTickHandle {
  stop: () => void;
}

function topTokens(snapshot: ActivityToken[], n: number): ActivityToken[] {
  return [...snapshot]
    .sort((a, b) => (b.updatesPerMinute ?? 0) - (a.updatesPerMinute ?? 0))
    .slice(0, n);
}

export function startMemoryTick({
  subscriber,
  client,
}: {
  subscriber: ActivitySubscriber;
  client: ClaudeMemClient;
}): MemoryTickHandle {
  let tickN = 0;
  let stopped = false;

  const interval = setInterval(async () => {
    if (stopped) return;
    tickN += 1;

    const snapshot = subscriber.getSnapshot();
    if (snapshot.length === 0) {
      log.debug(`tick ${tickN} skipped (no tokens yet)`);
      return;
    }

    const sessionId = getContentSessionId();
    if (!sessionId) {
      log.warn(`tick ${tickN} skipped (no contentSessionId)`);
      return;
    }

    const top = topTokens(snapshot, 10);
    const counts = countSignals(snapshot);
    const marketCondition = classifyMarket(snapshot);

    const tool_input = JSON.stringify({
      mode: "meme-tokens",
      tick: tickN,
      top: top.map((t) => ({
        sym: t.symbol,
        ump: t.updatesPerMinute,
        sig: t.signal,
        g5: t.fiveMinGain,
        bp: t.buyPressure5m,
        pool: t.liquidity,
      })),
    });

    const tool_response = JSON.stringify({
      marketCondition,
      ...counts,
    });

    try {
      await client.recordObservation({
        contentSessionId: sessionId,
        tool_name: "token-snapshot",
        tool_input,
        tool_response,
        cwd: config.WORKING_DIR,
        platformSource: "pepe-agent-worker",
        agentType: "trading-harness",
      });
      log.info(
        `tick ${tickN} → snapshot recorded (top: ${top
          .slice(0, 5)
          .map((t) => t.symbol || t.tokenId.slice(0, 6))
          .join(", ")})`
      );
    } catch (err) {
      log.warn(`tick ${tickN} record failed`, { error: String(err) });
    }
  }, config.MEMORY_TICK_MS);

  // don't keep the event loop alive solely for the tick
  if (typeof interval.unref === "function") interval.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}
