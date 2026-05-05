import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { startWorkerServer } from "./rpc/worker-server.ts";
import { createActivitySubscriber } from "./activity/subscriber.ts";
import { createClaudeMemClient } from "./memory/claude-mem-client.ts";
import { mintContentSessionId } from "./memory/session.ts";
import { startMemoryTick } from "./memory/tick.ts";

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

  const shutdown = async (signal: string) => {
    log.warn(`received ${signal}, shutting down`);
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
