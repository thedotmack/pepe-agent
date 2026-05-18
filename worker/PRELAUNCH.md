# PRELAUNCH — Mainnet Operator Checklist (Pepe-Agent)

The audit-fix branch `feat/pepe-go-live` (Phases 1-7 shipped, Phase 8 docs+devnet,
Phase 9 verification) is the canonical pre-mainnet state. Do NOT flip
`SOLANA_NETWORK=mainnet-beta` until every box below is checked. Each line is a
hard gate.

This is an operator's runbook. Skim once; tick boxes as you go.

---

## 0. Repo + branch

- [ ] On branch `feat/pepe-go-live`, fast-forwarded to remote.
- [ ] Working tree clean (`git status` shows only `next-env.d.ts` modification — that's an auto-regen file).
- [ ] You have read `PLAN-real-go-live.md` end to end. You understand why each of
      the 12 audit findings was caught and what was fixed.

## 1. Tests green

- [ ] `cd worker && bun run typecheck` returns nothing (no errors).
- [ ] `cd worker && bun test` returns **71 pass / 0 fail** (or more — Phase 8 may
      have added cleanup tests).
- [ ] No `Phase N owns` / `TODO Phase` bridge comments in `worker/src/`:
      ```bash
      grep -rn "Phase N owns\|TODO Phase\|TODO: Phase" worker/src/ --include="*.ts"
      # expected: no matches
      ```

## 2. Devnet smoke clean

- [ ] You ran `.scratch/devnet-smoke-runbook.md` end-to-end on a funded devnet wallet.
- [ ] A captured transcript exists at `.scratch/devnet-smoke-<date>.log`.
- [ ] The transcript shows a full BUY + SELL cycle on devnet.
- [ ] Sell-to-buy SOL ratio is between 0.93 and 1.00 (no decimals bug, no
      runaway slippage). Anything outside that range = STOP. Don't go mainnet.
- [ ] `solana confirm <txid>` for at least the BUY and SELL txids returned
      "Confirmed".

## 3. Kill switch round-trip

- [ ] `curl -X POST /kill` flips `killSwitch: true` in `/state`.
- [ ] `curl -X POST /unkill` WITHOUT `?confirm=` returns 403.
- [ ] `curl -X POST '/unkill?confirm=<wrong>'` returns 403.
- [ ] `curl -X POST '/unkill?confirm=$AGENT_SHARED_SECRET'` flips
      `killSwitch: false`.
- [ ] **Sticky-boot semantics tested:** boot worker with `KILL_SWITCH=1`. /unkill
      with the right `?confirm=` STILL returns 403 unless `KILL_SWITCH_OVERRIDE=1`
      is also in env. Confirm.
- [ ] **Sticky for the lifetime of the worker:** once boot-killed, every /unkill
      needs `KILL_SWITCH_OVERRIDE=1`. The override is NOT one-shot. Restart the
      worker (without `KILL_SWITCH=1`) to clear sticky state.

## 4. Wallet seeded with ≤1 SOL float (first-day cap)

- [ ] Mainnet wallet (NEW key, never used on devnet — devnet keys may have been
      logged or leaked) holds **≤1.0 SOL**. This is the cap on first-day loss
      exposure. Per-trade cap (0.25 SOL) and daily cap (2.0 SOL) are still
      enforced; the wallet balance is the third backstop.
- [ ] `solana balance <pubkey> --url <mainnet-rpc>` confirms the figure.
- [ ] Wallet pubkey in `worker/.env` matches the funded address.

## 5. Secrets hygiene

- [ ] `git check-ignore worker/.env` prints `worker/.env` (path is gitignored).
- [ ] `git status` does not show `worker/.env` (not staged, not committed).
- [ ] `git log --all --full-history -- worker/.env` returns nothing (never landed
      in any branch's history).
- [ ] `AGENT_SHARED_SECRET` is at least 32 chars (`openssl rand -hex 32` gives
      64 chars — fine).
- [ ] `AGENT_WALLET_PRIVATE_KEY_BASE58` is set in `worker/.env` and ONLY there.
      It is NOT in `.env.local`, NOT in any shell history file you'll commit,
      NOT in screenshots. The Next.js process must never see it.
- [ ] `.env.local` (root) does NOT contain `AGENT_WALLET_PRIVATE_KEY_BASE58`.

## 6. RPC quality (mainnet)

- [ ] `SOLANA_RPC_URL` is **NOT** the public Solana mainnet endpoint
      (`api.mainnet-beta.solana.com`). Public is rate-limited and silently drops
      `getSignatureStatus` queries we depend on.
- [ ] The RPC provider supports
      `getSignatureStatus(..., { searchTransactionHistory: true })` — without
      this, our `landed_after_timeout` detection misses late-confirmation. Verified
      providers: **Helius**, **Triton**, **QuickNode** (paid tiers).
- [ ] You have tested ONE confirmation against your chosen mainnet RPC. Devnet's
      Solana Labs RPC is okay for smoke; mainnet must be Helius-class.

## 7. Process supervision

- [ ] Worker is started via systemd / pm2 / docker (auto-restart on crash).
- [ ] Logs are tee'd somewhere persistent (`/var/log/pepe-agent/worker.log` or
      similar). Not just `worker/.scratch/`.
- [ ] You know how to send `SIGTERM` to the worker (graceful shutdown drains
      in-flight trades + flushes ledger).

## 8. Live human supervision

- [ ] **You will be watching the first hour.** Pepe in the browser, terminal
      tailing `worker/.scratch/<log>`, finger on /kill.
- [ ] Threshold to /kill: **any** surprise. Unexpected position open. Unexpected
      balance drop. RPC stuck. Ledger row that doesn't match Solscan. ANY mismatch.
      You can always /unkill later; you can't undo a bad trade.
- [ ] You have the `?confirm=$AGENT_SHARED_SECRET` URL pre-built in your clipboard
      so /unkill is one paste away.

## 9. Mainnet flip

When all of the above is checked:

```bash
# worker/.env — flip ONE line at a time, restart between flips.
SOLANA_NETWORK=mainnet-beta
SOLANA_RPC_URL=<your Helius/Triton URL>
AGENT_WALLET_PRIVATE_KEY_BASE58=<your mainnet key>
```

Then restart the worker (NOT with `--watch` for mainnet — use the supervised
process). Watch the first balance-poll line:

```
[info] [boot] wallet balance poll started (initial=X.XXXX SOL)
```

Confirm X matches your `solana balance` on mainnet to 4 decimal places. If
it's `UNKNOWN`, your RPC is misconfigured. STOP. Do not let the agent boot.

## 9.1 Audit trail readout (`/phase-events`)

Phase 8 (O4) added a read endpoint over the ledger's `phase_events` table —
this is the source of truth for every trade-result attempt (including
denials and failures that never made it on-chain). For mainnet monitoring:

```bash
curl -s -H "x-agent-secret: $AGENT_SHARED_SECRET" \
  "http://127.0.0.1:7011/phase-events?limit=20" | jq
# {
#   "events": [
#     { "id": 12, "ts": 1715958412345, "side": "BUY",
#       "txid": "abc...", "outcome": "ok", "reason": "executed" },
#     { "id": 11, ..., "outcome": "failed_onchain", ... },
#     ...
#   ],
#   "limit": 20
# }
```

Cross-reference rows against `worker/.data/trades.db` (only successful
on-chain effects) and Solscan for the wallet. Any `outcome` in
`{failed_onchain, not_landed, landed_after_timeout, no_token_account,
insufficient_token_balance}` is informational — these are documented in
the runbook (Section 10) and are not bugs. But any `txid` that exists in
phase_events but NOT in trades.db OR Solscan is a real anomaly.

## 10. Day-1 monitoring (first 24h)

- [ ] Hour 0-1: human eyes-on. Threshold = any surprise → /kill.
- [ ] Hour 1-6: check every 30 min. Compare ledger SQL (`worker/.data/trades.db`)
      against Solscan for the wallet. Any mismatch = /kill.
- [ ] Hour 6-24: check every 2 hours. Same comparison.
- [ ] If the agent submitted 0 trades in 24h: that's fine (thin signal). Not a
      bug. The discipline section of the system prompt forbids FOMO.
- [ ] If the agent submitted >5 trades in 24h: review each one's reason in the
      decision log. The 30s cooldown should make this rare; if it's hitting, the
      pre-filter (auto-tick `pickTopN`) may be too permissive.

## 11. Rollback plan

If anything goes wrong:

```bash
# 1. /kill the worker
curl -X POST -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/kill

# 2. Snapshot ledger BEFORE shutting down:
cp worker/.data/trades.db worker/.data/trades.db.snapshot.$(date +%s)

# 3. Stop the worker process (SIGTERM → graceful drain).
#    systemd: systemctl stop pepe-agent
#    pm2: pm2 stop pepe-agent
#    docker: docker compose stop worker

# 4. For any open positions: manually SELL via solscan/jupiter web UI using the
#    SAME private key (worker keeps a copy in worker/.env). Get out fast.

# 5. File a postmortem in PLAN-real-go-live.md noting what broke.
```

---

## Sign-off

When every box above is checked, sign:

```
Phase 8 devnet smoke: PASS, transcript at .scratch/devnet-smoke-YYYYMMDD-HHMMSS.log
Phase 9 verification: PASS, sign-off comment by <operator>
Mainnet GO at: <UTC timestamp>
First-day cap: ≤1 SOL float
```

Until this block exists in a commit message or in a `MAINNET-LAUNCH.md` file in the
repo, the agent stays on devnet.
