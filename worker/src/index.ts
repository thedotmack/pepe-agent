import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { startWorkerServer } from "./rpc/worker-server.ts";
import { createActivitySubscriber } from "./activity/subscriber.ts";
import { createClaudeMemClient } from "./memory/claude-mem-client.ts";
import { mintContentSessionId } from "./memory/session.ts";
import { startMemoryTick } from "./memory/tick.ts";
import { createAgentLoop } from "./agent/loop.ts";
import { startAutoTick, createTurnIdleRef } from "./agent/auto-tick.ts";
import { startPositionMonitor } from "./agent/position-monitor.ts";
import { openLedger } from "./trade/ledger.ts";
import { tryGetPublicKey } from "./trade/wallet.ts";
import { createStateStore, createKillSwitchRef, type FeedStatus } from "./state.ts";
import type { SubscriberStatus } from "./activity/subscriber.ts";

const log = createLogger("boot");

async function main() {
  log.info("pepe-agent worker starting", {
    network: config.SOLANA_NETWORK,
    port: config.WORKER_PORT,
  });

  // Trade ledger (Phase 4) — opened on boot regardless of wallet config so
  // `get_open_positions` works even before the first trade. Path is logged
  // (file location only — never the contents).
  const ledger = openLedger();
  log.info(`trade ledger opened at ${ledger.dbPath}`);

  // Wallet status — log pubkey on boot if we have one. Plan Phase 4
  // anti-pattern explicitly forbids logging the private key.
  const walletPubkey = tryGetPublicKey();
  if (walletPubkey) {
    log.info(`wallet pubkey: ${walletPubkey}`);
  } else {
    log.warn(
      "no wallet configured — submit_trade will be denied (set AGENT_WALLET_PRIVATE_KEY_BASE58)"
    );
  }

  // Phase 5: kill switch + state store (created up front so the worker server
  // can serve /state and /kill from boot, even before the agent loop starts).
  // Phase 4: killSwitchRef now exposes a `signal: AbortSignal` that aborts
  // when `trip()` is called. In-flight Jupiter sends compose this into their
  // signAndSend loop so /kill mid-trade actually interrupts the rebroadcast/
  // confirm dance instead of just being advisory after the fact.
  const bootKillSwitchActive = process.env.KILL_SWITCH === "1";
  const killSwitchRef = createKillSwitchRef({ bootKillSwitchActive });
  if (bootKillSwitchActive) {
    killSwitchRef.trip();
    log.warn("KILL_SWITCH=1 — trades will be denied (boot-time)");
  }

  // Phase 4: wallet-balance poll. Cached outer variable updated every 15s
  // (RPC is rate-limited). Both stateStore.snapshot() and the agent's
  // policy-context closure read from this same cache so they're consistent.
  //
  // Phase 6: `null` means "balance unknown" — we have never successfully
  // fetched. RPC failures do NOT reset to null (we keep the last known good
  // value). The policy distinguishes null (UNKNOWN, deny BUY) from a low
  // numeric value (TANK_EMPTY). Audit finding #9: do not default to 0 or
  // Infinity — both silently hide RPC outages.
  //
  // Phase 10 (codex re-audit #9): cached balance also carries an "as-of"
  // timestamp. If the last successful refresh is older than BALANCE_TTL_MS,
  // the accessor returns null so the policy treats us as UNKNOWN and stops
  // BUYing on a stale snapshot. The default 120s TTL is 4× the 30s poll —
  // gives RPC a few consecutive failures to recover before we deny BUYs.
  let walletSolCached: number | null = null;
  let walletSolCachedAt: number | null = null;
  const BALANCE_TTL_MS = 120_000;
  // Phase 10: 10s hard ceiling around getBalance. Connection has its own
  // internal timeout but it's per-HTTP-attempt, not per-overall-await; if
  // the RPC is flaky enough to retry, the await can outlive the poll
  // interval and pile up. Promise.race against AbortSignal.timeout bounds it.
  const BALANCE_RPC_TIMEOUT_MS = 10_000;
  let balancePoll: ReturnType<typeof setInterval> | null = null;
  if (walletPubkey) {
    try {
      const pubkey = new PublicKey(walletPubkey);
      const rpcUrl =
        config.SOLANA_RPC_URL ??
        (config.SOLANA_NETWORK === "devnet"
          ? "https://api.devnet.solana.com"
          : config.SOLANA_NETWORK === "testnet"
            ? "https://api.testnet.solana.com"
            : null);
      if (rpcUrl) {
        const rpc = new Connection(rpcUrl, "confirmed");
        const refreshBalance = async () => {
          try {
            // Phase 10 (codex re-audit #7/#9): Connection.getBalance has an
            // internal HTTP timeout but the overall await is unbounded if it
            // retries. Race against AbortSignal.timeout so a hung RPC can't
            // wedge the poll loop or stall the next refresh.
            const lamports = await Promise.race([
              rpc.getBalance(pubkey, "confirmed"),
              new Promise<number>((_, reject) => {
                const signal = AbortSignal.timeout(BALANCE_RPC_TIMEOUT_MS);
                signal.addEventListener(
                  "abort",
                  () =>
                    reject(
                      new Error(
                        `getBalance timeout after ${BALANCE_RPC_TIMEOUT_MS}ms`,
                      ),
                    ),
                  { once: true },
                );
              }),
            ]);
            walletSolCached = lamports / LAMPORTS_PER_SOL;
            // Phase 10: stamp the as-of so a later stale-TTL check can
            // demote the cached value back to UNKNOWN if RPC stays down.
            walletSolCachedAt = Date.now();
          } catch (err) {
            // Intentionally do NOT reset walletSolCached here. If we had a
            // good value, keep it; if we never had one, null persists and
            // the policy denies BUYs until RPC recovers.
            // Phase 10: also do NOT bump walletSolCachedAt — the value is
            // unchanged, but its as-of timestamp must remain pinned to the
            // last *successful* refresh so the TTL check can evict.
            log.warn(`balance fetch failed: ${String(err)}`);
          }
        };
        await refreshBalance();
        balancePoll = setInterval(refreshBalance, 15_000);
        if (typeof balancePoll.unref === "function") balancePoll.unref();
        // Read via a getter to defeat TS control-flow narrowing of the
        // closure-captured `walletSolCached` (which TS otherwise infers as
        // `null` past the initializer, even after `await refreshBalance()`
        // has reassigned it).
        const readBalance = (): number | null => walletSolCached;
        const initial = readBalance();
        log.info(
          `wallet balance poll started (initial=${
            initial === null ? "UNKNOWN" : `${initial.toFixed(4)} SOL`
          })`
        );
      } else {
        log.warn("SOLANA_RPC_URL not set for mainnet — wallet balance disabled");
      }
    } catch (err) {
      log.warn(`wallet balance setup failed: ${String(err)}`);
    }
  }

  // Phase 10 (codex re-audit #9): shared TTL-aware accessor. Returns null
  // (UNKNOWN) when the cache has gone stale — RPC has been down longer than
  // BALANCE_TTL_MS so the policy/UI must NOT trust the last known good.
  // Single accessor so the policy gate and the UI snapshot agree on what
  // "stale" means.
  const getWalletSolBalanceWithTtl = (): number | null => {
    if (walletSolCached === null || walletSolCachedAt === null) return null;
    if (Date.now() - walletSolCachedAt > BALANCE_TTL_MS) return null;
    return walletSolCached;
  };

  const stateStore = createStateStore({
    ledger,
    killSwitchRef,
    contentSessionId: null,
    walletPubkey: walletPubkey ?? null,
    // UI surface: now passes the nullable balance through to the UI so the
    // board can render UNKNOWN as "--.-- SOL" instead of misleading 0.0000.
    // The policy gate consumes the same source via the loop's
    // getWalletSolBalance closure (also nullable). Audit finding #9, Phase
    // 8 (O3) widens the snapshot surface to match the policy surface.
    // Phase 10: also gated by TTL so a hours-old cached value stops looking
    // fresh once we've lost RPC for >120s.
    balanceProvider: getWalletSolBalanceWithTtl,
  });

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
  stateStore.setSessionId(contentSessionId);
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
  subscriber.emitter.on("status", ({ status }: { status: SubscriberStatus }) => {
    log.info(`activity status → ${status}`);
    // Map subscriber's "idle" → "connecting" for the public FeedStatus surface.
    const mapped: FeedStatus = status === "idle" ? "connecting" : status;
    stateStore.setFeedStatus(mapped);
  });

  // Memory tick: 5s digest pulled from the subscriber's latest snapshot.
  const tick = startMemoryTick({ subscriber, client: memClient });

  // Phase 5: 500ms tick to drive the state machine's idle/grace timers.
  const stateTick = setInterval(() => stateStore.tick(Date.now()), 500);
  stateTick.unref();

  // Agent loop (Phase 3). Boots only if ANTHROPIC_API_KEY is set; otherwise
  // the worker still serves subscribers + memory tick.
  //
  // Phase 11 (codex Phase 10 re-audit H2): turnIdleRef is shared between
  // auto-tick and /chat-stream. Both inject into the same agent emitter;
  // each must flip this off BEFORE injecting so the other doesn't stack
  // work on top of an in-flight turn. Created once here and passed to
  // BOTH auto-tick and worker-server. Created up front (even when agent
  // is null) so worker-server doesn't have to deal with optional plumbing.
  const turnIdleRef = createTurnIdleRef();
  let agent: ReturnType<typeof createAgentLoop> | null = null;
  let autoTick: ReturnType<typeof startAutoTick> | null = null;
  let positionMonitor: ReturnType<typeof startPositionMonitor> | null = null;
  if (config.ANTHROPIC_API_KEY) {
    try {
      agent = createAgentLoop({
        subscriber,
        killSwitchRef,
        ledger,
        memClient,
        contentSessionId,
        stateStore,
        // Phase 10: same TTL-aware accessor as the UI snapshot. Policy
        // denies BUY when balance is UNKNOWN; stale cache must demote to
        // UNKNOWN so we don't BUY on a balance that was true 30min ago.
        getWalletSolBalance: getWalletSolBalanceWithTtl,
      });
      agent.emitter.on("assistantText", (text: string) => {
        log.info(`[agent] ${text.slice(0, 200)}`);
      });
      agent.emitter.on("error", (err: unknown) => {
        log.warn(`[agent] error: ${String(err)}`);
      });
      agent.start();
      log.info("agent loop started");

      // Phase 2 + Phase 3: autonomous entry + exit signallers. Must start
      // AFTER agent.start() so emitter listeners are wired before the first
      // tick fires.
      autoTick = startAutoTick({ subscriber, agent, stateStore, turnIdleRef });
      log.info("auto-tick started");
      positionMonitor = startPositionMonitor({ ledger, agent, stateStore });
      log.info("position-monitor started");
    } catch (err) {
      log.warn(`agent loop start failed (continuing without agent): ${String(err)}`);
      agent = null;
    }
  } else {
    log.warn(
      "ANTHROPIC_API_KEY not set — agent loop disabled (subscribers + memory tick still run)"
    );
  }

  // Worker HTTP server (must be started AFTER the agent loop is created so
  // POST /chat can inject into the live query session). When agent is null
  // the server still serves /state, /healthz, /kill — /chat returns 503.
  const server = startWorkerServer({ stateStore, killSwitchRef, agent, ledger, turnIdleRef });

  const shutdown = async (signal: string) => {
    log.warn(`received ${signal}, shutting down`);
    if (autoTick) autoTick.stop();
    if (positionMonitor) positionMonitor.stop();
    if (agent) agent.stop();
    if (balancePoll) clearInterval(balancePoll);
    clearInterval(stateTick);
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
