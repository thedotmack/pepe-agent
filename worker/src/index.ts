import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { startWorkerServer } from "./rpc/worker-server.ts";
import { createActivitySubscriber } from "./activity/subscriber.ts";
import { createClaudeMemClient } from "./memory/claude-mem-client.ts";
import { mintContentSessionId } from "./memory/session.ts";
import { startMemoryTick } from "./memory/tick.ts";
import { createAgentLoop } from "./agent/loop.ts";

const log = createLogger("boot");

async function main() {
  log.info("pepe-agent worker starting", {
    network: config.SOLANA_NETWORK,
    port: config.WORKER_PORT,
  });

  const server = startWorkerServer();

  // claude-mem client. Health-check on boot but never crash if it's down —
  // the worker still serves /healthz and accepts chat without memory.
  const memClient = createClaudeMemClient();
  log.info(`claude-mem worker URL: ${memClient.baseUrl}`);

  const memHealthy = await memClient.health();
  if (memHealthy) {
    log.info("claude-mem health ok");
  } else {
    log.warn(`claude-mem health failed at ${memClient.baseUrl} — memory features disabled`);
  }

  // Mint a fresh contentSessionId for this cold boot. Never persist across restarts.
  const contentSessionId = mintContentSessionId();
  if (memHealthy) {
    try {
      await memClient.initSession({
        contentSessionId,
        project: "Pepe-Agent",
        prompt:
          "Pepe-Agent trading harness cold boot. Subscriber will deliver token-snapshot observations on a 5s tick.",
        platformSource: "pepe-agent-worker",
      });
      log.info(`session initialized ${contentSessionId} (project=Pepe-Agent)`);
    } catch (err) {
      log.warn(`session init failed (continuing without memory): ${String(err)}`);
    }
  }

  // Activity subscriber: wss → in-memory map → 1Hz emitter.
  const subscriber = createActivitySubscriber();
  subscriber.emitter.on("status", ({ status }) => {
    log.info(`activity status → ${status}`);
  });

  // Memory tick: 5s digest pulled from the subscriber's latest snapshot.
  const tick = startMemoryTick({ subscriber, client: memClient });

  // Agent loop (Phase 3). Boots only if ANTHROPIC_API_KEY is set; otherwise
  // the worker still serves subscribers + memory tick.
  const killSwitchRef = { tripped: false };
  let agent: ReturnType<typeof createAgentLoop> | null = null;
  if (config.ANTHROPIC_API_KEY) {
    try {
      agent = createAgentLoop({ subscriber, killSwitchRef });
      agent.emitter.on("assistantText", (text: string) => {
        log.info(`[agent] ${text.slice(0, 200)}`);
      });
      agent.emitter.on("error", (err: unknown) => {
        log.warn(`[agent] error: ${String(err)}`);
      });
      agent.start();
      log.info("agent loop started");
    } catch (err) {
      log.warn(`agent loop start failed (continuing without agent): ${String(err)}`);
      agent = null;
    }
  } else {
    log.warn(
      "ANTHROPIC_API_KEY not set — agent loop disabled (subscribers + memory tick still run)"
    );
  }

  const shutdown = async (signal: string) => {
    log.warn(`received ${signal}, shutting down`);
    if (agent) agent.stop();
    tick.stop();
    subscriber.stop();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info("worker ready");
}

main().catch((err) => {
  console.error("[boot] fatal:", err);
  process.exit(1);
});
