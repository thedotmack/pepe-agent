# Pepe-Agent Trading Harness — Phased Implementation Plan

**Status:** plan only · **Owner:** Pepe-Agent · **Branch:** `feat/live-board`
**Goal:** Turn the existing live trading board into a production agentic trading system. The Claude Agent SDK runs the brain, claude-mem records memory in `meme-tokens` mode, the dot-matrix board reflects agent state, Pepe is the chat surface.

This plan is **executable phase by phase in fresh chat contexts**. Each phase is self-contained: copy-target files cited, verification steps spelled out, anti-patterns listed.

---

## Phase 0 — Documentation Discovery (read before starting any phase)

Phase 0 is the consolidated "Allowed APIs" reference. Every later phase cites lines from here. Do not invent APIs that aren't listed.

### A. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

**Pinned version reference:** claude-mem ships with `^0.2.119`; installed in claude-mem's `node_modules` is `0.2.126`. Pepe-Agent should pin `^0.2.126`.

**Authoritative type file:** `/Users/alexnewman/Scripts/claude-mem/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`. Read this before writing any agent code.

**Production caller to copy from:** `/Users/alexnewman/Scripts/claude-mem/.claude/worktrees/agent-a135126714b0709c6/src/services/worker/SDKAgent.ts:145-471`. This is the proven streaming-input loop.

**Allowed APIs:**

| What | API | Source |
|---|---|---|
| Long-lived agent | `query({ prompt: AsyncIterable<SDKUserMessage>, options })` returns `Query` (extends `AsyncGenerator<SDKMessage>`) | `sdk.d.ts:2225-2228` |
| Inject new context mid-session | Yield more `SDKUserMessage` from the same generator. Use `shouldQuery: false, isSynthetic: true` for context that should NOT force a turn. | `sdk.d.ts:3481-3500`; `SDKAgent.ts:391-400, 438-447` |
| Custom tools | `createSdkMcpServer({ name, version, tools, alwaysLoad })` + `tool(name, description, zodSchema, handler, extras)` | `sdk.d.ts:5377-5381, 421-435, 2954-2961` |
| Attach MCP servers (stdio/sse/http/sdk) | `Options.mcpServers: Record<string, McpServerConfig>` | `sdk.d.ts:1442, 961, 1050, 1039, 934, 945` |
| Live mutate MCP set | `Query.setMcpServers(servers)`, `Query.reconnectMcpServer(name)`, `Query.toggleMcpServer(name, enabled)` | `sdk.d.ts:2171-2201` |
| Per-call permission gate | `Options.canUseTool: (toolName, input, ctx) => Promise<PermissionResult>` returning `{ behavior: 'allow'|'deny'|'ask', updatedInput?, message? }` | `sdk.d.ts:146-188, 1191-1194` |
| Declarative event hooks | `Options.hooks: { PreToolUse: [{ matcher: 'submit_trade', hooks: [cb] }] }` callback returns `{ permissionDecision: 'allow'|'deny'|'ask'|'defer', permissionDecisionReason, updatedInput, additionalContext }` | `sdk.d.ts:721, 726-738, 1287-1299, 1957-1970` |
| Session resume | `Options.resume: <sessionId>` or `Options.continue: true`; pluggable `Options.sessionStore` | `sdk.d.ts:1196-1199, 1340, 1532-1547` |
| Auto-compaction | Default on. Hooks `PreCompact`, `PostCompact`. Read budget via `Query.getContextUsage()`. Hard caps `Options.maxTurns`, `maxBudgetUsd`, `taskBudget`. | `sdk.d.ts:721, 1879, 1951, 2109, 1409-1427, 2356-2375` |

**Anti-patterns (from sdk.d.ts):**
- ✗ Don't pass a plain string as `prompt:` — that's one-shot.
- ✗ Don't use `@anthropic-ai/claude-code` — wrong package; use `@anthropic-ai/claude-agent-sdk`.
- ✗ Don't put custom tools on `Options.tools:` — that's for built-in tool selection. Custom tools MUST go through `createSdkMcpServer` + `mcpServers`.
- ✗ Don't rely on deprecated `maxThinkingTokens`. Use `Options.thinking: { type: 'enabled' | 'adaptive' }`.
- ✗ Don't use the alpha v2 (`unstable_v2_createSession`) for production. Use v1 streaming-input pattern.

### B. claude-mem ingestion + read APIs

**Authoritative sources:**
- HTTP route definitions: `/Users/alexnewman/Scripts/claude-mem/src/services/worker/http/routes/SessionRoutes.ts:180, 185-216, 225-262, 330-475`
- Ingest core: `/Users/alexnewman/Scripts/claude-mem/src/services/worker/http/shared.ts:97-182` (`ingestObservation`)
- CLI handler shape (mirror this): `/Users/alexnewman/Scripts/claude-mem/src/cli/handlers/observation.ts:30-45` and `/.../session-init.ts:54-63`
- MCP tools: `/Users/alexnewman/Scripts/claude-mem/src/servers/mcp-server.ts:183-495`
- Mode loader: `/Users/alexnewman/Scripts/claude-mem/src/services/domain/ModeManager.ts:13-23, 81-90`
- Worker URL: `/Users/alexnewman/Scripts/claude-mem/src/shared/worker-utils.ts:42-71` (port = `37700 + uid%100`)
- Project name resolution: `/Users/alexnewman/Scripts/claude-mem/src/utils/project-name.ts:48-69` (basename of cwd)
- Mode JSON: `/Users/alexnewman/Scripts/claude-mem/plugin/modes/meme-tokens.json` (already authored, locked schema)

**Allowed endpoints (claude-mem worker, default `http://127.0.0.1:<37700+uid%100>`):**

| What | Method + path | Body | Source |
|---|---|---|---|
| Init session | `POST /api/sessions/init` | `{contentSessionId, project, prompt, platformSource}` | `SessionRoutes.ts:330-475` |
| Emit observation | `POST /api/sessions/observations` | `{contentSessionId, tool_name, tool_input, tool_response, cwd, platformSource?, agentId?, agentType?, tool_use_id?}` | `SessionRoutes.ts:185-216` |
| Summarize / close session | `POST /api/sessions/summarize` | `{contentSessionId}` | `SessionRoutes.ts` |
| Search | `GET /api/search?query=...&project=Pepe-Agent` | — | `SearchRoutes.ts:103` |
| Get by ids | `POST /api/observations/batch` | `{ids:number[], orderBy?, limit?, project?}` | `DataRoutes.ts:88, 162` |
| Build / prime / query corpus (RAG) | `POST /api/corpus`, `POST /api/corpus/{name}/prime`, `POST /api/corpus/{name}/query` | per `mcp-server.ts:391-494` | — |

**Mode switch:** Write `{"CLAUDE_MEM_MODE":"meme-tokens"}` into `~/.claude-mem/settings.json`. The worker reads it once at boot (`worker-service.ts:309-313`). Restart claude-mem worker after change. Mode is **process-global**, not per-request.

**MCP attach (preferred for the agent's read path):**
```ts
// Inside the Pepe-Agent worker passing Options to query()
mcpServers: {
  'mcp-search': {
    type: 'stdio',
    command: 'bun',
    args: [`${process.env.CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.cjs`],
  },
}
```
Reference: `/Users/alexnewman/Scripts/claude-mem/plugin/.mcp.json`. The MCP server's tools (`search`, `timeline`, `get_observations`, `query_corpus`, `prime_corpus`, `build_corpus`, etc.) are documented at `mcp-server.ts:219-494`.

**Anti-patterns:**
- ✗ Don't try to send pre-formed `<observed_from_primary_session>` XML. The worker builds it from the raw fields (`prompts.ts:81-113`).
- ✗ Don't use the `./sdk` exported subpath of claude-mem expecting query helpers — it only exposes prompt builders. Use HTTP or MCP for reads.
- ✗ Don't try per-request mode switching — `CLAUDE_MEM_MODE` is set once at worker boot.
- ✗ Don't expect Claude-Code-specific session magic at the HTTP boundary. The `contentSessionId` is just any string. Mint one for the worker (e.g. `pepe-agent-<uuid>`).

### C. Meridian — optional cost layer

**Verdict:** Optional. Useful only if you want to back the agent with a Claude Max subscription instead of paying API. Not core architecture.

- Sources: `https://github.com/rynfar/meridian` (README, package.json, `src/proxy/server.ts`)
- It's a local HTTP proxy on `127.0.0.1:3456` that bridges the Claude Code SDK to the Anthropic API protocol.
- Integration: `npm i -g @rynfar/meridian` → `claude login` → `meridian` → set `ANTHROPIC_BASE_URL=http://127.0.0.1:3456` for the Pepe-Agent worker.
- Defer to Phase 8.

### D. 21st-sdk — skipped

**Verdict:** Skip. Their `agent-runtime` is private/cloud-only ("`packages/agent-runtime` is private and should never be in the public repo"). Adopting them means handing the Claude Agent SDK loop to E2B sandboxes hosted by 21st.dev. Conflicts with custodial-wallet-on-our-server requirement and with our custom dot-matrix UI. The public packages (`@21st-sdk/react`, `/node`, `/nextjs`) are a chat-UI client for their relay, not a self-hostable runtime.

If a future phase needs a drop-in chat UI, revisit — but our PepeHead + dot-matrix chat strip already solve that.

### E. Pepe-Agent current-state inventory (don't recreate what exists)

| Already in `feat/live-board` | Path |
|---|---|
| ElevenLabs voice + text wrapper | `lib/agent.ts` (PepeAgent class: `start({textOnly?})`, `sendUserMessage`, `sendUserActivity`, `stop`, `isActive`) |
| Live activity stream (Zustand) | `lib/activity/{activity-store,activity-websocket,use-activity-stream}.ts` |
| Dot-matrix renderer | `lib/dot-matrix/{render-board,dot-matrix-ui-kit}.tsx` |
| Token feed (verified live) | `wss://api.memedeck.win/activity` + REST fallback |
| Agent token signed-URL route | `app/api/agent-token/route.ts` |
| `RenderBoardOptions` already has | `chat?: ChatLogEntry[]`, `draft?`, `cursorOn?`, `transcript?`, `pepeIsSpeaking`, `selectedTokenId`, `walletSol?`, `pnlUsd?`, `layout?` |
| Page deps | `@elevenlabs/client@^1.4.0`, `zustand@^5`, `ws@^8` |

| Missing per BRIEF spec |
|---|
| `worker/` (separate Node process — does not yet exist) |
| `lib/agent/loop.ts` |
| `lib/agent/trade-policy.ts` |
| `app/api/agent/{trade,state,chat}/route.ts` |
| `@anthropic-ai/claude-agent-sdk`, `@solana/web3.js`, `bs58` deps |
| Env vars: `AGENT_WALLET_PRIVATE_KEY_BASE58`, `AGENT_WALLET_PUBLIC_KEY`, `MEMEDECK_JUPITER_PROXY_URL`, `CLAUDE_MEM_WORKER_PORT`, `CLAUDE_MEM_PLUGIN_ROOT`, `AGENT_SHARED_SECRET` |

### F. Architectural decisions (locked-in by Phase 0)

1. **Two-process architecture.** Pepe-Agent stays as the Next.js UI (renders dot-matrix board, hosts `/api/*` chat & state proxies). A new sibling **`worker/`** directory holds a long-lived Node process running the Claude Agent SDK loop, the activity WS subscriber, and the trade-policy + Jupiter swap logic. Justification: Vercel functions can't hold a persistent WS or a custodial keypair safely; the SDK's streaming-input pattern is built for long-running processes.
2. **claude-mem runs as its own daemon** (already does, port `37700+uid%100`). The Pepe-Agent worker writes observations to it via HTTP and reads memory back via MCP stdio attached to the agent's `Options.mcpServers`.
3. **Trade policy is the only writer of trade state.** Enforced twice (defense in depth): (a) declared in `Options.hooks.PreToolUse[matcher='submit_trade']` and (b) called again inside the `submit_trade` tool handler before any RPC call.
4. **No client-side wallet.** Custodial server keypair only. Browser is read-only; chat goes through `/api/agent/chat` → worker via shared secret.
5. **Skip 21st-sdk.** Defer Meridian to Phase 8.
6. **Use SDK v1 (`query()` async-iterable), not v2 alpha.** Production-tested in claude-mem.

---

## Phase 1 — Worker scaffold + dependency floor

### What to implement

Create a sibling worker process inside the same repo, layout:

```
worker/
  package.json          # separate package, runs on Bun (matches claude-mem's launcher)
  tsconfig.json
  src/
    index.ts            # entrypoint: boots all subsystems
    config.ts           # env var loader (refuse to start if any missing in prod)
    logger.ts           # tagged structured logger
    rpc/
      worker-server.ts  # HTTP server for Next.js to call (on 127.0.0.1:7011)
.env.worker.example     # AGENT_WALLET_PRIVATE_KEY_BASE58, AGENT_WALLET_PUBLIC_KEY,
                        # MEMEDECK_JUPITER_PROXY_URL, AGENT_SHARED_SECRET,
                        # CLAUDE_MEM_PLUGIN_ROOT, CLAUDE_MEM_WORKER_PORT,
                        # ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL?,
                        # SOLANA_RPC_URL, SOLANA_NETWORK=devnet
```

`worker/package.json` deps to install:
- `@anthropic-ai/claude-agent-sdk@^0.2.126`
- `zod@^4` (peer of the SDK)
- `ws@^8`
- `@solana/web3.js@^1`
- `bs58@^6`
- `hono@^4` + `@hono/node-server` (HTTP server, matches Meridian/claude-mem stack)
- `bun-types` (dev)

Also add `@anthropic-ai/claude-agent-sdk@^0.2.126` and `zod@^4` to the root `package.json` dev deps so `app/api/agent/chat/route.ts` can use the SDK types when proxying.

`worker/src/rpc/worker-server.ts` exposes (auth via `x-agent-secret: ${AGENT_SHARED_SECRET}`):
- `GET  /healthz` → `{ ok: true, uptime, sessionId, walletPubkey }`
- `GET  /state` → see Phase 5 shape
- `POST /chat` → see Phase 6
- `POST /kill` → flips kill switch (gates submit_trade), returns `{ killed: true }`

### Documentation references

- Bun-with-Hono pattern: claude-mem's `plugin/scripts/worker-service.cjs` (entry shape).
- Env loading: any zod-based loader. Use claude-mem's `src/shared/EnvManager.ts` as a style reference.
- The existing Pepe-Agent `next.config.mjs` already allows `*.ts.net`, `*.ngrok-free.dev` etc. — leave alone.

### Verification checklist

```bash
cd worker && bun install
bun run src/index.ts          # boots, logs subsystems initializing in order
curl -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/healthz
# Expected: { "ok": true, "uptime": <ms>, "sessionId": null, "walletPubkey": "..." }
```

### Anti-patterns

- ✗ Don't put the worker code inside Next.js `app/` or `lib/` — it must be a separate process.
- ✗ Don't reference `AGENT_WALLET_PRIVATE_KEY_BASE58` from anywhere reachable by the browser. The Next.js side never gets the key.
- ✗ Don't allow the worker HTTP to bind to `0.0.0.0` — bind `127.0.0.1` only. Tunnels go through Next.js.
- ✗ Don't add `NEXT_PUBLIC_*` env vars for any agent secret.

---

## Phase 2 — Activity stream subscriber + claude-mem observation feed

### What to implement

Two subsystems in `worker/src/`:

1. `activity/subscriber.ts`
   - Connect `wss://api.memedeck.win/activity` (mirror logic from `lib/activity/activity-websocket.ts` — copy the singleton + reconnect + REST fallback pattern verbatim, just port to Node `ws`).
   - Maintain in-memory `tokens: Map<tokenId, ActivityToken>`, last-update timestamp, connection state.
   - Throttle outbound updates to 1 Hz (matches existing `THROTTLE_DELAY = 1000`).
   - Emit each batch on a Node `EventEmitter` so other subsystems subscribe.

2. `memory/claude-mem-client.ts`
   - HTTP client for the claude-mem worker. URL = `http://127.0.0.1:${CLAUDE_MEM_WORKER_PORT}`.
   - `initSession({ contentSessionId, project, prompt, platformSource })` → `POST /api/sessions/init`
   - `recordObservation({ contentSessionId, tool_name, tool_input, tool_response, cwd })` → `POST /api/sessions/observations`
   - `summarize({ contentSessionId })` → `POST /api/sessions/summarize`
   - All bodies match the shapes documented in Phase 0.B.
   - On boot, init a session: `contentSessionId = "pepe-agent-" + uuid`, `project = "Pepe-Agent"`, `cwd = path.resolve(process.cwd(), "..")` (so claude-mem resolves to project name "Pepe-Agent").

3. Wire subscriber → memory:
   - Every 5 seconds (configurable `MEMORY_TICK_MS`), compute a snapshot: top 10 tokens by U/m + signal mix + market state. Repurpose claude-mem's tool fields:
     ```ts
     await mem.recordObservation({
       contentSessionId,
       tool_name: 'token-snapshot',
       tool_input: JSON.stringify({ mode: 'meme-tokens', tick: tickN, top: top10.map(t => ({sym:t.symbol, ump:t.updatesPerMinute, sig:t.signal, g5:t.fiveMinGain, bp:t.buyPressure5m, pool:t.liquidity})) }),
       tool_response: JSON.stringify({ marketCondition: classifyMarket(snapshot), strongCount, risingCount, watchCount, flatCount }),
       cwd: WORKING_DIR,
     });
     ```
   - The `meme-tokens.json` mode prompt instructs the observer to read `<observed_from_primary_session>` and emit pump/dump observations. claude-mem will receive these snapshots, run them through its observer LLM with the `meme-tokens` mode prompts, and persist structured `<observation>` rows in `~/.claude-mem/claude-mem.db`.

### Documentation references

- Browser activity WS to copy: `lib/activity/activity-websocket.ts` (singleton, reconnect, REST fallback, throttled updates).
- claude-mem HTTP shapes: Phase 0.B table.
- Mode prompts (so you understand the schema being recorded): `plugin/modes/meme-tokens.json` types `pump-detected | dump-detected | signal-change | token-profile | market-condition | algorithm-insight`, concepts `early-detection | lifecycle | false-signal | whale-activity | repeat-pumper | dead-cat-bounce | sustained-momentum`.

### Verification checklist

1. With `~/.claude-mem/settings.json` set to `{"CLAUDE_MEM_MODE":"meme-tokens"}` and the claude-mem worker restarted:
   ```bash
   curl http://127.0.0.1:$CLAUDE_MEM_WORKER_PORT/healthz   # claude-mem worker is up
   ```
2. Boot the Pepe-Agent worker. Watch logs:
   - `[activity] connected wss://api.memedeck.win/activity`
   - `[memory] session initialized pepe-agent-<uuid>`
   - `[memory] tick 1 → recorded snapshot (top: PEPTM, YIPPEE, ...)` every 5s
3. Wait 60s, then query claude-mem for new observations:
   ```bash
   curl "http://127.0.0.1:$CLAUDE_MEM_WORKER_PORT/api/search?query=pump&project=Pepe-Agent&limit=5"
   ```
   Expected: ≥1 observation with `type` in the `meme-tokens` enum (`pump-detected`, etc.).
4. Verify mode is active by checking the observation's structure matches the `meme-tokens.json` schema (concepts in the canonical 7).

### Anti-patterns

- ✗ Don't attempt to bypass claude-mem's `buildObservationPrompt` by sending pre-formed XML. Send raw fields.
- ✗ Don't ingest every WS message — that floods the observer LLM. Throttle to a 5-10s digest.
- ✗ Don't share the `contentSessionId` across worker restarts. Mint fresh on cold boot, fork via claude-mem's `forkSession` if you want continuity.
- ✗ Don't run the worker without setting `CLAUDE_MEM_MODE=meme-tokens` first — the default `code` mode will produce useless observations.

---

## Phase 3 — Claude Agent SDK loop with custom + claude-mem MCP tools

### What to implement

`worker/src/agent/loop.ts`:

1. Build the streaming-input message generator:
   ```ts
   // COPY-FROM: SDKAgent.ts:145-170 (claude-mem worktree path in Phase 0)
   async function* messageGenerator(): AsyncIterableIterator<SDKUserMessage> {
     yield { type: 'user', message: { role: 'user', content: SYSTEM_PROMPT }, parent_tool_use_id: null };
     for await (const evt of contextStream) {  // EventEmitter from Phase 2 + chat msgs from Phase 6
       yield evt;  // each evt is a properly-shaped SDKUserMessage
     }
   }
   ```

2. Construct `Options` with:
   - `mcpServers`:
     - `'mcp-search'`: `{ type: 'stdio', command: 'bun', args: [`${process.env.CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.cjs`] }` — gives the agent `search`, `timeline`, `get_observations`, `query_corpus`, `prime_corpus` for free.
     - `'pepe'`: `createSdkMcpServer({ name: 'pepe', tools: [...customTools] })` (see tool list below).
   - `hooks.PreToolUse`: `[{ matcher: 'mcp__pepe__submit_trade', hooks: [tradePolicyHook] }]` — the hook calls `worker/src/trade/policy.ts` (Phase 4) and returns `{ permissionDecision: 'allow'|'deny', permissionDecisionReason }`.
   - `canUseTool`: secondary gate that also calls the trade-policy module (defense in depth).
   - `persistSession: true`, `sessionStore: customStore` (write transcripts to `worker/.sessions/`).
   - `maxBudgetUsd`: e.g. `5` for dev, configurable.
   - `thinking: { type: 'adaptive' }`.

3. Custom tools registered via `createSdkMcpServer`:

   | Tool | Purpose | Input zod schema | Returns |
   |---|---|---|---|
   | `get_top_tokens` | Read in-memory snapshot from Phase 2 subscriber | `{ limit?: number, signal?: 'STRONG'\|'RISING'\|'WATCH'\|'FLAT' }` | array of `ActivityToken` |
   | `get_open_positions` | Read positions ledger (Phase 4) | `{}` | array `{ tokenId, symbol, entryPrice, sizeSol, openedAt }` |
   | `get_quote` | Jupiter quote (Phase 4) | `{ tokenIn: string, tokenOut: string, amount: string, slippageBps?: number }` | quote response |
   | `submit_trade` | Sign + submit (Phase 4 — gated) | `{ tokenIn, tokenOut, amountSol, slippageBps?, reason: string }` | `{ txid, status, executedPrice }` |
   | `mark_position` | Manually open/close in ledger (e.g. on exit decision) | `{ tokenId, action: 'open'\|'close', reason }` | `{ ok: true }` |
   | `kill_switch` | Trips the global kill flag | `{ reason }` | `{ killed: true }` |

   `query_memory` is **not** a custom tool — the agent uses claude-mem's MCP `search` / `get_observations` directly via the attached `mcp-search` server. Document in the system prompt: "use `mcp__mcp-search__search` to find prior observations about a token before deciding."

4. Drive loop:
   ```ts
   const queryResult = query({ prompt: messageGenerator, options });
   for await (const message of queryResult) {
     // route SDKMessage to logger / state.ts (Phase 5) / chat bridge (Phase 6)
   }
   ```

5. System prompt for the agent: encode the BRIEF state machine (`IDLE → WATCHING → CALLING (2s delay) → TRADING`), the trade caps, and the directive: "Before deciding to BUY a token, call `mcp__mcp-search__search` for prior observations about that symbol. If you find a `dump-detected` or `false-signal` observation in the last 24h, default to PASS."

### Documentation references

- Streaming-input pattern: `SDKAgent.ts:145-170, 365-471` (claude-mem worktree).
- Tool registration: `sdk.d.ts:5377-5381, 421-435, 2954-2961`.
- MCP attach: `sdk.d.ts:1442` + `plugin/.mcp.json` of claude-mem.
- Hooks: `sdk.d.ts:721, 1287-1299, 1957-1970`.
- claude-mem MCP tool surface (so we know what's auto-exposed): `mcp-server.ts:219-494`.

### Verification checklist

1. Boot worker. Logs show:
   - `[agent] mcp servers connected: mcp-search, pepe`
   - `[agent] tools available: 6 (custom) + N (mcp-search)` (N ≈ 9)
2. Manually inject a `getContextUsage` log every 30s — verify auto-compaction events log `[agent] PreCompact triggered (...)` cleanly.
3. From an interactive REPL or a test script, send a synthetic chat message:
   ```ts
   contextStream.emit('user', { type: 'user', message: { role: 'user', content: 'list top 3 tokens' }, parent_tool_use_id: null });
   ```
   Expect agent to call `mcp__pepe__get_top_tokens` and respond. No `submit_trade` call should fire.
4. Send "buy MOG 0.1 sol" — expect `submit_trade` to be **denied** by the hook (Phase 4 not yet shipped) with reason like "trade-policy not configured".

### Anti-patterns

- ✗ Don't put trade-policy logic inside the tool handler — it must be in `worker/src/trade/policy.ts` and called from BOTH the hook and the handler.
- ✗ Don't pass `tools:` array on `Options` for custom tools. They go through `mcpServers`.
- ✗ Don't enable `unstable_v2_*` APIs.
- ✗ Don't hardcode `CLAUDE_PLUGIN_ROOT` — read from env. (Default to claude-mem's `getPackageRoot()` if unset; document the resolution.)
- ✗ Don't omit `parent_tool_use_id` on injected `SDKUserMessage` (use `null` for top-level).

---

## Phase 4 — Trade policy + custodial wallet + Jupiter integration (devnet first)

### What to implement

Three modules:

1. `worker/src/trade/policy.ts` — single source of truth.
   ```ts
   export type TradeIntent = { tokenIn: string; tokenOut: string; amountSol: number; slippageBps: number; reason: string };
   export type PolicyResult = { allow: true } | { allow: false; reason: string };
   export function checkTradePolicy(intent: TradeIntent, ledger: TradeLedger, killSwitch: boolean): PolicyResult;
   ```
   Caps from `BRIEF-pepe-hq.md` (already canon):
   - per-trade ≤ `0.25 SOL`
   - daily total ≤ `2.0 SOL`
   - cooldown ≥ `30s` since last trade
   - ≤ `5` open positions
   - default `slippageBps = 100`, hard ceiling `slippageBps ≤ 300`
   - kill switch tripped ⇒ deny

2. `worker/src/trade/ledger.ts` — local SQLite (`better-sqlite3`) at `worker/.data/trades.db`. Tables: `trades(id, ts, tokenId, side, amountSol, txid, executedPrice)`, `positions(tokenId, entryPrice, sizeSol, openedAt, closedAt?)`. Used by `get_open_positions`, `mark_position`, and the policy check.

3. `worker/src/trade/wallet.ts` + `worker/src/trade/jupiter.ts`:
   - **wallet.ts**: load `AGENT_WALLET_PRIVATE_KEY_BASE58`, decode with `bs58`, build `Keypair.fromSecretKey(...)`. Expose `getKeypair()` + `getPublicKey()`.
   - **jupiter.ts**:
     - `getQuote({ tokenIn, tokenOut, amount, slippageBps })` → fetch `https://lite-api.jup.ag/swap/v1/quote?inputMint=...&outputMint=...&amount=...&slippageBps=...`. (Jupiter Lite API is the public free tier — confirm from Jupiter docs at execution time. If using Pro / Ultra, swap to that base URL.)
     - `submitSwap({ quote, userPublicKey })` → `POST https://lite-api.jup.ag/swap/v1/swap` body `{ quoteResponse, userPublicKey, wrapAndUnwrapSol: true }`. Receives `{ swapTransaction }` (base64 versioned tx).
     - Sign locally with the keypair (`VersionedTransaction.deserialize` → `tx.sign([keypair])` → serialize → `connection.sendRawTransaction`).
     - Confirm with `connection.confirmTransaction` using `confirmation: 'confirmed'`.

4. The `submit_trade` tool handler (Phase 3, now wired):
   ```ts
   async (args) => {
     // (1) policy gate (defense in depth — hook also called this)
     const result = checkTradePolicy(args, ledger, killSwitch);
     if (!result.allow) return { content: [{ type: 'text', text: `denied: ${result.reason}` }], isError: true };
     // (2) quote
     const quote = await jupiter.getQuote(args);
     // (3) submit
     const { swapTransaction } = await jupiter.submitSwap({ quote, userPublicKey });
     const txid = await jupiter.signAndSend(swapTransaction);
     // (4) record
     ledger.recordTrade({ ... });
     // (5) record decision in claude-mem (so future runs see it)
     await mem.recordObservation({ tool_name: 'trade-executed', tool_input: JSON.stringify(args), tool_response: JSON.stringify({ txid, executedPrice }) });
     return { content: [{ type: 'text', text: `executed ${txid}` }] };
   }
   ```

### Documentation references

- Caps: `BRIEF-pepe-hq.md` (committed in repo).
- Solana sign-and-send pattern: official `@solana/web3.js` docs (`VersionedTransaction`, `Connection.sendRawTransaction`).
- Jupiter Swap API: https://dev.jup.ag/docs/swap-api/quick-start (read this before phase start; URLs above are illustrative — verify current Lite/Pro split).
- bs58 secret key handling: https://docs.solana.com/developing/clients/javascript-api#creating-a-keypair (if using base58 export from Phantom/sollet, `bs58.decode(s)` returns the 64-byte `secretKey`).

### Verification checklist (devnet)

1. Set `SOLANA_NETWORK=devnet`, `SOLANA_RPC_URL=https://api.devnet.solana.com`, fund the agent wallet with ~0.5 devnet SOL via `solana airdrop` or a faucet.
2. End-to-end: from a test script, ask the agent to "buy 0.05 sol of $BONK_DEVNET" (use a known devnet pump-fun token).
   - Hook fires → policy returns `allow: true`.
   - Tool runs → quote fetched, swap submitted → returns txid.
   - `solana confirm <txid> -u devnet` → confirmed.
3. Cap tests:
   - Try 0.5 SOL → denied (per-trade cap).
   - Try 5 trades of 0.05 SOL within 30s → 4th denied (cooldown).
   - Set kill switch → next trade denied.
4. Confirm `~/.claude-mem/claude-mem.db` has new observation rows tagged `trade-executed`.

### Anti-patterns

- ✗ Don't sign on the client. Ever.
- ✗ Don't bypass `checkTradePolicy()` — it must run twice (hook + handler) to be defense-in-depth.
- ✗ Don't store the keypair in any file the worker logs / dumps to disk in plaintext.
- ✗ Don't use a hardcoded slippage > 300 bps.
- ✗ Don't run mainnet until devnet verification passes (Phase 7).

---

## Phase 5 — State API + dot-matrix paint mode wiring

### What to implement

1. `worker/src/state.ts` (in-memory, exposed by `worker-server.ts`):
   ```ts
   type AgentState = {
     phase: 'IDLE' | 'WATCHING' | 'CALLING' | 'TRADING';
     selectedTokenId: string | null;
     callingSinceMs: number | null;     // when CALLING began (for 2s delay UI)
     walletSol: number;
     pnlUsd: number;
     openPositions: number;
     killSwitch: boolean;
     feedStatus: 'live'|'stale'|'reconnecting'|'rest-fallback'|'connecting';
     lastDecisionLog: { ts:number; symbol:string; action:'BUY'|'PASS'|'SELL'; reason:string }[];
   };
   ```
   The agent loop transitions phase based on its own messages: detect `submit_trade` tool call → `TRADING`; when the model says "calling $X" or selects a token → `CALLING` with `callingSinceMs = now`; idle for 5s → `WATCHING`; any error → `IDLE`.

2. `app/api/agent/state/route.ts` (Next.js):
   - `GET` proxies to `http://127.0.0.1:7011/state` with the shared secret.
   - Returns the same JSON.

3. `lib/dot-matrix/render-board.ts` extension:
   - Add `agentPhase?: 'IDLE'|'WATCHING'|'CALLING'|'TRADING'` to `RenderBoardOptions`.
   - In `renderDesktop` / `renderMobile`: add an `AGENT` badge near the status badge that shows the phase; when `TRADING` flash the active row amber; when `CALLING` brighten the beam and show countdown dots above the bubble.

4. `app/page.tsx`: poll `/api/agent/state` every 500ms (or upgrade to SSE). Pass `agentPhase` + `walletSol` + `pnlUsd` + `feedStatus` (from worker, not the browser-side store, so the dot-matrix reflects the agent's truth) into `renderBoard`.

### Documentation references

- Existing renderBoard prop wiring: `lib/dot-matrix/render-board.ts` already accepts `walletSol`, `pnlUsd`, `selectedTokenId`, `pepeIsSpeaking`, `transcript`. Pattern is established — copy.
- BRIEF state machine: `BRIEF-pepe-hq.md`.

### Verification checklist

1. Start worker. `curl http://127.0.0.1:3010/api/agent/state` returns 200 with the shape above.
2. Open browser at desktop width. The status header now shows `AGENT IDLE`. Trigger a chat → phase flips to `CALLING` for 2s → `TRADING` flash → `WATCHING`. All visible on the board.
3. Trip kill switch via worker `/kill` → AGENT badge shows `STOPPED` (amber).

### Anti-patterns

- ✗ Don't compute the phase in the browser. It's authoritative on the worker.
- ✗ Don't poll faster than 500ms — wasteful. Switch to SSE if jank is noticed.
- ✗ Don't add new HTML panels to the page. Phase-related UI lives on the dot-matrix canvas only.

---

## Phase 6 — Pepe chat ↔ Agent SDK bridge (text + voice)

### What to implement

1. `app/api/agent/chat/route.ts` (Next.js): SSE endpoint.
   - `POST /api/agent/chat` body `{ text }` → forwards to worker `POST /chat` with shared secret.
   - Worker injects `{ type:'user', message:{role:'user', content: text}, parent_tool_use_id: null, shouldQuery: true }` into the streaming-input generator.
   - Agent's resulting `SDKAssistantMessage` events (text-content blocks) are streamed back as SSE `event: chunk\ndata: <json>` until end-of-turn.

2. `lib/agent.ts` (browser PepeAgent): add a parallel path for **text mode** that, instead of going through ElevenLabs `Conversation`, opens an `EventSource` to `/api/agent/chat`. ElevenLabs voice mode stays as-is, but its `onMessage` hand-off ALSO posts the user's transcript to `/api/agent/chat` and forwards the agent's response text to ElevenLabs TTS (or back to the dot-matrix log).
   - Decision: voice path uses ElevenLabs for STT only; the LLM is **always** the Claude Agent SDK loop on our worker. ElevenLabs is the microphone + speaker, not the brain.

3. The dot-matrix chat log already renders `chat: ChatLogEntry[]` — feed it from this stream.

### Documentation references

- Streaming input mechanics for `query()`: `sdk.d.ts:3481-3500`, `Query.streamInput()` `sdk.d.ts:2208`.
- Existing PepeAgent voice integration to extend: `lib/agent.ts`.
- ElevenLabs `onTranscript` callback (current code) — re-route into `/api/agent/chat` instead of letting ElevenLabs's own LLM respond.

### Verification checklist

1. Open the page. Type "what's hot right now" in the chat input. Within 3s, the dot-matrix chat log shows the user message and Pepe's reply pulled from `mcp__pepe__get_top_tokens`.
2. Double-click Pepe to start voice. Say "buy 0.1 sol of MOG". Within 3s the agent's response narrates the decision; if devnet is configured (Phase 7) the trade fires.
3. While the agent is mid-thought, send a second message — the streaming-input generator must not block; the second message is queued and processed.

### Anti-patterns

- ✗ Don't leave ElevenLabs as the LLM. The brain is on our worker; ElevenLabs is voice I/O only.
- ✗ Don't open multiple `query()` calls. There's exactly ONE long-lived agent session per worker.
- ✗ Don't expose the worker's HTTP directly — Next.js proxies all browser traffic.

---

## Phase 7 — Devnet dogfood, then mainnet $5

### What to implement

1. **Devnet phase (1-2 days):**
   - Wallet with 0.5 devnet SOL.
   - Run worker for ≥4 hours of live activity, agent decides freely.
   - Collect: count of buys, count of passes, daily PnL, list of `submit_trade` denials with reasons.
   - Cross-check: every executed `submit_trade` has a matching `trade-executed` observation in claude-mem.

2. **Mainnet $5 (only after devnet clean):**
   - Reduce caps for first 24h: per-trade 0.05 SOL, daily 0.3 SOL.
   - Fund mainnet wallet with ~0.4 SOL (~$70 at current).
   - Monitor every 15 minutes.
   - Stop early if (a) drawdown >20% (b) 3 consecutive failed swaps (c) any unexpected `submit_trade` denial reason.

3. **Production caps (only after 48h mainnet stable):**
   - Restore BRIEF caps: 0.25/2.0/30s/5/100bps.

### Documentation references

- BRIEF caps section.
- Solana devnet faucet docs: https://faucet.solana.com/

### Verification checklist

- All caps tested: per-trade rejection, daily cap rejection, cooldown rejection, max-positions rejection, kill-switch rejection. Each appears in worker logs AND as a claude-mem observation.
- Memory query: `curl ".../api/search?query=dump-detected&project=Pepe-Agent"` returns ≥3 observations after 4h of activity (proves the observer mode is recording).

### Anti-patterns

- ✗ Don't skip devnet.
- ✗ Don't open all caps on day-1 mainnet.
- ✗ Don't run mainnet without an external alert path (Phase 8 Telegram).

---

## Phase 8 — Production rollout: alerts, Meridian (optional), kill UX, monitoring

### What to implement

1. **Telegram alerts** — port claude-mem's `TelegramNotifier.ts` pattern (already referenced in memory `#72415, #72425`). Alerts on:
   - Every `trade-executed` (symbol, side, amountSol, txid)
   - Any `submit_trade` denial (reason)
   - Kill switch trip / untrip
   - Worker crash + auto-restart
2. **Meridian (optional cost layer)** —
   - Install `npm i -g @rynfar/meridian`. Run `claude login` (one-time human step).
   - Set worker env `ANTHROPIC_BASE_URL=http://127.0.0.1:3456`, leave `ANTHROPIC_API_KEY` to whatever Meridian wants (the README docs the key for OpenCode-style integrations; for SDK direct use, `ANTHROPIC_BASE_URL` is sufficient).
   - Decision criteria: enable only if monthly API cost > Claude Max sub.
3. **Kill UX** — add a tiny dot-matrix kill button at the bottom-right of the desktop layout (8×3 dot panel labeled `STOP`). Click → `POST /api/agent/kill` with confirm. Mobile: long-press Pepe.
4. **Monitoring** — `/healthz` polled by an external uptime service (UptimeRobot or similar). Worker logs ship to a tail (Fly logs / `journalctl` / `pm2`).
5. **Hosting** — Fly.io recommended. Single-region, persistent VM (not auto-scaling — agent state is in-memory). Volume mount for `worker/.data` and `worker/.sessions`. Concurrency: `N=1` (single instance — the trade ledger is the source of truth and must not be duplicated).

### Documentation references

- TelegramNotifier shape: `/Users/alexnewman/Scripts/claude-mem/src/services/integrations/TelegramNotifier.ts:full`.
- Meridian quickstart: https://github.com/rynfar/meridian#readme.
- Fly.io persistent VM docs: https://fly.io/docs/apps/ (volumes + single-region).

### Verification checklist

- Send `kill` from the UI → trade attempts denied within 1 frame.
- Telegram receives a "trade-executed" message within 10s of execution.
- Restart worker → state restored from `Options.resume` and trade ledger SQLite.

### Anti-patterns

- ✗ Don't run multiple worker instances concurrently. Single-flight.
- ✗ Don't auto-scale this — wallet operations require single-writer semantics.
- ✗ Don't forget to put `worker/.data/` and `worker/.sessions/` on a persistent volume — losing them loses the position ledger.

---

## Phase 9 — Final verification

### Documentation alignment audit

For each phase implementation file, grep for forbidden patterns:

```bash
# No client-side wallet keys
git grep -nE 'AGENT_WALLET_PRIVATE_KEY' -- 'app/' 'components/' 'lib/'   # expect zero results
# No NEXT_PUBLIC_* on agent secrets
git grep -nE 'NEXT_PUBLIC_(AGENT|WALLET|TRADE|JUPITER)' -- .            # expect zero results
# No bypass of checkTradePolicy — every submit path must call it
git grep -nE 'sendRawTransaction|sendTransaction' -- worker/            # every match must have checkTradePolicy in the same file
# No use of wrong SDK package
git grep -nE '@anthropic-ai/claude-code' -- worker/                      # expect zero
# No alpha v2 in worker/
git grep -nE 'unstable_v2_' -- worker/                                   # expect zero
# Custom tools registered ONLY through createSdkMcpServer
git grep -nE 'options\.tools\s*=' -- worker/                             # expect zero (use mcpServers instead)
```

### Functional verification

1. Cold-boot the system from scratch:
   ```bash
   # 1. claude-mem worker (already running globally via plugin)
   curl http://127.0.0.1:$CLAUDE_MEM_WORKER_PORT/healthz
   # 2. set mode if not set
   jq '.CLAUDE_MEM_MODE = "meme-tokens"' ~/.claude-mem/settings.json | sponge ~/.claude-mem/settings.json
   # 3. Pepe-Agent worker
   cd worker && bun install && bun run src/index.ts &
   # 4. Pepe-Agent UI
   cd .. && npm run dev
   ```
2. Open `http://localhost:3010`. Within 30s:
   - Real tokens flow on the dot-matrix board.
   - Status badge `LIVE` cyan.
   - Agent badge `WATCHING`.
3. Type in chat: "what tokens have you seen pump today" → Pepe responds citing `mcp__mcp-search__search` results.
4. Wait for an agent-initiated trade on devnet (or trigger via "buy 0.05 sol of MOG"). Observe phase transitions on the board.
5. After 1h, query memory: `curl ".../api/search?query=algorithm-insight&project=Pepe-Agent"` returns ≥1 observation about the agent's decision quality.

### End-state success (matches user requirement)

> "I can leave Pepe-Agent running on a small mainnet float, Pepe makes its own buy/pass decisions visibly on the dot-matrix board, narrates them via voice, accumulates structured memory of each pump it watched, and I can ask Pepe 'what happened with $MOG yesterday' and he answers from memory."

Confirmed achievable when Phases 1-7 complete and Phase 8 alerts/hosting are live.

---

## Decision log (locked in by Phase 0)

| Question | Answer | Reason |
|---|---|---|
| Worker hosted in Next.js function or separate process? | Separate Node process (Bun) | Persistent WS, custodial keypair, agent SDK streaming-input loop all incompatible with stateless functions. |
| Where does claude-mem run? | Its own daemon (already does); worker calls HTTP for ingestion + MCP stdio for read | Matches its existing architecture; no second observer process needed. |
| Meridian? | Optional, Phase 8 | Cost-control proxy, not core. |
| 21st-sdk? | Skipped | Cloud-hosted runtime conflicts with custodial wallet + custom UI. |
| SDK version? | v1 streaming-input pattern (`query()`), pinned `^0.2.126` | Production-tested in claude-mem; v2 is alpha. |
| Trade policy enforcement points? | TWO — `Options.hooks.PreToolUse[matcher='mcp__pepe__submit_trade']` AND inside the tool handler | Defense in depth. |
| Browser writes? | None. All writes via `/api/agent/*` to worker over `x-agent-secret`. | No client-side wallet, no agent secret in browser bundle. |
| Voice LLM? | Always our worker's Claude Agent SDK | ElevenLabs is STT/TTS only. |

---

## File-creation order checklist (one fresh chat per phase recommended)

- [ ] **Phase 1** → `worker/{package.json,tsconfig.json,src/{index,config,logger}.ts,src/rpc/worker-server.ts}`, `.env.worker.example`
- [ ] **Phase 2** → `worker/src/activity/subscriber.ts`, `worker/src/memory/claude-mem-client.ts`
- [ ] **Phase 3** → `worker/src/agent/{loop,system-prompt,tools/*}.ts`
- [ ] **Phase 4** → `worker/src/trade/{policy,ledger,wallet,jupiter}.ts`, install `@solana/web3.js bs58 better-sqlite3`
- [ ] **Phase 5** → `worker/src/state.ts`, `app/api/agent/state/route.ts`, extend `lib/dot-matrix/render-board.ts` with `agentPhase`
- [ ] **Phase 6** → `app/api/agent/chat/route.ts`, extend `lib/agent.ts` with text-mode bridge
- [ ] **Phase 7** → run scripts only, no new code
- [ ] **Phase 8** → `worker/src/alerts/telegram.ts`, optional Meridian setup, Fly deployment
- [ ] **Phase 9** → audit greps + functional verification only
