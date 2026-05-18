# Devnet Smoke Runbook (Phase 8)

Phase 8 deliverable. Operator-facing. Run this BEFORE `worker/PRELAUNCH.md` is ticked
green for mainnet. Goal: prove the BUY → SELL → close cycle works on real devnet RPC
with throwaway SOL. Cost ceiling: ~0.1 SOL (devnet airdrop). Time: ~15 minutes once
your wallet is funded.

This runbook is the only acceptable substitute for an actual end-to-end devnet
transcript. A subagent CANNOT run this — it needs a funded devnet wallet and a human
watching the logs. Do not skip.

---

## 0. Prereqs

```bash
# from repo root
which bun                       # need 1.3+
which solana                    # need 1.18+
which jq curl openssl           # standard
cd /Users/alexnewman/.superset/projects/Pepe-Agent
```

`solana` CLI: install with `sh -c "$(curl -sSfL https://release.solana.com/v1.18.26/install)"`
if missing.

---

## 1. Generate / select a devnet wallet

Use a THROWAWAY keypair. Never run the smoke against your real mainnet wallet.

```bash
# create a fresh devnet keypair (writes ~/.config/solana/devnet-smoke.json)
solana-keygen new --outfile ~/.config/solana/devnet-smoke.json --no-bip39-passphrase

# copy the base58 secret key for AGENT_WALLET_PRIVATE_KEY_BASE58
# (solana CLI stores keypairs as JSON arrays of bytes; convert to base58)
SECRET_JSON=$(cat ~/.config/solana/devnet-smoke.json)
SECRET_B58=$(node -e "
  const bs58 = require('bs58').default || require('bs58');
  const bytes = Uint8Array.from(JSON.parse(process.argv[1]));
  console.log(bs58.encode(bytes));
" "$SECRET_JSON")
echo "$SECRET_B58"

# capture the pubkey
PUBKEY=$(solana-keygen pubkey ~/.config/solana/devnet-smoke.json)
echo "$PUBKEY"
```

If the inline node one-liner errors because `bs58` isn't in the root project,
run it from `worker/` instead (`cd worker && node -e ...` — `bs58` is a worker dep).

---

## 2. Fund the devnet wallet

Two options.

```bash
# Option A — CLI airdrop (preferred):
solana airdrop 0.1 "$PUBKEY" --url https://api.devnet.solana.com

# Option B — Web faucet (if A is rate-limited):
#   https://faucet.solana.com  → paste $PUBKEY, request 0.1 SOL.

# Verify the balance landed:
solana balance "$PUBKEY" --url https://api.devnet.solana.com
# expected: 0.1 SOL (or thereabouts).
```

Devnet airdrop is rate-limited per IP. If it 429s, switch to the web faucet.

---

## 3. Write `worker/.env` for devnet

```bash
cd worker
cat > .env <<EOF
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
AGENT_SHARED_SECRET=$(openssl rand -hex 32)
AGENT_WALLET_PRIVATE_KEY_BASE58=$SECRET_B58
ANTHROPIC_API_KEY=<paste your Anthropic key here>
ANTHROPIC_MODEL=claude-sonnet-4-6
AGENT_MAX_BUDGET_USD=2
WORKER_PORT=7011
WORKER_BIND=127.0.0.1
MEMORY_TICK_MS=5000
EOF

# Verify it's gitignored:
git check-ignore worker/.env
# expected: worker/.env  (literal path printed)

# Capture the shared secret for curl auth:
export AGENT_SHARED_SECRET=$(grep '^AGENT_SHARED_SECRET=' .env | cut -d= -f2)
echo "$AGENT_SHARED_SECRET" | wc -c   # expected: 65 (64 chars + newline)
```

If `git check-ignore` prints nothing, your `.gitignore` is broken — abort.

---

## 4. Boot the worker against devnet

In a dedicated terminal pane, with output teed to a transcript:

```bash
cd worker
SMOKE_DATE=$(date +%Y%m%d-%H%M%S)
TRANSCRIPT=../.scratch/devnet-smoke-${SMOKE_DATE}.log
echo "transcript: $TRANSCRIPT"
bun run dev 2>&1 | tee "$TRANSCRIPT"
```

Expected boot lines (within the first 5s):

```
[info] [boot] pepe-agent worker starting { network: 'devnet', port: 7011 }
[info] [boot] trade ledger opened at /.../worker/.data/trade-ledger.db
[info] [boot] wallet pubkey: <PUBKEY>
[info] [boot] wallet balance poll started (initial=0.1000 SOL)
[info] [memory] claude-mem health ok            (or warn if you skipped claude-mem)
[info] [activity.subscriber] connecting → wss://...
[info] [boot] agent loop started
[info] [boot] auto-tick started
[info] [boot] position-monitor started
[info] [rpc] listening on http://127.0.0.1:7011
[info] [boot] worker ready
```

If `wallet balance poll started (initial=UNKNOWN)` instead of a SOL value: the
devnet RPC is rate-limited or down. Wait 30s and re-boot.

---

## 5. Verify /healthz and /state

In a second terminal pane:

```bash
export AGENT_SHARED_SECRET=<paste from .env>
curl -s -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/healthz | jq
# expected: { "ok": true, "uptime": <ms>, "sessionId": "pepe-agent-...", "walletPubkey": "<PUBKEY>" }

curl -s -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/state | jq
# expected fields:
#   phase: "IDLE" or "WATCHING"
#   walletSol: ~0.1
#   killSwitch: false
#   feedStatus: "live" (or "connecting" if WS not connected yet)
```

---

## 6. Kill switch round-trip

```bash
# Trip via /kill:
curl -s -X POST -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/kill | jq
# expected: { "killed": true }

curl -s -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/state | jq .killSwitch
# expected: true

# /unkill WITHOUT ?confirm — should 403:
curl -s -X POST -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/unkill
# expected: { "error": "unkill requires ?confirm=<AGENT_SHARED_SECRET>" }

# /unkill WITH ?confirm — should clear (worker did NOT boot with KILL_SWITCH=1):
curl -s -X POST -H "x-agent-secret: $AGENT_SHARED_SECRET" \
  "http://127.0.0.1:7011/unkill?confirm=$AGENT_SHARED_SECRET" | jq
# expected: { "killed": false }

curl -s -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/state | jq .killSwitch
# expected: false
```

If /unkill still 403s with the right secret, you booted with KILL_SWITCH=1 in env.
Set `KILL_SWITCH_OVERRIDE=1` in `worker/.env`, then re-run /unkill once. Boot-killed
worker is sticky: each /unkill needs `KILL_SWITCH_OVERRIDE=1` until restart.

---

## 7. Force a BUY via /chat

Devnet has thin token activity. The autonomous loop will likely sit WATCHING for a
long time waiting for candidates. Force a decision turn manually.

Pick a known devnet SPL mint. Two common test mints:
- USDC devnet: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- A test SPL of your choice from https://faucet.solana.com (request a custom token).

```bash
# Send a /chat message asking the agent to BUY 0.01 SOL of a token.
# The agent will gate through trade-policy and submit_trade.
curl -N -s -H "x-agent-secret: $AGENT_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:7011/chat \
  -d '{"text":"Devnet smoke test. Submit a BUY trade for 0.01 SOL of token 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU. Narrate the call, then call submit_trade."}'
```

Expected SUCCESS markers in the transcript:

```
[agent] $X is ... — I'm in 0.01 sol      (CALLING narration)
[info] [agent.tools] submit_trade ok txid=<txid> side=BUY ...
[info] [trade.jupiter] confirmed { txid: '<txid>', slot: N }
```

Then `/state` should show:
```bash
curl -s -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/state | jq
#   openPositions: 1
#   walletSol: ~0.09 (down from 0.1)
```

Verify the on-chain effect:
```bash
solana confirm <txid> --url https://api.devnet.solana.com
# expected: Confirmed
```

---

## 8. Force a SELL via /chat

After the BUY succeeds:

```bash
# Look up the open position. The submit_trade SELL form needs tokenIn (the SPL
# mint you bought), tokenOut="SOL", and sellAmountTokens (UI tokens — match exactly
# what the position has).
curl -s -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/state | jq
# Note: /state shows openPositions count, not the position list. For positions,
# ask the agent via /chat to call get_open_positions.

curl -N -s -H "x-agent-secret: $AGENT_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:7011/chat \
  -d '{"text":"Devnet smoke test. Call get_open_positions, then SELL my entire position. Use submit_trade with side=\"SELL\", tokenIn=<the mint>, tokenOut=\"SOL\", and sellAmountTokens=<the position size in UI tokens>. Narrate the exit."}'
```

The system prompt documents the SELL form (worker/src/agent/system-prompt.ts §
"Tools available"):
- `side="SELL"`, `tokenIn=<mint>`, `tokenOut="SOL"`, `sellAmountTokens=<UI tokens to sell>`.
- Use the EXACT `sizeSol`/tokens figure from `get_open_positions`. Never guess.

Expected SUCCESS markers:

```
[info] [agent.tools] get_open_positions returned 1 position
[agent] taking profit on $X — out
[info] [agent.tools] submit_trade ok txid=<sell-txid> side=SELL ...
[info] [trade.jupiter] confirmed { txid: '<sell-txid>', slot: N }
```

Then `/state` should show:
```
  openPositions: 0
  walletSol: ~0.1 minus fees (returned to SOL)
```

---

## 9. Ratio sanity bounds

After SELL completes, do the math on the transcript:

```
buy_sol_out:    0.01 SOL spent on tokens
sell_sol_in:    ? SOL received from selling those same tokens
ratio:          sell_sol_in / buy_sol_out
```

Expected on devnet (no price movement, ~zero slippage on a small swap):
- `0.93 <= ratio <= 1.00` → healthy. Difference is Jupiter fees + RPC fees.
- `ratio < 0.85` → something's wrong. Slippage was too high, or you swapped a
  token with a real spread. Investigate before mainnet.
- `ratio > 1.05` → suspicious. Either a real devnet pool moved or there's a
  decimals bug. Investigate before mainnet.

---

## 10. Expected FAILURE modes (NOT bugs — these are correct behavior)

The transcript should NOT crash on any of these. Each is a valid `executeTrade` outcome.

| Outcome | What it means | Operator action |
|---|---|---|
| `failed_onchain` | Tx landed but failed (likely SlippageToleranceExceeded). Slippage cap is 300bps. | Expected on volatile mints. Re-try, agent will widen slippage up to cap. |
| `not_landed` | RPC never confirmed the tx within 90s (`CONFIRM_TIMEOUT_MS`). | Devnet RPC is flaky. Retry. Mainnet should use Helius. |
| `landed_after_timeout` | Tx confirmed AFTER 90s — past our cutoff. The trade IS on-chain. | Ledger records it. State machine still cleared TRADING. Manual reconciliation may be needed. |
| `insufficient_token_balance` | SELL: position has fewer tokens than `sellAmountTokens` requested. | Re-fetch `get_open_positions` and use the exact figure. NEVER guess. The position may already be closed elsewhere. |
| `no_token_account` | SELL: the wallet has no ATA for that mint. Position likely already closed. | Confirm via `get_open_positions`. Don't blind-retry. |

Each of these is exercised in `worker/src/agent/tools/tools-handler.test.ts` — see
the 6 `ExecuteTradeResult` variants.

---

## 11. Shutdown

```bash
# In the worker terminal pane:
Ctrl+C   # SIGINT — shutdown handler closes server, agent, balance poll, ledger.

# Verify clean shutdown lines in transcript:
grep "received SIGINT, shutting down" "$TRANSCRIPT"
```

---

## 12. Idle-boot smoke (no swap)

Sometimes you just want to prove the worker boots clean against devnet without
spending any SOL. Skip steps 7-9. Do steps 0-6, then Ctrl+C. The transcript
proves:
- Worker boots without crash.
- Wallet balance polls (success or fail per RPC).
- State machine reaches WATCHING (or IDLE).
- /kill and /unkill round-trip works.

This is enough to greenlight Phase 9. A full BUY+SELL is required before mainnet.

---

## Captured artifacts (commit these)

When you finish the smoke:

```bash
# Commit ONLY the transcript log and any annotated screenshots. NEVER commit .env.
cd /Users/alexnewman/.superset/projects/Pepe-Agent
git add .scratch/devnet-smoke-${SMOKE_DATE}.log
git status   # confirm no worker/.env
```

Then tick `worker/PRELAUNCH.md` line item: "Devnet smoke clean".
