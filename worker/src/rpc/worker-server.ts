import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import { tryGetPublicKey } from "../trade/wallet.ts";
import type { StateStore, KillSwitchRef } from "../state.ts";
import type { AgentLoopHandle } from "../agent/loop.ts";
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
}

export function startWorkerServer(args: StartWorkerServerArgs): WorkerServerHandle {
  const { stateStore, killSwitchRef, agent } = args;
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
