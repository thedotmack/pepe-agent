import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import { tryGetPublicKey } from "../trade/wallet.ts";
import type { StateStore } from "../state.ts";
import type { AgentLoopHandle } from "../agent/loop.ts";
import { createChatStream } from "./chat-stream.ts";

const log = createLogger("rpc");

export interface WorkerServerHandle {
  startedAt: number;
  close: () => Promise<void>;
}

export interface StartWorkerServerArgs {
  stateStore: StateStore;
  killSwitchRef: { tripped: boolean };
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
    killSwitchRef.tripped = true;
    stateStore.recordDecision({
      ts: Date.now(),
      symbol: "-",
      action: "KILL",
      reason: "kill switch tripped via /kill",
    });
    return c.json({ killed: true });
  });

  app.post("/unkill", (c) => {
    log.warn("kill switch reset via /unkill");
    killSwitchRef.tripped = false;
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
