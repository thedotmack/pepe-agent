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

/**
 * Phase 11 (codex Phase 10 re-audit H2): shared turnIdle flag.
 *
 * /chat-stream injections and auto-tick injections both have to know when
 * the agent is mid-turn so neither pushes a new injection on top of an
 * in-flight one. Pre-Phase-11 auto-tick had a local `turnIdle` boolean
 * that only it touched, and /chat's `injectUserMessage` call didn't flip
 * it — so auto-tick's 15s push could fire ON TOP of a /chat turn that the
 * agent was still processing, stacking work.
 *
 * The shared ref is a tiny mutable wrapper: { current: boolean }. Both
 * call sites (auto-tick's pushInterval body + chat-stream's inject) read
 * and write `ref.current`. The agent's `result` event is the only event
 * that flips it back to `true`. Use createTurnIdleRef() to construct one;
 * wire to both sites in boot (index.ts).
 */
export interface TurnIdleRef {
  current: boolean;
}

export function createTurnIdleRef(): TurnIdleRef {
  return { current: true };
}

export interface CreateAutoTickArgs {
  subscriber: ActivitySubscriber;
  agent: AgentLoopHandle;
  stateStore: StateStore;
  /**
   * Phase 11 (H2): shared turn-idle flag. Both auto-tick and /chat-stream
   * inject into the same agent emitter; if /chat's injection doesn't flip
   * this off, the next auto-tick push fires on top of an in-flight chat
   * turn. Defaults to a fresh ref if omitted so existing tests keep
   * working unchanged; production boot creates ONE ref and passes the
   * same instance to auto-tick AND chat-stream.
   */
  turnIdleRef?: TurnIdleRef;
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

  // Phase 4: turnIdle is flipped to `false` AT INJECTION TIME so we never
  // push a second context/decision turn while the previous injection is
  // still being processed by the SDK. assistantText is an unreliable trigger
  // because the agent may go through tool calls before emitting text —
  // between inject and first token, the 15s push could fire again.
  //
  // Phase 11 (H2): the flag is now SHARED with /chat-stream via TurnIdleRef
  // so a chat injection flips it false and auto-tick respects that. Default
  // to a fresh ref if no shared one was passed so existing tests behave
  // unchanged (each test still gets its own auto-tick-private idle flag).
  const turnIdleRef = args.turnIdleRef ?? createTurnIdleRef();
  args.agent.emitter.on("result", () => {
    turnIdleRef.current = true;
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
    // Phase 11 (H2): shared turn-idle ref. Reads as `current`. A /chat
    // injection from chat-stream.ts will have set this false; we must NOT
    // push a snapshot on top of an in-flight chat turn.
    if (!turnIdleRef.current) return;

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

    // Phase 4 / Phase 11 (H2): flip turnIdleRef.current=false BEFORE the
    // inject lands. The SDK may take several seconds to start emitting
    // tokens; in the meantime the next pushInterval tick must NOT inject
    // again. `result` (turn fully ended) is the only event that flips us
    // back to idle. Shared ref means /chat-stream also flips this site,
    // and auto-tick respects /chat's flip.
    turnIdleRef.current = false;
    args.agent.injectActivityContext(`<market_snapshot>${context}</market_snapshot>`);
    log.debug(
      `pushed market snapshot (${candidates.length} candidates, market=${market})`,
    );

    const now = Date.now();
    if (now - lastDecisionAt >= decisionMs && candidates.length > 0) {
      lastDecisionAt = now;
      // Decision injection also marks the turn busy — even though we just
      // set turnIdleRef.current=false above for the snapshot, doing it
      // again here documents that EVERY inject site is responsible for the
      // flip.
      turnIdleRef.current = false;
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
