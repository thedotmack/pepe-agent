# Paper Trading Mode - Phased Implementation Plan

**Status:** plan only - **Owner:** Pepe-Agent - **Branch:** `feat/live-board` (or new `feat/paper-trading`)
**Goal:** Add a paper-trading mode so the **Composite G+D+B** strategy (defined in claude-mem obs `80740` / `80746`) can be validated against live tape **without risking real SOL**, before flipping to live capital.

This plan is **executable phase by phase in fresh chat contexts**. Each phase is self-contained.

---

## Source-of-truth note (read first)

The strategy spec was written into claude-mem during a prior session (obs `80740`, `80734`, `80735`, `80737`, `80740`, `80746`). The user-referenced markdown file `.scratch/phase6-strategy-report.md` **does not exist on disk** - confirm before starting:

```bash
ls -la .scratch/phase6-strategy-report.md 2>&1
```

If missing, **Phase 0 task A** is to recover the spec from claude-mem (`get_observations([80740, 80734, 80735, 80737, 80746])`) and write it to disk so subsequent phases have a stable reference. Do not begin Phase 1 until the on-disk spec exists.

### The strategy in one paragraph (copied from obs 80746)

> **Composite G+D+B** entry: pool >= 50K, g5 positive **and rising vs prior tick**, bp non-negative, pool not declining 2 ticks. Position tiered to pool depth (0.25 SOL for pool >= 1M, 0.10 SOL for 50K-1M, skip <50K). **Exit** on g5 reversal **or** pool -0.5% from peak **or** 8-tick max hold. Required: **paper-trading mode first** because n=1 qualifying trade in the 5-minute tape is too thin for live capital.

---

## Phase 0 - Documentation Discovery

### A. Recover and pin the strategy report

**Subagent task** - deploy a `general-purpose` agent with this brief:

> Recover the Phase 6 strategy report. The file referenced as `.scratch/phase6-strategy-report.md` does not exist on disk. Pull the strategy content from claude-mem observations 80740, 80734, 80735, 80737, 80726, 80727, 80730, 80731, 80732, 80733, 80746 via `mcp__plugin_claude-mem_mcp-search__get_observations`. Reconstruct the report into `.scratch/phase6-strategy-report.md` with sections: (1) tick-by-tick replay summary, (2) why A/B/C/E/F were killed, (3) why G+D+B was selected, (4) the exact entry/exit rules, (5) position-sizing tiers, (6) tape-replay PnL numbers. Cite each fact with the source observation ID. Do NOT invent rules not in the observations.

**Verification:**
- File exists: `[ -f .scratch/phase6-strategy-report.md ] && echo OK`
- Contains the literal phrases `g5 positive and rising`, `pool >= 50K`, `8-tick max hold`, `-0.5% from peak`.

### B. Audit ActivityToken fields actually populated by the live feed

**Subagent task** - deploy `Explore` agent:

> Read `worker/src/activity/subscriber.ts` end-to-end (the full `normalizeTokens` function and the WS message handler). Report (1) every field on `ActivityToken` and (2) which ones are set from the WSS payload vs left undefined. Specifically I need ground-truth on: `price`, `liquidity` (== pool), `fiveMinGain` (== g5), `buyPressure5m` (== bp), `signal`. For each: report the source field name in the raw WSS message. No invention.

**Why this matters:** the strategy uses `g5` and `pool` - we must confirm `fiveMinGain` and `liquidity` are the right map. We must also confirm `price` is populated, because **paper PnL uses `price`** (g5 and pool delta were ruled out as PnL proxies in obs 80733).

### C. Audit the existing trade ledger so we don't re-invent it

**Manual reads** (orchestrator, not subagent):
- `worker/src/trade/ledger.ts` - full file. Note the `Database` open path, schema SQL, and prepared statements.
- `worker/src/trade/policy.ts` - full file. Note that `checkTradePolicy` is called from three sites.
- `worker/src/state.ts` - full file. Note `DecisionLogEntry.action` is currently `"BUY" | "PASS" | "SELL" | "KILL" | "RESUME"`.
- `worker/src/agent/tools/index.ts:131-260` - the `submit_trade` handler. Note where `executeTrade` is called.
- `worker/src/index.ts` - the boot sequence; understand where to wire the new processor.

### D. Allowed APIs (locked-in for all later phases)

| What | API | Source |
|---|---|---|
| Read live tick snapshot | `subscriber.getSnapshot(): ActivityToken[]` | `worker/src/activity/subscriber.ts` |
| Per-token snapshot fields used by strategy | `tokenId, price, liquidity, fiveMinGain, buyPressure5m, signal` | same |
| Open SQLite DB (Bun) | `new Database(dbPath)`; `db.exec(SCHEMA)`; `db.prepare(...).run/.all/.get` | `worker/src/trade/ledger.ts` |
| State decision log | `stateStore.recordDecision({ ts, symbol, action, reason })` | `worker/src/state.ts` |
| State phase | `stateStore.setPhase("WATCHING" | "CALLING" | "TRADING" | "IDLE")` | same |
| Persist a memory observation | `memClient.recordObservation({ contentSessionId, tool_name, tool_input, tool_response, cwd, platformSource })` | `worker/src/memory/claude-mem-client.ts` |

### E. Anti-patterns (do not do these)

- x **Do not use `g5` or `pool delta` to compute paper PnL.** Obs 80733 ruled both inadequate. Use `token.price` snapshots at entry and at each tick.
- x **Do not run the strategy through the agent for paper mode.** The agent's job is narration + memory; the strategy is deterministic and runs in a separate processor module. Coupling them defeats the purpose of paper validation (you'd be testing the agent's interpretation of the rules, not the rules themselves).
- x **Do not share a DB file between paper and live modes' "open positions" semantics.** Use distinct tables (`paper_trades`, `paper_positions`) so production safety code never conflates them. Same DB file is fine; same tables is not.
- x **Do not omit slippage in paper fills.** The whole point of obs 80737 was that 200bps slippage killed every strategy and 60-100bps restored viability. Paper mode must apply realistic slippage to fills.
- x **Do not let paper trades hit `submit_trade`'s policy or jupiter execution paths.** Paper has its own executor; the live `submit_trade` tool stays untouched.

---

## Phase 1 - Paper ledger (storage layer)

### What to implement

Create `worker/src/trade/paper-ledger.ts`. Mirror the shape of `ledger.ts` but with separate tables and a `paper_` prefix on all SQL. Reuse the same DB file (`.data/trades.db`) - fewer file handles, single mount in Docker.

**Schema** (append to `SCHEMA_SQL` in `ledger.ts`, OR open a second connection in `paper-ledger.ts`):

```sql
CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  tokenId TEXT NOT NULL,
  symbol TEXT,
  side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  amountSol REAL NOT NULL,
  fillPriceSol REAL NOT NULL,         -- price at fill (with slippage applied)
  markPriceSol REAL NOT NULL,         -- raw price at signal time (no slippage)
  slippageBps INTEGER NOT NULL,
  signalReason TEXT NOT NULL,         -- "G+D+B entry: g5=+0.04, pool=82K, rising tick 4->5"
  strategyVersion TEXT NOT NULL       -- e.g. "GDB-v1"
);
CREATE TABLE IF NOT EXISTS paper_positions (
  tokenId TEXT PRIMARY KEY,
  symbol TEXT,
  entryFillPriceSol REAL NOT NULL,
  entryMarkPriceSol REAL NOT NULL,
  sizeSol REAL NOT NULL,
  entryTickN INTEGER NOT NULL,        -- for the 8-tick max-hold rule
  peakPoolSol REAL NOT NULL,          -- for the -0.5%-from-peak rule
  peakPriceSol REAL NOT NULL,         -- for mark-to-market high-water
  openedAt INTEGER NOT NULL,
  closedAt INTEGER,
  exitFillPriceSol REAL,
  exitReason TEXT,
  realizedPnlSol REAL
);
CREATE INDEX IF NOT EXISTS idx_paper_trades_ts ON paper_trades(ts);
```

### Public API the file must export

```ts
export interface PaperLedger {
  recordEntry(input: {
    tokenId: string; symbol?: string;
    sizeSol: number;
    fillPriceSol: number; markPriceSol: number;
    slippageBps: number; signalReason: string;
    entryTickN: number; poolSol: number; strategyVersion: string;
  }): { id: number };

  recordExit(input: {
    tokenId: string;
    fillPriceSol: number; markPriceSol: number;
    slippageBps: number; signalReason: string;
    strategyVersion: string;
  }): { id: number; realizedPnlSol: number } | null;

  updatePeaks(tokenId: string, currentPoolSol: number, currentPriceSol: number): void;

  openPaperPositions(): Array<{
    tokenId: string; symbol: string | null;
    entryFillPriceSol: number; entryMarkPriceSol: number;
    sizeSol: number; entryTickN: number;
    peakPoolSol: number; peakPriceSol: number; openedAt: number;
  }>;

  /** total realized + unrealized SOL across all paper trades, given current prices. */
  totalPaperPnlSol(currentPrices: Map<string, number>): {
    realized: number; unrealized: number; total: number;
  };

  close(): void;
}

export function openPaperLedger(): PaperLedger { /* ... */ }
```

### Documentation references

- Mirror `worker/src/trade/ledger.ts` style (Bun's `Database` API, prepared statements, WAL pragma).
- Realized-PnL formula: `realizedPnlSol = sizeSol * ((exitFillPriceSol - entryFillPriceSol) / entryFillPriceSol)`. Both legs include slippage so the number reflects what we'd actually take home.

### Verification checklist

```bash
cd worker && bun test src/trade/paper-ledger.test.ts
# Unit tests must cover:
#   - recordEntry inserts a position; openPaperPositions() returns it
#   - recordExit closes it, computes realizedPnlSol, removes from open list
#   - updatePeaks raises peakPool / peakPrice but never lowers them
#   - totalPaperPnlSol with mixed open + closed positions returns correct sums
```

### Anti-patterns

- x Don't share `positions` table with the live ledger. Live `openPositions()` must NOT see paper rows.
- x Don't omit the `peakPoolSol` / `peakPriceSol` columns. The exit rule depends on them.
- x Don't compute PnL in USD. SOL throughout - the agent's wallet is denominated in SOL.

---

## Phase 2 - Signal processor (deterministic G+D+B evaluator)

### What to implement

Create `worker/src/signals/processor.ts`. **Pure function** module with no I/O - easy to unit-test against captured tape.

```ts
export type SignalDecision =
  | { kind: "ENTER"; tokenId: string; sizeSol: number; reason: string }
  | { kind: "EXIT";  tokenId: string; reason: string }
  | { kind: "HOLD" };

export interface TickContext {
  tickN: number;
  current: ActivityToken;
  previous: ActivityToken | null;     // same token, prior tick - null if new
  twoBackPool: number | null;         // pool 2 ticks ago (for "not declining 2 ticks")
  openPosition: {                     // null if not in a position
    entryTickN: number;
    peakPoolSol: number;
    peakPriceSol: number;
  } | null;
}

export const STRATEGY_VERSION = "GDB-v1";

export function evaluateGDB(ctx: TickContext): SignalDecision { /* ... */ }
```

### Rules to implement (cite obs 80740, 80746 - copy verbatim)

**ENTRY** (only fires when `openPosition === null`):
1. `current.liquidity >= 50_000` (skip otherwise -> HOLD)
2. `current.fiveMinGain ?? 0 > 0`
3. `previous && current.fiveMinGain > previous.fiveMinGain` (strictly rising)
4. `(current.buyPressure5m ?? 0) >= 0`
5. `twoBackPool === null || current.liquidity >= twoBackPool * 0.995` (pool not declining >=0.5% over 2 ticks)

If all 5 pass -> `ENTER` with sizing tier:
- `liquidity >= 1_000_000` -> `sizeSol = 0.25`
- `50_000 <= liquidity < 1_000_000` -> `sizeSol = 0.10`
- otherwise (already filtered above) -> unreachable

**EXIT** (only fires when `openPosition !== null`):
1. `current.fiveMinGain ?? 0 < (previous?.fiveMinGain ?? 0)` -> `EXIT "g5 reversal"`
2. `current.liquidity < openPosition.peakPoolSol * 0.995` -> `EXIT "pool -0.5% from peak"`
3. `(ctx.tickN - openPosition.entryTickN) >= 8` -> `EXIT "8-tick max hold"`

Otherwise `HOLD`.

### Documentation references

- Strategy rules: `.scratch/phase6-strategy-report.md` (after Phase 0 reconstruction). Specifically the "Composite G+D+B rules" section.
- Field semantics: `worker/src/activity/subscriber.ts` (the `ActivityToken` interface - this is the canonical shape).
- Anti-patterns from tape replay: obs 80730 (bp != price), obs 80732 (g5 backward-looking - can't use for PnL).

### Verification checklist

```bash
cd worker && bun test src/signals/processor.test.ts
# Required test cases (each cites the qualifying tape moment):
#   - DJT T22->T29 g5 rising -> ENTER (the only qualifying trade in the 5-min tape; obs 80735)
#   - CRCLx 16x bp ramp with flat g5 -> HOLD (obs 80730)
#   - Pool draining for 2 ticks -> no ENTER, EXIT if held
#   - 8-tick max-hold timer fires correctly
#   - Pool tier sizing: 1.5M pool -> 0.25 SOL; 200K pool -> 0.10 SOL; 30K -> no entry
```

### Anti-patterns

- x Don't call `subscriber.getSnapshot()` from inside `evaluateGDB`. It's a pure function over the context object - keep it that way for replay testing.
- x Don't use `signal === "STRONG"` as a precondition. Obs 80708 confirmed all 68 ticks were `FLAT/STRONG_BEAR` - relying on the upstream classifier means zero entries.
- x Don't add a 6th rule "for safety." YAGNI - the strategy was tape-validated as G+D+B, not G+D+B+X. Re-tune only after collecting real paper-trade data.

---

## Phase 3 - Paper-trade executor + tick driver

### What to implement

Create `worker/src/signals/paper-executor.ts`. Glue layer:

1. Holds per-token previous-tick history (a `Map<tokenId, ActivityToken[]>` with a 3-deep ring buffer - enough for `previous` and `twoBackPool`).
2. On every tick (driven by a `setInterval` in `index.ts` - **same 5s cadence as the memory tick**, do NOT couple to it though), iterate the current snapshot's top-N tokens (N=20 - more than the agent looks at, since paper mode has no API cost). For each:
   - Build `TickContext`
   - Call `evaluateGDB`
   - Apply the decision against the paper ledger:
     - `ENTER`: assume **80 bps slippage** (configurable env `PAPER_SLIPPAGE_BPS=80`, justified by obs 80737 "60-100bps against large pools"). `fillPriceSol = markPriceSol * (1 + slippage)`. Call `paperLedger.recordEntry(...)`. Push a `DecisionLogEntry` with `action: "PAPER_BUY"`. Record observation to claude-mem with `tool_name: "paper-trade-entry"`.
     - `EXIT`: same slippage on the down side. `fillPriceSol = markPriceSol * (1 - slippage)`. Call `paperLedger.recordExit(...)`. Push `DecisionLogEntry` with `action: "PAPER_SELL"`. Record observation `tool_name: "paper-trade-exit"` with realized PnL in the `tool_response` JSON.
     - `HOLD`: if the position is open, call `paperLedger.updatePeaks(...)` so the trailing-stop rules have current peaks for the next tick.

### Wiring in `worker/src/index.ts`

After the existing `startMemoryTick(...)` call, conditionally start the paper executor:

```ts
import { openPaperLedger } from "./trade/paper-ledger.ts";
import { startPaperExecutor } from "./signals/paper-executor.ts";

// Phase 6 paper trading - runs whenever TRADING_MODE === 'paper' OR 'shadow'.
//   paper:  evaluator runs, only paper ledger is written, no real trades
//   shadow: evaluator runs alongside the agent; real trades still possible by the agent
//   live:   evaluator does NOT run (paper mode off)
const paperLedger = config.TRADING_MODE === "live" ? null : openPaperLedger();
const paperExec = paperLedger
  ? startPaperExecutor({
      subscriber, paperLedger, stateStore, memClient,
      contentSessionId, slippageBps: config.PAPER_SLIPPAGE_BPS ?? 80,
    })
  : null;
```

### State surface additions (`worker/src/state.ts`)

Extend `DecisionLogEntry.action` to include `"PAPER_BUY" | "PAPER_SELL"`. Add to `AgentStateSnapshot`:

```ts
paperPnlRealizedSol: number;
paperPnlUnrealizedSol: number;
paperOpenPositions: number;
strategyVersion: string;        // "GDB-v1" - surfaces in /state for audit
```

These come from `paperLedger.totalPaperPnlSol(currentPrices)` computed at snapshot time. Pass the latest `currentPrices` map through from the subscriber's last snapshot.

### Config additions (`worker/src/config.ts`)

```ts
TRADING_MODE: "paper" | "shadow" | "live"  // default "paper"
PAPER_SLIPPAGE_BPS: number                 // default 80
PAPER_TOP_N: number                        // default 20
```

Refuse to start with `TRADING_MODE=live` if `AGENT_WALLET_PRIVATE_KEY_BASE58` is unset (fail-fast).

### Documentation references

- Tick wiring pattern: `worker/src/memory/tick.ts:34-...` (use `setInterval`; honor `stopped` flag; `unref()` so worker can exit).
- claude-mem ingest fields: `PLAN-pepe-harness.md` Phase 0 section B (the table at line ~50 of that file).
- Slippage justification: claude-mem obs `80737`.

### Verification checklist

```bash
# 1. Unit tests for the executor itself (pure subscriber-snapshot replay):
cd worker && bun test src/signals/paper-executor.test.ts

# 2. Boot the worker in paper mode against the live feed for 10 minutes:
TRADING_MODE=paper bun run src/index.ts | tee .scratch/paper-run-$(date +%s).log

# 3. Verify state surface:
curl -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/state | jq '
  {paperPnlRealizedSol, paperPnlUnrealizedSol, paperOpenPositions, strategyVersion}
'

# 4. Verify paper trades were recorded:
sqlite3 worker/.data/trades.db 'SELECT COUNT(*) FROM paper_trades;'
sqlite3 worker/.data/trades.db 'SELECT * FROM paper_positions WHERE closedAt IS NULL;'

# 5. Verify claude-mem captured the paper trades:
curl "http://127.0.0.1:$(printf '%d' $((37700 + $(id -u) % 100)))/api/search?query=paper-trade-entry&project=Pepe-Agent" | jq '.results | length'
```

Define "done" precisely: at least **one ENTER decision recorded** during the 10-min run, **all peaks updated each HOLD tick**, and **PnL math reconciles** between the SQL view and the `/state` endpoint.

### Anti-patterns

- x Don't call `executeTrade` (jupiter) from paper mode. Ever.
- x Don't reuse `state.ts` `setPhase("TRADING")` for paper trades - that flashes the dot-matrix as if real money moved. Add a `setPhase("PAPER_TRADING")` (or just keep phase at WATCHING and only push the decision-log entry - leaning toward the latter, since the BRIEF state machine is for the human-narrating agent).
- x Don't make the paper tick interval configurable below 1s. The activity feed itself is throttled to 1Hz; sub-second ticks just re-evaluate stale data.
- x Don't run two `paperLedger` instances. Pass one through.

---

## Phase 4 - Agent narration of paper trades (optional but recommended)

### What to implement

Inject paper-trade events as **synthetic context** into the agent's streaming-input loop (does NOT trigger an assistant turn - uses `shouldQuery: false`):

In `worker/src/agent/loop.ts`, expose `injectActivityContext(text: string)` is already there. After Phase 3, in `paper-executor.ts`, when a paper trade fires, call:

```ts
agentHandle.injectActivityContext(
  `[PAPER ${decision.kind}] ${symbol} size=${sizeSol} fill=${fillPriceSol}` +
  ` reason=${reason}. (Strategy=${STRATEGY_VERSION}, mode=paper, NOT a real trade.)`
);
```

Update `worker/src/agent/system-prompt.ts` - append a section:

```
## Paper Trading Mode
When TRADING_MODE=paper, a deterministic strategy module (G+D+B v1) makes the actual buy/sell calls. You will see [PAPER BUY] and [PAPER SELL] context messages. Your job is to narrate them in 1 sentence - say "Pepe sees" or "tape says" - and remember them. Do NOT call submit_trade in paper mode; it will be denied.
```

Also: in `submit_trade` handler (`worker/src/agent/tools/index.ts`), early-deny if `config.TRADING_MODE === "paper"` with reason `"paper trading mode - deterministic strategy is in control"`. Defense-in-depth: also add the same check to `checkTradePolicy` so ALL three call sites refuse.

### Documentation references

- `injectActivityContext` already implemented: `worker/src/agent/loop.ts` (search for `shouldQuery: false`).
- `SDKUserMessage` shape: `PLAN-pepe-harness.md` Phase 0 section A.

### Verification checklist

- Boot in paper mode with `ANTHROPIC_API_KEY` set.
- Trigger a paper trade (or wait for a real one in the live tape).
- Confirm the agent narrates it (visible via the existing `[agent]` log line in `index.ts:108`).
- Confirm the agent never successfully calls `submit_trade` (it should get the "paper trading mode" denial).

### Anti-patterns

- x Don't let the agent see paper trades as if they were real - the suffix `(NOT a real trade.)` is not optional.
- x Don't allow the agent to flip `TRADING_MODE` via a tool. Mode is process-global, set at boot.

---

## Phase 5 - Replay harness (validates strategy on captured tape)

### What to implement

Create `worker/src/signals/replay.test.ts` (or a `bun run` script if it grows). Goal: replay the captured 5-min tape from May 5 against the G+D+B evaluator and assert the published PnL numbers from the strategy report match what the code produces.

### Source data

Captured ticks live as claude-mem observations of `tool_name: "token-snapshot"` between `2026-05-05 04:05Z` and `2026-05-05 05:36Z`. The orchestrator should have captured a JSON dump in Phase 0 task A - if not, dump now:

```bash
# Pull the 68 tick observations (session 5db03f25-... per obs 80727).
curl -X POST http://127.0.0.1:$WORKER_PORT/api/observations/batch \
  -H "Content-Type: application/json" \
  -d '{"project":"Pepe-Agent","ids":[/* TBD ids */]}' \
  > .scratch/tape-2026-05-05.json
```

(Easier: write a small `bun run scripts/dump-tape.ts` that calls `mcp-search` `timeline`.)

### What the test asserts

```ts
test("G+D+B replay produces 1 ENTER on DJT T22->T29 with realized PnL within strategy-report band", () => {
  const ticks = loadTape(".scratch/tape-2026-05-05.json");
  const result = replayGDB(ticks);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0].symbol).toBe("DJT");
  expect(result.entries[0].entryTickN).toBeGreaterThanOrEqual(22);
  expect(result.entries[0].realizedPnlSol).toBeWithin(/* numbers from .scratch/phase6-strategy-report.md */);
});
```

### Verification checklist

- The single qualifying trade from the tape (obs 80735) fires.
- No other ENTERs fire - if they do, either the rule logic drifts from spec or the tape is different than the strategy was tuned on. Investigate before "fixing."

### Anti-patterns

- x Don't relax the assertions to make tests pass. If the replay's PnL doesn't match the strategy report, that's a real signal: either the report is wrong, or the implementation drifted. Read the report first.

---

## Phase 6 - Final verification + go/no-go for live

### What to do

1. Run the worker in `TRADING_MODE=paper` for **at least 4 contiguous hours** during a normal trading session. (Captured tape is 5 min, n=1 - too thin per obs 80746.)
2. After the run, compute:
   - **Hit rate**: paper entries that closed positive / total paper entries.
   - **Total realized PnL** in SOL.
   - **Drawdown**: largest unrealized loss observed during any open position.
3. Write `.scratch/paper-validation-<date>.md` with the numbers and a 1-sentence verdict.
4. **Go / no-go gate** for live capital - defined up front (don't move the goalposts):
   - `entries >= 10` AND `hit_rate >= 0.50` AND `total_pnl > 0` AND `max_drawdown_per_trade < 0.05 * sizeSol` -> propose live mode (separate plan).
   - Otherwise: stay in paper mode, iterate on the strategy with a fresh tape.

### Verification checklist

- Validation file exists and contains the four numbers above.
- The `/state` endpoint's `paperPnlRealizedSol` matches the validation file.
- A claude-mem search for `tool_name: "paper-trade-exit"` returns >= `entries` results.

### Anti-patterns

- x Don't flip to live mode based on "vibes" or because the strategy looked good on a single 5-min tape. The whole reason this plan exists (per obs 80746) is that n=1 is too thin.
- x Don't treat the go/no-go thresholds as advisory. Either define a different threshold *before* you start the run, or live with this one.

---

## Files this plan creates / modifies

**New:**
- `.scratch/phase6-strategy-report.md` (Phase 0 task A)
- `worker/src/trade/paper-ledger.ts` + `paper-ledger.test.ts`
- `worker/src/signals/processor.ts` + `processor.test.ts`
- `worker/src/signals/paper-executor.ts` + `paper-executor.test.ts`
- `worker/src/signals/replay.test.ts`
- `worker/scripts/dump-tape.ts` (optional helper)
- `.scratch/paper-validation-<date>.md` (Phase 6 output)

**Modified:**
- `worker/src/config.ts` - add `TRADING_MODE`, `PAPER_SLIPPAGE_BPS`, `PAPER_TOP_N`
- `worker/src/state.ts` - extend `DecisionLogEntry.action`, add paper PnL fields to snapshot
- `worker/src/index.ts` - wire `paperLedger` + `startPaperExecutor`
- `worker/src/agent/system-prompt.ts` - paper-mode section
- `worker/src/agent/tools/index.ts` - early-deny `submit_trade` in paper mode
- `worker/src/trade/policy.ts` - defense-in-depth deny in paper mode

**Untouched (do not modify):**
- `worker/src/trade/jupiter.ts`, `worker/src/trade/wallet.ts`, `worker/src/trade/ledger.ts` - production trade path.
- The Next.js `app/` and `lib/` - paper mode is worker-only.
