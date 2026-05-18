# PLAN — Pepe Goes Live (autonomous trading on 1 SOL)

**Goal:** Pepe trades real Solana memecoins, autonomously, on live `wss://api.memedeck.win/activity` data, with a 1 SOL float, visible in the browser at `localhost:3010`. The dot-matrix board reflects truth from the worker; trades fire when the agent's thesis matches the BRIEF's rule set; caps + kill switch hold.

**Status of repo (confirmed by file reads, May 17 2026):**
- `worker/` exists with Claude Agent SDK loop, MCP tools (`get_top_tokens`, `submit_trade`, `get_quote`, `get_open_positions`, `mark_position`, `kill_switch`), trade-policy (per-trade 0.25, daily 2.0, cooldown 30s, max 5 positions, slip cap 300bps), Jupiter swap (`lite-api.jup.ag/swap/v1`), SQLite ledger, claude-mem ingest, state store. All implemented at `worker/src/{index,state,config}.ts` + `worker/src/{agent,trade,activity,memory,rpc}/`.
- `app/page.tsx` is the dot-matrix board; `app/api/agent/{state,chat,kill}/route.ts` proxy to worker.
- `lib/activity/{activity-websocket,activity-store,use-activity-stream}.ts` runs the browser-side ticker feed.
- `.env.local` has voice + OpenAI keys only — **no Anthropic, no Solana, no shared secret, no wallet.**

**The gap to "live trading" (THE only thing missing):**
1. `injectActivityContext` is defined but never called — the agent never sees a market push, so it only ever responds to chat. No autonomous decision loop.
2. No position-monitor loop — open positions aren't quoted/exited based on TP/SL/rug rules from BRIEF §7.2.
3. `state.walletSol` is hard-coded to `0` (`worker/src/state.ts:85`) — never reads SOL balance from RPC.
4. Worker env is empty: `ANTHROPIC_API_KEY`, `AGENT_SHARED_SECRET`, `AGENT_WALLET_PRIVATE_KEY_BASE58`, `AGENT_WALLET_PUBLIC_KEY`, `SOLANA_RPC_URL` (mainnet) all unset.
5. No process orchestration — worker isn't started from `npm run dev`; needs a parallel boot.

Six phases, each self-contained. Phases 0–2 ship infra; Phase 3 is "go live."

---

## Phase 0 — Documentation Discovery (read before any phase)

**Already canonical in repo — do not re-derive:**
- BRIEF rule set + caps: `BRIEF-pepe-hq.md:§7.2, §7.3, §7.4, §7.5, §7.6`
- Phase architecture + verified APIs: `PLAN-pepe-harness.md:§0` (read top-to-bottom; never duplicate Anthropic SDK research it already did).

**Worker code, source-of-truth files (read these, do not invent):**

| Concern | File | Notes |
|---|---|---|
| Boot order | `worker/src/index.ts` | Subscriber → memory tick → state tick → agent loop → HTTP server |
| Agent loop public surface | `worker/src/agent/loop.ts:55-67` (`AgentLoopHandle`) | `injectUserMessage`, `injectActivityContext (shouldQuery:false)`, `stop`, `emitter`, `getQueryHandle` |
| MCP tool surface | `worker/src/agent/tools/index.ts` | 6 tools, `submit_trade` triple-gated |
| State store API | `worker/src/state.ts:34-48` (`StateStore` iface) | `setPhase`, `setSelectedToken`, `setFeedStatus`, `recordDecision`, `tick(now)` |
| Trade policy | `worker/src/trade/policy.ts` | Caps: `PER_TRADE_MAX_SOL=0.25`, `DAILY_MAX_SOL=2.0`, `COOLDOWN_MS=30_000`, `MAX_OPEN_POSITIONS=5`, `SLIPPAGE_HARD_CAP_BPS=300` |
| Jupiter integration | `worker/src/trade/jupiter.ts` | `getQuote()`, `executeTrade()` — sign+send local, fail-loud |
| Activity subscriber | `worker/src/activity/subscriber.ts:1-60` | `getSnapshot()` returns `ActivityToken[]`, emits `tokens`, `status` |
| Wallet | `worker/src/trade/wallet.ts` | `getKeypair()`, `tryGetPublicKey()`, `walletAvailable()` |
| Anti-pattern reference | `PLAN-pepe-harness.md:§3, §4, §9 anti-patterns` | Especially: no client-side wallet, no `NEXT_PUBLIC_*` agent secrets, two-step policy gate must survive |

**Solana RPC requirement for mainnet (verified `worker/src/trade/jupiter.ts:46-55`):** `SOLANA_NETWORK=mainnet-beta` REQUIRES `SOLANA_RPC_URL` set (public mainnet RPC is rate-limited and rejected). Use a Helius / QuickNode / Triton URL.

**Allowed APIs added by this plan (cite when implementing):**
- `Connection.getBalance(pubkey, "confirmed")` → lamports (Solana web3.js — already a dep, used in `jupiter.ts`).
- `setInterval(..., N).unref()` — pattern already used in `worker/src/index.ts:88` for state tick. Copy that.
- `agent.emitter.on("result", (msg) => …)` — already wired in `worker/src/agent/loop.ts:205-211`. The autonomous tick gates on "turn idle" via this event.

**Anti-patterns to enforce in this plan:**
- ✗ Don't add a new agent decision module in `lib/` or `app/` — the agent brain stays in `worker/`.
- ✗ Don't add a second `query()` call. ONE long-lived session — inject via `injectActivityContext` / `injectUserMessage`.
- ✗ Don't poll the agent loop every tick — it must respect the in-flight turn (gate on `result` event or a `turnIdle` boolean).
- ✗ Don't trigger a market push when `agent.snapshot().phase === "TRADING"` — that races the in-flight trade.
- ✗ Don't push raw 50-token snapshots — top-N + concise schema, same pattern as `worker/src/memory/tick.ts:42-77`.
- ✗ Don't bypass `checkTradePolicy()` for exits. Position monitor calls the same tool surface (`submit_trade`).

---

## Phase 1 — Environment + secrets + one-command boot

### What to implement

1. **Generate + write secrets to `.env.local` and `worker/.env`** (both files; the worker reads `.env.worker` or its own `.env`, the Next.js side reads `.env.local`). The 1 SOL wallet private key (base58) will be in `.env.local` when the user lands — copy-extract it.

   `worker/.env` (gitignored — verify `.gitignore` already covers it; add if not):
   ```
   AGENT_SHARED_SECRET=<64-char hex from `openssl rand -hex 32`>
   AGENT_WALLET_PRIVATE_KEY_BASE58=<the 1-SOL wallet key the user dropped in>
   AGENT_WALLET_PUBLIC_KEY=<derived; can be left blank — tryGetPublicKey() will derive>
   ANTHROPIC_API_KEY=<existing claude-mem key OR new key>
   ANTHROPIC_MODEL=claude-sonnet-4-6
   SOLANA_NETWORK=mainnet-beta
   SOLANA_RPC_URL=<Helius/QuickNode/Triton mainnet URL — prompt user>
   AGENT_MAX_BUDGET_USD=5
   CLAUDE_PLUGIN_ROOT=/Users/alexnewman/.claude/plugins/cache/thedotmack/claude-mem/13.2.0
   CLAUDE_MEM_WORKER_PORT=<resolve via `node -e "console.log(37700 + (process.getuid()%100))"`>
   WORKER_PORT=7011
   WORKER_BIND=127.0.0.1
   MEMORY_TICK_MS=5000
   ```

   Append to `.env.local`:
   ```
   AGENT_WORKER_URL=http://127.0.0.1:7011
   AGENT_SHARED_SECRET=<same as worker/.env>
   ```
   **Do NOT** add `AGENT_WALLET_PRIVATE_KEY_BASE58` to `.env.local`. The Next.js process must never see it.

2. **Add `worker` to root `package.json` scripts** for one-command boot. Use `concurrently` if not present (check `node_modules` first; add as devDep if missing). Update root `package.json`:
   ```jsonc
   "scripts": {
     "dev": "concurrently -n web,worker -c cyan,magenta \"next dev -p 3010\" \"npm run dev:worker\"",
     "dev:web": "next dev -p 3010",
     "dev:worker": "cd worker && bun run --watch src/index.ts"
   }
   ```
   (If `bun` is not on `$PATH`, the user already has `worker/bun.lock` — verify with `which bun` first; fall back to `tsx` from worker's existing `@anthropic-ai/claude-agent-sdk` peers if needed.)

3. **Wire `KILL_SWITCH=1` env precedence** (BRIEF §7.4). Audit `worker/src/agent/tools/index.ts` and `worker/src/state.ts` — the `killSwitchRef.tripped` flag is set only by the `/kill` HTTP route and the `kill_switch` tool. Add a boot-time read: in `worker/src/index.ts` immediately after `killSwitchRef` creation, set `killSwitchRef.tripped = process.env.KILL_SWITCH === "1"` and log it.

### Documentation references

- `worker/src/config.ts` for the full zod schema and defaults; treat as the contract.
- `worker/src/index.ts:45-49` for kill-switch ref creation (insertion point).
- `app/api/agent/state/route.ts` for how `AGENT_WORKER_URL` + `AGENT_SHARED_SECRET` are consumed on the Next.js side.

### Verification checklist

```bash
# 1. Both env files present, gitignored.
test -f worker/.env && test -f .env.local
git check-ignore worker/.env .env.local   # both should print

# 2. Worker boots clean.
cd worker && bun run src/index.ts &
sleep 3
curl -s -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/healthz | jq
# expected: { "ok": true, "uptime": <n>, "sessionId": "pepe-agent-...", "walletPubkey": "..." }

# 3. Wallet pubkey logged on boot — copy it.
grep "wallet pubkey" worker/.scratch/boot.log

# 4. Verify the pubkey on-chain (mainnet) shows ~1 SOL.
solana balance <pubkey> --url $SOLANA_RPC_URL

# 5. KILL_SWITCH=1 boot blocks trades.
KILL_SWITCH=1 bun run src/index.ts &
curl -s -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/state | jq .killSwitch
# expected: true
```

### Anti-pattern guards

- ✗ Never write the private key to a file the worker logs to (`worker/src/trade/wallet.ts:5-9` already guards this — log pubkey only).
- ✗ Never put `AGENT_WALLET_PRIVATE_KEY_BASE58` in `.env.local`. The Next.js bundle has no business with it.
- ✗ Don't commit `worker/.env`. Add to `.gitignore` if not already.

---

## Phase 2 — Autonomous trading tick (the core missing piece)

This is the centerpiece. The agent loop today only fires on chat input. We add a periodic *market-push* loop that calls `injectActivityContext` with the latest snapshot **and**, on cadence, `injectUserMessage` with a decision prompt.

### What to implement

Create `worker/src/agent/auto-tick.ts`:

```ts
// COPY-FROM worker/src/memory/tick.ts:42-77 for the topN + counts/classifier pattern.
// COPY-FROM worker/src/agent/loop.ts:205-211 for the `result` event to know turn is idle.
import { EventEmitter } from "node:events";
import type { ActivitySubscriber, ActivityToken } from "../activity/subscriber.ts";
import type { AgentLoopHandle } from "./loop.ts";
import type { StateStore } from "../state.ts";
import { classifyMarket, countSignals } from "../activity/classify.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("agent.auto-tick");

export interface CreateAutoTickArgs {
  subscriber: ActivitySubscriber;
  agent: AgentLoopHandle;
  stateStore: StateStore;
  /** Default 15_000ms — market push cadence */
  pushIntervalMs?: number;
  /** Default 45_000ms — decision-prompt cadence (when phase==WATCHING) */
  decisionIntervalMs?: number;
}

export function startAutoTick(args: CreateAutoTickArgs): { stop: () => void } {
  const pushMs = args.pushIntervalMs ?? 15_000;
  const decisionMs = args.decisionIntervalMs ?? 45_000;

  // Track turn-idle via the loop's emitter (avoid stomping on in-flight turns).
  let turnIdle = true;
  args.agent.emitter.on("result", () => { turnIdle = true; });
  // First `assistantText` after an injection flips idle->busy.
  args.agent.emitter.on("assistantText", () => { turnIdle = false; });

  let lastDecisionAt = 0;
  let stopped = false;

  function pickTopN(snapshot: ActivityToken[], n: number): ActivityToken[] {
    // BRIEF §7.2 gates — pre-filter so the agent only sees plausible buys.
    return snapshot
      .filter((t) =>
        (t.fiveMinGain ?? 0) >= 0.15 &&            // ≥15% 5m gain
        (t.buyPressure5m ?? 0) >= 0.7 &&            // ≥0.7 buy pressure
        (t.liquidity ?? 0) >= 50_000 &&             // ≥$50k liquidity
        (t.updatesPerMinute ?? 0) >= 20             // ≥20 u/m
      )
      .sort((a, b) => (b.fiveMinGain ?? 0) - (a.fiveMinGain ?? 0))
      .slice(0, n);
  }

  const pushInterval = setInterval(() => {
    if (stopped) return;
    const phase = args.stateStore.snapshot().phase;
    if (phase === "TRADING" || phase === "CALLING") return; // never interrupt in-flight
    if (!turnIdle) return;

    const snap = args.subscriber.getSnapshot();
    if (snap.length === 0) return;

    const candidates = pickTopN(snap, 5);
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
    log.debug(`pushed market snapshot (${candidates.length} candidates, market=${market})`);

    const now = Date.now();
    if (now - lastDecisionAt >= decisionMs && candidates.length > 0) {
      lastDecisionAt = now;
      args.agent.injectUserMessage(
        "Market check. Based on the latest <market_snapshot> above and your memory:\n" +
        "- If any candidate meets your thesis bar, narrate your call and submit_trade.\n" +
        "- Otherwise narrate why you're passing and stay WATCHING.\n" +
        "Keep narration to 1-2 sentences."
      );
      log.info("forced decision turn (candidates available)");
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
```

Wire into `worker/src/index.ts` right after the existing `agent.start()` block (around line 110, after `log.info("agent loop started")`):

```ts
import { startAutoTick } from "./agent/auto-tick.ts";
// ...
const autoTick = agent ? startAutoTick({ subscriber, agent, stateStore }) : null;
// add to shutdown:
if (autoTick) autoTick.stop();
```

### Documentation references

- BRIEF §7.2 (the decision-loop rule set — `fiveMinGain ≥ 15%`, `buyPressure5m ≥ 0.7`, `liquidity ≥ $50k`, `updatesPerMinute ≥ 20`).
- `worker/src/agent/loop.ts:251-272` for `injectUserMessage` / `injectActivityContext` (don't reinvent).
- `worker/src/memory/tick.ts:42-77` for the snapshot-projection pattern (copy idea, not code — different schema).
- `worker/src/activity/classify.ts` for `classifyMarket` + `countSignals` (already used by memory tick).

### Verification checklist

```bash
# 1. Worker boots, logs include auto-tick.
grep -E "auto-tick|pushed market snapshot|forced decision turn" worker/.scratch/boot.log

# 2. Force a synthetic candidate via the existing mock harness OR observe live.
#    Within 45-60s of WS being LIVE you should see a forced decision turn.
curl -s -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/state | jq .phase
# expected: cycles WATCHING -> CALLING -> WATCHING when market has candidates

# 3. Verify CALLING never enters TRADING when KILL_SWITCH=1.
KILL_SWITCH=1 (re-boot) → forced decision still narrates but submit_trade is denied.
```

### Anti-pattern guards

- ✗ Don't push the snapshot if `phase === "TRADING" || "CALLING"`. Race city.
- ✗ Don't force a decision turn every push — that drowns the agent in tool-call latency. Decision cadence ≥ 30s.
- ✗ Don't bypass the existing pre-filter — the agent's context window is finite. 5 candidates max.
- ✗ Don't lower the BRIEF thresholds for "demo purposes." This is real money.

---

## Phase 3 — Position monitor (TP/SL/rug exits)

The autonomous loop above handles **entries**. BRIEF §7.2 also defines **exits**: TP at +30%, SL at −15%, rug detection at −50% in one tick. These require quoting open positions on a tick and pushing exit prompts to the agent.

### What to implement

Create `worker/src/agent/position-monitor.ts`:

```ts
// References:
//  - worker/src/trade/ledger.ts: openPositions() shape
//  - worker/src/trade/jupiter.ts: getQuote() signature
//  - BRIEF §7.2 exit rules
import type { TradeLedger } from "../trade/ledger.ts";
import type { AgentLoopHandle } from "./loop.ts";
import type { StateStore } from "../state.ts";
import { getQuote } from "../trade/jupiter.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("agent.position-monitor");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const POLL_MS = 10_000;            // BRIEF perf: <3s decision visibility; 10s quote cadence is fine for v1
const TP_GAIN = 0.30;
const SL_LOSS = -0.15;
const RUG_TICK = -0.50;            // single-tick drop

interface PriceMemo { price: number; ts: number }

export function startPositionMonitor(args: {
  ledger: TradeLedger;
  agent: AgentLoopHandle;
  stateStore: StateStore;
}): { stop: () => void } {
  const lastPrice = new Map<string, PriceMemo>();
  let stopped = false;

  const interval = setInterval(async () => {
    if (stopped) return;
    const positions = args.ledger.openPositions();
    if (positions.length === 0) return;
    const phase = args.stateStore.snapshot().phase;
    if (phase === "TRADING" || phase === "CALLING") return;

    for (const pos of positions) {
      try {
        // Quote 1 token unit → SOL to get a current price.
        const q = await getQuote({
          inputMint: pos.tokenId,
          outputMint: SOL_MINT,
          amount: "1000000",            // 1e6 atomic units — good enough for price estimate
          slippageBps: 100,
        });
        const currentPriceSol = Number(q.outAmount) / 1_000_000 / 1e9;
        const entry = pos.entryPrice;
        if (!entry || entry <= 0) continue;
        const pnl = (currentPriceSol - entry) / entry;

        const prev = lastPrice.get(pos.tokenId);
        const tickDrop = prev ? (currentPriceSol - prev.price) / prev.price : 0;
        lastPrice.set(pos.tokenId, { price: currentPriceSol, ts: Date.now() });

        let reason: string | null = null;
        if (tickDrop <= RUG_TICK) reason = `RUG — price dropped ${(tickDrop * 100).toFixed(0)}% in one tick. OUT.`;
        else if (pnl >= TP_GAIN) reason = `TP — +${(pnl * 100).toFixed(0)}%. Taking profit on $${pos.symbol}.`;
        else if (pnl <= SL_LOSS) reason = `SL — ${(pnl * 100).toFixed(0)}%. Cutting $${pos.symbol}.`;

        if (reason) {
          log.info(`exit signal for ${pos.symbol}: ${reason}`);
          args.agent.injectUserMessage(
            `Exit signal: ${reason}\n` +
            `Position: tokenId=${pos.tokenId}, sizeSol=${pos.sizeSol}.\n` +
            `Submit a sell now — use submit_trade with tokenIn=${pos.tokenId}, tokenOut=SOL.\n` +
            `Narrate the exit in one sentence.`
          );
          return; // one exit at a time — wait for turn to resolve
        }
      } catch (err) {
        log.warn(`quote failed for ${pos.tokenId}: ${String(err)}`);
      }
    }
  }, POLL_MS);
  if (typeof interval.unref === "function") interval.unref();

  return { stop: () => { stopped = true; clearInterval(interval); } };
}
```

Wire into `worker/src/index.ts` next to auto-tick:
```ts
import { startPositionMonitor } from "./agent/position-monitor.ts";
const positionMonitor = agent ? startPositionMonitor({ ledger, agent, stateStore }) : null;
// add to shutdown.
```

### Documentation references

- `worker/src/trade/ledger.ts` — `openPositions()` return shape (`tokenId, symbol, entryPrice, sizeSol, openedAt`).
- `worker/src/trade/jupiter.ts:50-75` — `getQuote()` signature.
- BRIEF §7.2 exit rules and §10 edge cases (rug + cooldown + cap exhaustion).
- `worker/src/agent/tools/index.ts:96-145` for the `submit_trade` semantics (sells go through the same gate; trade-policy must permit sells — verify `policy.ts` doesn't block based on `tokenIn !== SOL`; if it does, fix it in this phase).

### Verification checklist

```bash
# 1. With at least one open position (force one in devnet or wait for a buy),
#    confirm position-monitor logs.
grep "exit signal" worker/.scratch/boot.log

# 2. Force an exit by mocking ledger.openPositions() in a test, push a price
#    drop > TP, ensure submit_trade with tokenIn=<mint> tokenOut=SOL fires.

# 3. Confirm sells don't violate per-trade cap (sells are denominated in SOL
#    received — verify policy.ts treats `amountSol` as buy-side; sells should
#    pass amountSol = position.sizeSol).
```

### Anti-pattern guards

- ✗ Don't quote in a hot loop. 10s cadence; pause when `phase` is non-idle.
- ✗ Don't auto-execute exits from the monitor — push to the agent so narration + memory persist.
- ✗ Don't iterate all positions when one exit fires; let the turn resolve first (early-return).
- ✗ Don't poll Jupiter without backoff for unknown mints; catch + log + continue.

---

## Phase 4 — Real wallet balance + improved state surface

### What to implement

1. **Wallet-balance poll** — replace the hard-coded `walletSol: 0` in `worker/src/state.ts:85`.

   Add a polled balance:
   ```ts
   // worker/src/state.ts — add to CreateStateStoreArgs:
   //   balanceProvider?: () => number  // SOL float
   // Inside snapshot(): walletSol: balanceProvider?.() ?? 0,
   ```
   Wire from `worker/src/index.ts`:
   ```ts
   import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
   const rpc = new Connection(config.SOLANA_RPC_URL!, "confirmed");
   let walletSolCached = 0;
   if (walletPubkey) {
     const pubkey = new PublicKey(walletPubkey);
     const refreshBalance = async () => {
       try {
         const lamports = await rpc.getBalance(pubkey, "confirmed");
         walletSolCached = lamports / LAMPORTS_PER_SOL;
       } catch (err) { log.warn(`balance fetch failed: ${String(err)}`); }
     };
     await refreshBalance();
     const bal = setInterval(refreshBalance, 15_000);
     bal.unref();
   }
   // Pass to stateStore:
   const stateStore = createStateStore({
     ledger, killSwitchRef, contentSessionId: null, walletPubkey: walletPubkey ?? null,
     balanceProvider: () => walletSolCached,
   });
   ```

2. **Pnl from ledger** — `state.pnlUsd` is also hard-coded to 0. v1 acceptable to leave at 0 if SOL/USD price isn't readily available; if there's already a quote path, compute realised pnl from `ledger.closedPositions()` (check whether that method exists; if not, leave `pnlUsd: 0` and file as v1.1).

3. **TANK EMPTY narration** — BRIEF §7.4 + §10: when balance < 0.05 SOL the agent stops trading and narrates "TANK EMPTY". Add to `worker/src/trade/policy.ts:checkTradePolicy()`:
   ```ts
   // After kill-switch + wallet checks, before per-trade-cap:
   // (requires policy context to know current balance — add `walletSolBalance: () => number` to PolicyContext)
   if (ctx.walletSolBalance() < 0.05) return { allow: false, reason: "TANK EMPTY (wallet < 0.05 SOL)" };
   ```
   Wire in `worker/src/agent/loop.ts:90-95` (policyContext construction) to read from the same cached balance.

### Documentation references

- `worker/src/state.ts:60-95` for the snapshot shape — extend, don't replace.
- `worker/src/trade/policy.ts:31-44` for `PolicyContext` — add one new field.
- `@solana/web3.js` `Connection.getBalance` — already imported in `jupiter.ts`.

### Verification checklist

```bash
# 1. /state shows live walletSol matching `solana balance` within ±0.001.
curl -s -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/state | jq .walletSol

# 2. Drain the wallet to <0.05 SOL on devnet (transfer out), force a decision turn,
#    confirm submit_trade is denied with reason="TANK EMPTY".

# 3. Browser at localhost:3010 — dot-matrix board header shows live SOL float
#    matching on-chain balance (visual confirmation).
```

### Anti-pattern guards

- ✗ Don't fetch balance per `tick(now)` — that's 2 Hz × RPC = rate-limit. 15s is enough.
- ✗ Don't compute `pnlUsd` from a third-party price API without caching. v1 = 0 is acceptable.
- ✗ Don't add the balance check in only one of the three policy gates — `checkTradePolicy()` is called from all three sites (hook, canUseTool, handler). One edit covers all.

---

## Phase 5 — UI wiring: real worker state on the board, mainnet dogfood

### What to implement

1. **Verify the board polls worker state.** Check `app/page.tsx` for a `useEffect` that polls `/api/agent/state`. If absent (which is likely — chat & director pages exist but the old harness's poll loop may have been refactored away during the May 7 chat refactor), add one:
   ```tsx
   useEffect(() => {
     let cancelled = false;
     const tick = async () => {
       try {
         const res = await fetch("/api/agent/state", { cache: "no-store" });
         if (!res.ok) return;
         const data: AgentStateSnapshot = await res.json();
         if (!cancelled) setAgentState(data);   // wire into renderBoard via existing AgentStateSnapshot type
       } catch {}
     };
     tick();
     const id = setInterval(tick, 500);          // BRIEF §11 budget: dot-matrix at 60fps; 500ms state poll is invisible
     return () => { cancelled = true; clearInterval(id); };
   }, []);
   ```
   Pass `agentState.phase`, `agentState.walletSol`, `agentState.pnlUsd`, `agentState.feedStatus`, `agentState.selectedTokenId` into `renderBoard(...)`.

2. **Don't double-source the ticker.** The browser already runs `useActivityStream()` which connects to the same WS. That's fine for displaying *tokens*. But the dot-matrix board should display the agent's **selected** token (worker state, authoritative), not the browser's hover state.

3. **Final mainnet boot sequence** — after Phases 1-4 verify on devnet, switch:
   ```bash
   # worker/.env
   SOLANA_NETWORK=mainnet-beta
   SOLANA_RPC_URL=<mainnet Helius/QuickNode URL>
   # (wallet is already the 1-SOL mainnet wallet)
   ```
   First-day safety: per BRIEF §7.4 the caps are already 0.25/2.0/30s — those are fine for 1 SOL. **Do not lower.** They were designed for this.

### Documentation references

- `app/page.tsx` — find the existing `setStatus`, `setTranscript`, etc. effect block and add the poll near it.
- `app/api/agent/state/route.ts` — the proxy is already correct; nothing to change.
- `lib/dot-matrix/render-board.ts:RenderBoardOptions` — already accepts `selectedTokenId`, `walletSol`, `pnlUsd`, etc.

### Verification checklist

```bash
# 1. Boot both processes via `npm run dev`. Open localhost:3010.
# 2. Within 5s the board header shows the live wallet SOL.
# 3. Within 30s the feed status badge shows LIVE (assuming WS connects).
# 4. Within 1-2 minutes (assuming a candidate exists) the dot-matrix beam locks
#    onto a row matching the agent's selectedTokenId, bubble narrates CALLING,
#    a real on-chain Jupiter swap submits, ticker prepends a BUY line.
# 5. solscan https://solscan.io/account/<wallet> shows the matching txid.
```

### Anti-pattern guards

- ✗ Don't render `<div>` cards over the canvas to show agent state. The dot-matrix IS the UI.
- ✗ Don't switch the browser's WS off — it stays as the audience-side data feed, the worker has its own.
- ✗ Don't reduce poll cadence below 500ms — `state.tick(now)` runs at 500ms server-side, so anything faster sees the same data.

---

## Phase 6 — Final verification + audit

### Audit greps (zero results expected)

```bash
# No client-side private key references.
git grep -nE "AGENT_WALLET_PRIVATE_KEY" -- app/ components/ lib/
# No NEXT_PUBLIC_ agent secrets.
git grep -nE "NEXT_PUBLIC_(AGENT|WALLET|TRADE|JUPITER|ANTHROPIC)" -- .
# No bypass of checkTradePolicy — every sendRawTransaction must be downstream.
git grep -nE "sendRawTransaction|sendTransaction" -- worker/   # match must be in jupiter.ts only
# Custom tools only registered through createSdkMcpServer.
git grep -nE "options\.tools\s*=" -- worker/
# No alpha v2.
git grep -nE "unstable_v2_" -- worker/
# Wrong SDK package.
git grep -nE "@anthropic-ai/claude-code[^-]" -- worker/
```

### Functional verification (the end-state)

1. `npm run dev` → both processes up.
2. `curl /api/agent/state | jq` shows `feedStatus: "live"`, `walletSol > 0.9`, `killSwitch: false`, `phase: "WATCHING"`.
3. Open `http://localhost:3010` — board renders, ticker scrolls, Pepe blinks.
4. Within 5 minutes of strong market signal (or instantly if forced via chat: "look at the top tokens and call if any meet your thesis"):
   - Phase: `WATCHING → CALLING`
   - Bubble: thesis narration ("$X is coiled — I'm in 0.05 sol")
   - 2s later phase: `TRADING`, row flashes, header `walletSol` decrements.
   - Ticker prepends: `HH:MM ▲ BUY 0.05 SOL $X`
   - `solscan` of the agent's pubkey shows the swap.
5. Hold for ≥30 minutes:
   - At least one PASS narration (cap, cooldown, or thesis-fail).
   - At least one position-monitor exit if a TP or SL fires.
6. claude-mem query confirms persistence:
   ```bash
   curl "http://127.0.0.1:$CLAUDE_MEM_WORKER_PORT/api/search?query=trade-executed&project=Pepe-Agent&limit=5"
   ```
   Returns the executed trades.

### End-state success (the user's actual ask)

> *Pepe is trading live in the browser on the incoming data. He has a 1 SOL float. The board reflects his decisions. The viewer doesn't touch a wallet.*

This is achieved when Phases 1-5 verify cleanly. Total new code added by this plan: ~150 lines (`auto-tick.ts` + `position-monitor.ts` + the balance wiring in `index.ts` + the TANK-EMPTY policy line + the page.tsx state poll). Everything else already exists.

---

## Decision log (locked in by this plan)

| Question | Answer | Reason |
|---|---|---|
| Start mainnet directly with 1 SOL, or devnet first? | **Devnet 30-minute smoke (Phase 1-4 verify) THEN mainnet 1 SOL.** | The infra was built and tested already (PLAN-pepe-harness). The new code is Phase 2/3 which is testable on devnet without burning real SOL. |
| Push cadence? | 15s market push, 45s forced decision turn. | Below 15s drowns the agent in context; above 60s misses pumps. |
| Position-monitor cadence? | 10s. | BRIEF §11 says <3s decision-visible budget; 10s quote cadence + 10s detection latency = within budget. |
| Where does the autonomous loop live? | `worker/src/agent/auto-tick.ts` + `position-monitor.ts`. | Brain stays in worker; same boundary as everything else. |
| Browser state source? | `/api/agent/state` poll @ 500ms. | Same as PLAN-pepe-harness §5. SSE is a v1.1 upgrade if jank appears. |
| Pnl in v1? | Realised SOL P/L only (deferred). Header shows `walletSol` truth. | Avoids adding a price oracle dep on day 1. |
| TANK EMPTY threshold? | 0.05 SOL (from BRIEF §7.4). | Canon. |

---

## File-creation / edit order checklist

- [ ] **Phase 1** — write `worker/.env`, append to `.env.local`, verify `.gitignore`, add `concurrently` script to root `package.json`, add boot-time `KILL_SWITCH` read in `worker/src/index.ts`.
- [ ] **Phase 2** — create `worker/src/agent/auto-tick.ts`, wire into `worker/src/index.ts`.
- [ ] **Phase 3** — create `worker/src/agent/position-monitor.ts`, wire into `worker/src/index.ts`.
- [ ] **Phase 4** — extend `worker/src/state.ts` with `balanceProvider`, extend `worker/src/trade/policy.ts` with TANK-EMPTY check, wire balance poll in `worker/src/index.ts`.
- [ ] **Phase 5** — add state poll in `app/page.tsx`; switch to mainnet env after devnet verify.
- [ ] **Phase 6** — audit greps + functional verification only.
