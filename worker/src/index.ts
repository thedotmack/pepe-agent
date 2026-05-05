import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { startWorkerServer } from "./rpc/worker-server.ts";

const log = createLogger("boot");

async function main() {
  log.info("pepe-agent worker starting", {
    network: config.SOLANA_NETWORK,
    port: config.WORKER_PORT,
  });

  const server = startWorkerServer();

  const shutdown = async (signal: string) => {
    log.warn(`received ${signal}, shutting down`);
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
