import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { config } from "../config.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("rpc");

export interface WorkerServerHandle {
  startedAt: number;
  close: () => Promise<void>;
}

export function startWorkerServer(): WorkerServerHandle {
  const startedAt = Date.now();
  const walletPubkey = config.AGENT_WALLET_PUBLIC_KEY ?? null;
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
      sessionId: null,
      walletPubkey,
    })
  );

  // Phase 5 will replace this stub with the real state machine snapshot.
  app.get("/state", (c) =>
    c.json({
      phase: "IDLE",
      selectedTokenId: null,
      walletPubkey,
      killSwitch: false,
      sessionId: null,
    })
  );

  app.post("/chat", (c) => c.json({ error: "not implemented yet" }, 501));

  app.post("/kill", (c) => {
    log.warn("kill switch hit (stub)");
    return c.json({ killed: true });
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
