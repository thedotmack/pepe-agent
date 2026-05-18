# PLAN — Real Go-Live (Fix Audit Blockers)

> Successor to `PLAN-go-live.md`. The branch was shipped as "go-live ready"
> but two adversarial audits (codex 0.129.0, gemini 0.39.1) found 11 critical
> blockers. This plan brings the agent to a state where it can actually
> trade real SOL safely on mainnet.
>
> Reports: `.scratch/audits/codex-report.md`, `.scratch/audits/gemini-report.md`.
> Working dir for all worker tasks: `worker/`. Test runner: `bun test`.

---

## Standing rules for every phase

1. **Use the Solana + Jupiter skills.** Before reading external docs or
   guessing API shapes, invoke the relevant skill via the Skill tool — e.g.
   any `solana`-named skill, any `jupiter`-named skill, plus
   `claude-api` and `sequential-thinking` if useful. Skills already know
   current endpoints, parameter names, and pitfalls; don't re-derive them.
   If a skill isn't present, fall back to the Phase 0 doc snapshot at the
   end of this file.
2. **No new APIs from memory.** Copy patterns from Jupiter's reference
   `transactionSender.ts` (linked in Phase 0). Don't invent methods.
3. **Bun is the runner.** Tests go next to source as `*.test.ts` using
   `import { describe, it, expect } from "bun:test"`. Run with
   `bun test worker/src/**/*.test.ts`.
4. **Don't loosen audit findings to fit a phase.** If a phase reveals a
   12th issue, flag it inline and surface to the orchestrator before patching.

---

## Phase 0 — Documentation Discovery (DONE, snapshot below)

Already executed. Findings used to author Phases 1–8.

### Allowed APIs (cite-only)

**Jupiter Swap API v6** (`https://lite-api.jup.ag/swap/v1`)
- `GET /quote` params: `inputMint`, `outputMint`, `amount` (raw, pre-decimals, uint64), `slippageBps` (default 50), `swapMode` (`ExactIn` | `ExactOut`), `restrictIntermediateTokens` (default true), `onlyDirectRoutes`, `asLegacyTransaction`, `maxAccounts` (default 64), `dynamicSlippage`.
- `QuoteResponse` fields: `inAmount`, `outAmount`, `otherAmountThreshold`, `swapMode`, `slippageBps`, `priceImpactPct` (string-decimal), `routePlan`, `contextSlot`.
- `POST /swap` body: `userPublicKey`, `quoteResponse`, `wrapAndUnwrapSol` (default true — handles SOL unwrap automatically on TOKEN→SOL), `useSharedAccounts`, `prioritizationFeeLamports`, `dynamicComputeUnitLimit`, `dynamicSlippage`, `computeUnitPriceMicroLamports`, `blockhashSlotsToExpiry`.
- Response: `{ swapTransaction (base64), lastValidBlockHeight, prioritizationFeeLamports }`.

**solana web3.js**
- `BlockheightBasedTransactionConfirmationStrategy = { signature, blockhash, lastValidBlockHeight, abortSignal? }` — `blockhash` MUST be the one signed into the tx, NOT a fresh one.
- `sendRawTransaction(serialized, { skipPreflight: true, maxRetries: 0 })` per Jupiter reference — preflight is redundant after Jupiter's simulation; client-side rebroadcast loop replaces RPC retries.
- `getSignatureStatus(sig, { searchTransactionHistory: true })` returns `value` with `err` (null on success), `confirmationStatus` (`processed`|`confirmed`|`finalized`). `value === null` → never landed.

**@solana/spl-token**
- `getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve?, programId?, associatedTokenProgramId?)` — sync, no RPC.
- `getAccount(connection, address, commitment?, programId?)` → `{ amount: bigint, mint, owner, ... }`. Throws `TokenAccountNotFoundError`.
- `getMint(connection, mintPubkey)` for decimals.
- For Token-2022 mints pass `TOKEN_2022_PROGRAM_ID` explicitly.

**Anti-patterns confirmed by audit:**
- ❌ `connection.getLatestBlockhash()` *after* sending tx for confirmation (fresh blockhash defeats expiry mechanism — Jupiter reuses the `/swap` response's `lastValidBlockHeight`).
- ❌ Hard-throwing on `inputMint !== SOL_MINT` (kills SELL).
- ❌ Treating `walletSolCached = 0` as both "low" and "unknown" — distinct states.
- ❌ Hardcoded atomic amount `"1000000"` ignoring token decimals for price quotes.
- ❌ `KILL_SWITCH` env read only at boot; `/unkill` unconditionally clears it.
- ❌ `TRADING_HOLD_MS = 2000` when Jupiter swaps take 5–15s on mainnet.

---

## Phase 1 — SELL execution path in `jupiter.ts` + tool schema

**Goal:** Remove the BUY-only hard-throw; teach `executeTrade` how to swap TOKEN→SOL.

**Files:**
- `worker/src/trade/jupiter.ts` (185 → ~250 lines)
- `worker/src/agent/tools/index.ts` (lines 131–145 schema, 215–233 handler)
- `worker/src/agent/system-prompt.ts` (teach the agent that `side` exists)

**Tasks:**

1. **Skill check first.** Invoke `Skill` with `skill: "solana"` (or whichever
   Solana skill is registered) and `Skill` with `skill: "jupiter"` if
   present. Read what they say about TOKEN→SOL swap construction before
   touching code.

2. **Delete the BUY-only guard.** `worker/src/trade/jupiter.ts:151-154` —
   remove the `if (inputMint !== SOL_MINT) throw …` block.

3. **Add SELL branch in `executeTrade`:**
   - When `inputMint !== SOL_MINT && outputMint === SOL_MINT`:
     a. Derive ATA: `getAssociatedTokenAddressSync(new PublicKey(inputMint), wallet.publicKey)`.
     b. Read on-chain balance: `getAccount(connection, ata)` → `acct.amount` (bigint). If `TokenAccountNotFoundError`, return a structured failure result; do not throw.
     c. Convert caller's intent (`amountToken` UI or `amountAtomic` bigint) into the raw atomic amount Jupiter expects. **Add a new arg** to `executeTradeArgs`: `sellAmountAtomic?: bigint` (mutually exclusive with `amountSol`).
     d. Build quote with `swapMode: "ExactIn"`, `inputMint = tokenMint`, `outputMint = SOL_MINT`, `amount = sellAmountAtomic.toString()`.
     e. Build swap with `wrapAndUnwrapSol: true` (default; Jupiter unwraps WSOL → native SOL automatically).
     f. Same sign-and-send path as buy.

4. **Add `side` to `submit_trade` Zod schema** (`tools/index.ts:131–145`):
   ```ts
   side: z.enum(["BUY", "SELL"]).default("BUY"),
   sellAmountTokens: z.number().positive().optional(),  // UI units; converted using mint decimals
   ```
   When `side === "SELL"`, require `sellAmountTokens` (or token-atomic) and ignore `amountSol`.

5. **Handler at `tools/index.ts:215–233`:** Record the actual side. For
   SELL also call `ledger.closePosition(tokenIn)` only AFTER on-chain
   confirmation succeeds. Do not double-write a new open position.

6. **System prompt** (`worker/src/agent/system-prompt.ts`): add 3 lines
   describing the SELL form of `submit_trade` and that the agent should
   reference the exact tokens-to-sell amount from `get_open_positions`.

**Verification:**
- Typecheck: `cd worker && bun run typecheck` — clean.
- Add to `policy.test.ts` (or new `jupiter-sell.test.ts`): a unit test
  that asserts `executeTrade({inputMint: <token>, outputMint: SOL_MINT, sellAmountAtomic: 1000n})` does not throw the old "Phase 5" error.
- Devnet smoke (manual, not CI): sell a known devnet token back to SOL.

**Anti-pattern guards:**
- ❌ Don't pass `amount` to `/quote` as UI float — must be raw atomic uint64.
- ❌ Don't manually create the WSOL close-account instruction; `wrapAndUnwrapSol: true` handles it.
- ❌ Don't read mint decimals from a hardcoded map; fetch with `getMint`.

---

## Phase 2 — Robust tx confirmation + rebroadcast loop

**Goal:** Replace the fragile fresh-blockhash confirm with the Jupiter
canonical rebroadcast pattern, and reconcile against on-chain reality.

**Files:** `worker/src/trade/jupiter.ts` (lines 111–127 + new helper)

**Tasks:**

1. **Skill check:** `Skill` with `skill: "solana"` — pull its
   `sendAndConfirm` pattern reference.

2. **Pass through `lastValidBlockHeight` from `/swap` response.** The
   Jupiter swap response already includes the blockhash height the tx was
   signed against — store it in the result and use it for `confirmTransaction`.

3. **Replace `connection.getLatestBlockhash()` post-send** (`jupiter.ts:119–127`)
   with the Jupiter-style loop:
   ```ts
   const abortController = new AbortController();
   const confirmPromise = connection.confirmTransaction(
     { signature: txid, blockhash, lastValidBlockHeight, abortSignal: abortController.signal },
     "confirmed",
   );
   const rebroadcastPromise = (async () => {
     while (!abortController.signal.aborted) {
       await sleep(2_000);
       try { await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); } catch {}
     }
   })();
   const result = await Promise.race([confirmPromise, /* timeout */]);
   abortController.abort();
   ```

4. **Inspect `result.value.err`.** If non-null → return structured
   `{ status: "failed_onchain", err }`; do not record as success.

5. **Post-confirm reconciliation.** Even on success path, call
   `connection.getSignatureStatus(txid, { searchTransactionHistory: true })`
   and assert `value.confirmationStatus !== undefined`.

6. **Stuck-tx fallback.** If `confirmTransaction` times out
   (`BlockheightExceededError`), poll `getSignatureStatus` once more — if
   `value === null` return `{ status: "not_landed" }`; if it landed-late
   return `{ status: "landed_after_timeout", value }`. Caller decides
   whether to record.

**Verification:**
- Unit test with a mock `Connection` (Bun has `mock` helpers): assert the
  three returned statuses (`success`, `failed_onchain`, `not_landed`).
- Typecheck clean.

**Anti-pattern guards:**
- ❌ Never call `getLatestBlockhash()` between send and confirm.
- ❌ Don't treat `confirmTransaction` resolving as success without
  inspecting `value.err`.
- ❌ Don't retry on `failed_onchain` — that would double-spend if the next
  send succeeds with different state.

---

## Phase 3 — Decimals-aware price math in `position-monitor.ts`

**Goal:** Fix the `1,000,000x` (or more, depending on decimals) price
math error Gemini flagged.

**Files:** `worker/src/agent/position-monitor.ts` (lines 26, 42, 85–94),
`worker/src/trade/ledger.ts` (extend `recordTrade`).

**Tasks:**

1. **Store token decimals on position open.** When `submit_trade` records
   a BUY, fetch `getMint(connection, mint)` once and persist
   `decimals: number` on the position row. Migration: if a position lacks
   `decimals`, do a one-shot fetch on first quote.

2. **Fix the price calculation** (`position-monitor.ts:85-94`):
   ```ts
   // Quote 1 full token worth of atomic units
   const atomicPerToken = 10n ** BigInt(pos.decimals);
   const q = await getQuote({
     inputMint: pos.tokenId,
     outputMint: SOL_MINT,
     amount: atomicPerToken.toString(),
     slippageBps: 100,
   });
   const lamportsOut = Number(q.outAmount);
   const currentPriceSolPerToken = lamportsOut / LAMPORTS_PER_SOL;  // SOL per 1 full token
   ```
   This matches `entryPriceSolPerToken` units exactly (SOL per full token, not per atomic unit).

3. **Sanity check on first tick.** If `currentPriceSolPerToken /
   entryPriceSolPerToken` is outside `[1e-4, 1e4]`, log a warning and skip
   that tick rather than fire a RUG signal (decimals-misconfig safety net).

4. **Honor `priceImpactPct`.** If quote's `priceImpactPct > 0.10` (10%),
   treat the position as illiquid — emit a softer "ILLIQUID" warning, not
   a sell command. Hard threshold is a policy choice; document it.

**Verification:**
- Add `position-monitor-math.test.ts`: given a mock quote response,
  assert `currentPriceSolPerToken` matches expected for 6-, 8-, and
  9-decimal tokens.
- Manually simulate the bug: a 6-decimal token should NOT show
  `-99.999%` drop on the first tick.

**Anti-pattern guards:**
- ❌ Don't hardcode `1e6` or any decimal-agnostic constant.
- ❌ Don't compare price per atomic unit to price per full token.

---

## Phase 4 — Kill switch + state machine hardening

**Goal:** Make `KILL_SWITCH` actually kill, and prevent the state
machine from yanking phases out from under in-flight trades.

**Files:**
- `worker/src/index.ts` (lines 44–48)
- `worker/src/rpc/worker-server.ts` (lines 87–109)
- `worker/src/agent/tools/index.ts` (around `executeTrade` call at 187–195)
- `worker/src/state.ts` (lines 58, 131–135)
- `worker/src/agent/auto-tick.ts` (lines 57–63, 114–127)

**Tasks:**

1. **Re-check kill switch immediately before send.** In
   `tools/index.ts` around line 195, between
   `getQuote` and `sendRawTransaction`, do
   `if (killSwitchRef.tripped) return { error: "kill switch tripped mid-trade" }`.
   Plumb an `AbortSignal` through `executeTrade` and abort if tripped.

2. **`/unkill` requires explicit confirmation.** Edit `worker-server.ts:99-108`
   to require `?confirm=<AGENT_SHARED_SECRET>` query param. If
   `KILL_SWITCH=1` was set at boot, additionally require a fresh boot
   override env (`KILL_SWITCH_OVERRIDE=1`) or refuse.

3. **TRADING phase holds until trade resolves.** Replace the 2-second
   `TRADING_HOLD_MS` auto-flip (`state.ts:58, 131-135`) with: TRADING
   phase clears only when `recordTradeResult` (new method) is called, OR
   on a safety timeout of `90_000ms`. The state-machine tick should not
   auto-transition out of TRADING.

4. **Fix `turnIdle` race in auto-tick** (`auto-tick.ts:57-63, 114-127`):
   - Set `turnIdle = false` at the moment of `injectUserMessage` /
     `injectActivityContext` (line 114, 122), NOT only on `assistantText`.
   - Set `turnIdle = true` only on `result` (existing line 58).
   - Guard the 15s `pushInterval` with `if (!turnIdle) return`.

5. **Position monitor respects in-flight trades.** Already gates on
   `phase === "TRADING" || "CALLING"` (`position-monitor.ts:74-75`),
   which now works correctly once Phase 4 task 3 lands.

**Verification:**
- `state.test.ts` (new): assert TRADING does NOT auto-flip after 2s; does
  flip on `recordTradeResult`; does flip after 90s safety timeout.
- `auto-tick.test.ts` (new): inject mock events; assert `turnIdle`
  transitions on injection, not assistantText.
- Manual: `curl /kill` mid-trade; assert next send refuses.

**Anti-pattern guards:**
- ❌ Don't read `KILL_SWITCH` env again — use the in-memory `killSwitchRef`.
- ❌ Don't allow `/unkill` without auth.
- ❌ Don't bump `TRADING_HOLD_MS` to 90s and call it fixed — the issue is
  it shouldn't be time-based at all.

---

## Phase 5 — Policy distinguishes BUY vs SELL; TANK_EMPTY blocks only BUYs

**Goal:** Fix the audit's "TANK_EMPTY blocks emergency exits" bug.

**Files:** `worker/src/trade/policy.ts`, `worker/src/trade/policy.test.ts`,
all `checkTradePolicy(intent, ctx)` call sites.

**Tasks:**

1. **Add `side` to `TradeIntent`** (top of `policy.ts`).

2. **TANK_EMPTY check** (`policy.ts:73-79`): gate on
   `intent.side === "BUY"` only. SELLs proceed even at low SOL — that's
   the whole point of a sell.

3. **Per-trade cap** (`policy.ts:83-88`): applies in SOL terms to BUYs.
   For SELLs, add a separate cap based on token-USD-value or by allowing
   any-size sell up to position size (the position itself was capped at
   entry, so no additional cap needed for the sell).

4. **Daily cap** (`policy.ts:111-118`): counts net SOL spent (BUY adds,
   SELL does not). Update `ledger.totalSolToday()` to net out SELL
   proceeds, OR add a new `dailyBuySolToday()` method that the policy
   uses instead.

5. **Update `submit_trade` handler** to pass `side` into
   `checkTradePolicy`.

**Verification:**
- Extend `policy.test.ts` with cases:
  - SELL allowed when SOL < TANK_EMPTY_THRESHOLD_SOL.
  - SELL allowed when daily BUY cap is hit.
  - BUY still denied at low SOL.
- All existing 13 tests still pass.

**Anti-pattern guards:**
- ❌ Don't add a "force allow" override; just route around TANK_EMPTY by
  intent side.

---

## Phase 6 — Balance "unknown" state + secret hygiene

**Goal:** Fix the fail-open balance bug + the gitignore + secret minimums.

**Files:** `worker/src/index.ts`, `worker/src/trade/policy.ts`,
`worker/src/config.ts`, `.gitignore`.

**Tasks:**

1. **`walletSolCached` becomes nullable** (`index.ts:53`):
   `let walletSolCached: number | null = null;`. Only set on successful
   `refreshBalance`. On RPC failure leave the *last known* value, but if
   it was never set, stay `null`.

2. **Policy treats `null` as UNKNOWN, not 0** (`policy.ts:73-79`): add a
   `balance unknown` denial branch distinct from `TANK_EMPTY`. UNKNOWN
   blocks BUYs (fail-safe) but allows SELLs (you definitely need to be
   able to exit even if RPC is flaky).

3. **`.gitignore`:** add `worker/.env`.

4. **`AGENT_SHARED_SECRET` min length 32** (`config.ts:19`):
   `z.string().min(32, "AGENT_SHARED_SECRET must be >=32 chars")`. Update
   any deploy docs that mention 8.

**Verification:**
- Boot worker with `SOLANA_RPC_URL=http://localhost:1` (intentionally
  broken): assert policy reports UNKNOWN on first BUY attempt; SELL still
  goes through gate.
- `git check-ignore worker/.env` returns the path.

**Anti-pattern guards:**
- ❌ Don't default `walletSolCached` to `Infinity` — that hides the bug.
- ❌ Don't shorten the secret minimum back down "for dev convenience."

---

## Phase 7 — Test coverage for everything new

**Goal:** Audit said "tests prove almost nothing." Fix that.

**Files (all new):**
- `worker/src/trade/jupiter-sell.test.ts`
- `worker/src/trade/jupiter-confirm.test.ts`
- `worker/src/agent/position-monitor-math.test.ts`
- `worker/src/agent/auto-tick.test.ts`
- `worker/src/state.test.ts`

**Tasks:**

1. Use the existing `fakeLedger` pattern from `policy.test.ts:1-72` as
   the template for in-memory fixtures.

2. For Solana connection mocks, build a small `fakeConnection` helper
   exporting the minimum surface: `getBalance`, `getLatestBlockhash`,
   `sendRawTransaction`, `confirmTransaction`, `getSignatureStatus`,
   `getAccount` (from spl-token).

3. Cover:
   - SELL happy path returns success.
   - SELL with missing ATA returns structured failure (no throw).
   - confirmTransaction returning `value.err = SlippageToleranceExceeded`
     → result is `failed_onchain`, NOT recorded as trade success.
   - Decimals math for 6, 8, 9 decimal tokens.
   - `turnIdle = false` on inject, `true` on result.
   - TRADING does not auto-flip after 2s.

4. CI hook: add `worker/package.json` `"test": "bun test"` script. Wire
   into the root `npm run typecheck` or Vercel preflight if applicable.

**Verification:**
- `cd worker && bun test` — all green.
- `cd worker && bun run typecheck` — clean.

**Anti-pattern guards:**
- ❌ Don't write tests that exercise real RPC. All mocked.
- ❌ Don't skip the failed_onchain case; that's the highest-leverage one.

---

## Phase 8 — Devnet smoke + docs sync

**Goal:** Prove the loop works against a real network with tiny amounts,
then update docs to match reality.

**Tasks:**

1. **Devnet end-to-end.**
   - `SOLANA_NETWORK=devnet`, `SOLANA_RPC_URL=https://api.devnet.solana.com`.
   - Fund wallet with 0.1 devnet SOL.
   - Manually walk through: market push → agent picks token → BUY → position monitor sees price tick → forced SELL via `/chat` command → ledger reconciles → kill switch → unkill (with confirm) → next trade allowed.
   - Capture transcript to `.scratch/devnet-smoke-<date>.log`.

2. **Update `PLAN-go-live.md`** to remove claims contradicted by audit:
   - "Triple-gate defense-in-depth" — clarify what each gate actually
     guards.
   - "BUY-only" note removed from caveats.
   - Note that mainnet requires the Phase 7 tests to pass first.

3. **System prompt update** (`worker/src/agent/system-prompt.ts`): add a
   §SELL discipline section — when to call SELL form of submit_trade,
   how to reference position size from `get_open_positions`.

4. **Mainnet checklist** (`worker/PRELAUNCH.md`, new):
   - All Phase 7 tests green.
   - Devnet smoke clean.
   - `KILL_SWITCH=1` toggle tested.
   - Wallet seeded with ≤1 SOL float.
   - PRIVATE KEY only in `worker/.env` (now gitignored).
   - One human watching the first hour.

**Verification:**
- Devnet log shows successful BUY + SELL with correct PnL math.
- `git status` clean on completion.
- PR description updated to call out the audit fixes per finding.

---

## Phase 9 — Final verification (orchestrator-led, do not delegate)

Run these in order:

1. `cd worker && bun run typecheck` — clean
2. `cd worker && bun test` — all green
3. `grep -rn "executeTrade currently only supports SOL→TOKEN" worker/src/` — empty
4. `grep -rn "QUOTE_TOKEN_AMOUNT_ATOMIC.*1000000" worker/src/` — empty
5. `grep -rn "TRADING_HOLD_MS.*2_000" worker/src/` — empty
6. `git check-ignore worker/.env` — non-empty
7. Codex re-audit: `codex exec --sandbox read-only "Re-audit feat/pepe-go-live against PLAN-real-go-live.md. Have the 11 original findings been fixed? Cite file:line."` — expect ≤2 minor leftovers.
8. PR comment with audit-fix matrix: each of the 11 original findings → file:line where fixed → test that covers it.

If any check fails: open a Phase 10 fix-loop, do NOT merge.

---

## Findings-to-phase traceability

| # | Audit finding | Phase |
|---|---|---|
| 1 | Position monitor can't sell | 1 |
| 2 | BUY hardcoded in `submit_trade` | 1 |
| 3 | Policy is theater (no liquidity/route checks) | 5 + future |
| 4 | TANK_EMPTY blocks emergency exits | 5 |
| 5 | Kill switch advisory only | 4 |
| 6 | Unsafe `sendRawTransaction` / confirm | 2 |
| 7 | Position monitor can hang | 2 (timeout via abortSignal) |
| 8 | Race control hand-wavy | 4 |
| 9 | Balance polling fails open | 6 |
| 10 | Secret hygiene + `.gitignore` | 6 |
| 11 | `1,000,000x` price math (Gemini) | 3 |
| 12 | Tests prove nothing | 7 |
