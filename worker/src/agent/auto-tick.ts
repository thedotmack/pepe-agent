/**
 * Autonomous market-push tick (Phase 2).
 *
 * The agent loop is otherwise reactive — it only speaks when a user sends a
 * chat message. This module turns it autonomous: every `pushIntervalMs` we
 * inject the latest activity-subscriber snapshot as silent context, and
 * every `decisionIntervalMs` (when candidates exist) we inject a forced
 * decision turn so the agent narrates a call or a pass.
 *
 * Thresholds (`MIN_FIVE_MIN_GAIN`, etc.) are imported from `policy.ts` so
 * the agent's pre-filter and the trade-policy gates share one source of
 * truth — change BRIEF §7.2 once, both places update.
 *
 * Refs:
 *   - BRIEF §7.2 entry gates
 *   - worker/src/memory/tick.ts for the snapshot-projection pattern
 *   - worker/src/agent/loop.ts for `injectUserMessage` / `injectActivityContext`
 */
import type { ActivitySubscriber, ActivityToken } from "../activity/subscriber.ts";
import type { AgentLoopHandle } from "./loop.ts";
import type { StateStore } from "../state.ts";
import { classifyMarket, countSignals } from "../activity/classify.ts";
import {
  MIN_FIVE_MIN_GAIN,
  MIN_BUY_PRESSURE_5M,
  MIN_LIQUIDITY_USD,
  MIN_UPDATES_PER_MINUTE,
} from "../trade/policy.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("agent.auto-tick");

export interface CreateAutoTickArgs {
  subscriber: ActivitySubscriber;
  agent: AgentLoopHandle;
  stateStore: StateStore;
  /** Default 15_000ms — market push cadence. */
  pushIntervalMs?: number;
  /** Default 45_000ms — decision-prompt cadence (when phase==WATCHING/IDLE). */
  decisionIntervalMs?: number;
  /** Default 5 — max candidates surfaced to the agent per tick. */
  topN?: number;
}

export interface AutoTickHandle {
  stop: () => void;
}

export function startAutoTick(args: CreateAutoTickArgs): AutoTickHandle {
  const pushMs = args.pushIntervalMs ?? 15_000;
  const decisionMs = args.decisionIntervalMs ?? 45_000;
  const topN = args.topN ?? 5;

  // Track turn-idle via the loop's emitter so we never stomp on an
  // in-flight tool call. `assistantText` flips us busy; `result` flips us
  // idle again. We start optimistic — first tick after boot may push.
  let turnIdle = true;
  args.agent.emitter.on("result", () => {
    turnIdle = true;
  });
  args.agent.emitter.on("assistantText", () => {
    turnIdle = false;
  });

  let lastDecisionAt = 0;
  let stopped = false;

  function pickTopN(snapshot: ActivityToken[], n: number): ActivityToken[] {
    // BRIEF §7.2 entry gates — pre-filter so the agent only sees plausible
    // buys. Thresholds imported from policy.ts (single source of truth).
    return snapshot
      .filter(
        (t) =>
          (t.fiveMinGain ?? 0) >= MIN_FIVE_MIN_GAIN &&
          (t.buyPressure5m ?? 0) >= MIN_BUY_PRESSURE_5M &&
          (t.liquidity ?? 0) >= MIN_LIQUIDITY_USD &&
          (t.updatesPerMinute ?? 0) >= MIN_UPDATES_PER_MINUTE,
      )
      .sort((a, b) => (b.fiveMinGain ?? 0) - (a.fiveMinGain ?? 0))
      .slice(0, n);
  }

  const pushInterval = setInterval(() => {
    if (stopped) return;
    const phase = args.stateStore.snapshot().phase;
    // Never inject context mid-turn — race city. Anti-pattern guard from plan.
    if (phase === "TRADING" || phase === "CALLING") return;
    if (!turnIdle) return;

    const snap = args.subscriber.getSnapshot();
    if (snap.length === 0) return;

    const candidates = pickTopN(snap, topN);
    const market = classifyMarket(snap);
    const counts = countSignals(snap);

    const context = JSON.stringify({
      type: "market-tick",
      ts: Date.now(),
      market,
      counts,
      candidates: candidates.map((t) => ({
        sym: t.symbol,
        tokenId: t.tokenId,
        price: t.price,
        g5: t.fiveMinGain,
        bp: t.buyPressure5m,
        upm: t.updatesPerMinute,
        liq: t.liquidity,
        sig: t.signal,
      })),
    });

    args.agent.injectActivityContext(`<market_snapshot>${context}</market_snapshot>`);
    log.debug(
      `pushed market snapshot (${candidates.length} candidates, market=${market})`,
    );

    const now = Date.now();
    if (now - lastDecisionAt >= decisionMs && candidates.length > 0) {
      lastDecisionAt = now;
      args.agent.injectUserMessage(
        "Market check. Based on the latest <market_snapshot> above and your memory:\n" +
          "- If any candidate meets your thesis bar, narrate your call and submit_trade.\n" +
          "- Otherwise narrate why you're passing and stay WATCHING.\n" +
          "Keep narration to 1-2 sentences.",
      );
      log.info(`forced decision turn (${candidates.length} candidates available)`);
    }
  }, pushMs);
  if (typeof pushInterval.unref === "function") pushInterval.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(pushInterval);
    },
  };
}
