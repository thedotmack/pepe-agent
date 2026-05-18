import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import { tryGetPublicKey } from "../trade/wallet.ts";
import type { StateStore, KillSwitchRef } from "../state.ts";
import type { AgentLoopHandle } from "../agent/loop.ts";
import type { TurnIdleRef } from "../agent/auto-tick.ts";
import type { TradeLedger } from "../trade/ledger.ts";
import { createChatStream } from "./chat-stream.ts";

const log = createLogger("rpc");

export interface WorkerServerHandle {
  startedAt: number;
  close: () => Promise<void>;
}

export interface StartWorkerServerArgs {
  stateStore: StateStore;
  killSwitchRef: KillSwitchRef;
  /** Agent loop handle, or null if the worker booted without ANTHROPIC_API_KEY. */
  agent: AgentLoopHandle | null;
  /**
   * Phase 8 (O4): ledger handle so the /phase-events endpoint can read the
   * audit trail. The ledger's recentPhaseEvents() is the source-of-truth
   * for trade-result attempts (kill-switch denials, policy denials,
   * failed_onchain, not_landed, etc — anything that flowed through
   * state.ts:recordTradeResult since Phase 7).
   */
  ledger: TradeLedger;
  /**
   * Phase 11 (codex Phase 10 re-audit H2): shared turn-idle flag plumbed
   * through to /chat handler so chat injections flip the same ref that
   * auto-tick reads — preventing auto-tick from stacking a market_snapshot
   * push on top of an in-flight chat turn. Optional: when the worker boots
   * without ANTHROPIC_API_KEY (agent=null), no ref is needed because /chat
   * returns 503 anyway.
   */
  turnIdleRef?: TurnIdleRef;
}

export function startWorkerServer(args: StartWorkerServerArgs): WorkerServerHandle {
  const { stateStore, killSwitchRef, agent, ledger, turnIdleRef } = args;
  const startedAt = Date.now();
  const walletPubkey = tryGetPublicKey();
  const app = new Hono();

  // Auth gate: every route requires x-agent-secret. /healthz included intentionally
  // — the worker is on 127.0.0.1 only and Next.js proxies all browser traffic, so the
  // shared secret is the single source of authn. See Phase 0.F decision 4.
  app.use("*", async (c, next) => {
    const got = c.req.header("x-agent-secret");
    if (got !== config.AGENT_SHARED_SECRET) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      uptime: Date.now() - startedAt,
      sessionId: stateStore.snapshot().sessionId,
      walletPubkey,
    })
  );

  // Phase 5: real state machine snapshot.
  app.get("/state", (c) => c.json(stateStore.snapshot()));

  // Phase 8 (O4): audit-trail read API. Returns the N newest phase_events
  // rows (Phase 7 H4 audit table). Default 50, max 500. Same x-agent-secret
  // gate as everything else. Use this to reconcile against trades.txid +
  // decision-log narration on the operator side. Never proxied to browser.
  app.get("/phase-events", (c) => {
    const limitParam = c.req.query("limit");
    let limit = 50;
    if (limitParam !== undefined) {
      const parsed = Number(limitParam);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return c.json({ error: "limit must be a positive integer" }, 400);
      }
      limit = Math.min(500, Math.floor(parsed));
    }
    try {
      const events = ledger.recentPhaseEvents(limit);
      return c.json({ events, limit });
    } catch (err) {
      log.warn(`/phase-events read failed: ${String(err)}`);
      return c.json({ error: "ledger read failed" }, 500);
    }
  });

  app.post("/chat", async (c) => {
    if (!agent) {
      return c.json(
        { error: "agent not running (ANTHROPIC_API_KEY not set?)" },
        503
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return c.json({ error: "missing or empty 'text' field" }, 400);
    }

    const stream = createChatStream({
      agent,
      userText: text,
      signal: c.req.raw.signal,
      // Phase 11 (H2): shared with auto-tick. /chat flips this false; auto-
      // tick respects it. Same instance, both call sites.
      turnIdleRef,
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  app.post("/kill", (c) => {
    log.warn("kill switch tripped via /kill");
    killSwitchRef.trip();
    stateStore.recordDecision({
      ts: Date.now(),
      symbol: "-",
      action: "KILL",
      reason: "kill switch tripped via /kill",
    });
    return c.json({ killed: true });
  });

  // Phase 4: /unkill is double-gated.
  //   1. ?confirm=<AGENT_SHARED_SECRET> query param (defeats accidental curl
  //      replays even if the x-agent-secret header leaks via a log snippet).
  //   2. If the worker booted with KILL_SWITCH=1, additionally require
  //      KILL_SWITCH_OVERRIDE=1 in env — operator must explicitly opt out of
  //      the boot-time safety. /unkill without override refuses.
  app.post("/unkill", (c) => {
    const confirm = c.req.query("confirm");
    if (confirm !== config.AGENT_SHARED_SECRET) {
      log.warn("/unkill denied — missing or wrong ?confirm token");
      return c.json({ error: "unkill requires ?confirm=<AGENT_SHARED_SECRET>" }, 403);
    }
    if (killSwitchRef.bootKillSwitchActive && process.env.KILL_SWITCH_OVERRIDE !== "1") {
      log.warn(
        "/unkill denied — worker booted with KILL_SWITCH=1; KILL_SWITCH_OVERRIDE=1 required",
      );
      return c.json(
        {
          error:
            "worker booted with KILL_SWITCH=1; set KILL_SWITCH_OVERRIDE=1 in env to allow /unkill",
        },
        403,
      );
    }
    log.warn("kill switch reset via /unkill");
    killSwitchRef.reset();
    stateStore.recordDecision({
      ts: Date.now(),
      symbol: "-",
      action: "RESUME",
      reason: "kill switch reset via /unkill",
    });
    return c.json({ killed: false });
  });

  const server = serve({
    fetch: app.fetch,
    port: config.WORKER_PORT,
    hostname: config.WORKER_BIND,
  });

  log.info(`listening on http://${config.WORKER_BIND}:${config.WORKER_PORT}`, {
    walletPubkey,
  });

  return {
    startedAt,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
