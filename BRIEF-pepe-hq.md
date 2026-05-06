# Pepe HQ — Product Design Brief

A web app where you watch Pepe — an autonomous AI trading agent with a real Solana wallet — operate live on the memecoin market. Pepe is not a tool you use. **Pepe is the show.** You're the audience seat.

---

## 1. One-liner

> *A 108×192 LED dot-matrix board where you watch a frog trade Solana memecoins with his own money in real time.*

## 2. The core inversion

Every existing trading dashboard puts the user in the cockpit. The board surfaces data; the user does the work.

Pepe HQ flips this:

- **The agent is in the cockpit.** Pepe has a wallet, capital, and a decision loop.
- **The viewer is in the audience seat.** No buttons, no login, no wallet to connect.
- **The data exists to make Pepe's behavior legible.** Every column on the board is justifying why he just bought MOG and passed on POPCAT.

The closest reference points are: a Twitch stream of a poker player, a stadium scoreboard, the lobby of a Bloomberg terminal as art. It is closer to a *webcam* than to an *app*.

## 3. Audience

- **Primary:** crypto-native viewers who already lurk in trading streams and Twitter spaces.
- **Secondary:** product-design Twitter, hardware-aesthetic enthusiasts, the people who'd buy a Teenage Engineering device to put on their desk.
- **Tertiary:** future API customers who'll fork the agent for their own tokens.

Not the audience: people who want to trade themselves. They have a hundred dashboards already. Pepe HQ is the opposite product.

## 4. Pillars

1. **Always live.** No empty states. No "click to refresh." Even at 3am with nothing happening, the board breathes — beam pulses, ticker scrolls, Pepe blinks.
2. **The agent is visible.** Every decision is signaled in the matrix *before* it happens. Two-second "calling" delay between intent and execution is a feature, not a bug — it's the slow-motion replay.
3. **The matrix is everything.** All UI is dots. No HTML cards floating over the canvas. Only DOM elements: the canvas, Pepe's sprite, a hidden audio element.
4. **Honesty over performance.** Show the bad trades. Show the dry days. The track record IS the product.
5. **One screen.** No routes, menus, settings. Everything that matters fits in 108×192 dots.

---

## 5. The viewer's experience, narrated

You open the URL. The page is already running. Top of the screen: `PEPE HQ` in big dotted letters, a green `LIVE` badge, `4.21 SOL` wallet readout, `+$24.18` P/L since midnight UTC.

Below that, eight rows of tokens scroll-update in place — symbol, price, 5-minute gain, a buy-pressure dot bar. Numbers tick. Bars fill and drain. A `+44%` flips green; an `-8%` flips amber.

In the bottom third of the screen, Pepe floats — bobbing on a slow sin wave. His eyes track your cursor when you move it. He blinks. From his eye, a stair-stepped trail of cyan dots stretches up and to the right, terminating on one of the rows: `$MOG`. The dots pulse softly.

Then the dots get brighter. They lock. A speech-bubble panel appears next to Pepe: `"MOG IS COILED FOR A PUMP — IM IN HALF SOL"`. Two seconds tick.

The MOG row flashes amber. The wallet equity blinks: `4.21 → 3.96 SOL`. A new line prepends to the ticker below Pepe: `09:41 ▲ BUY 0.21 SOL $MOG`. The bubble updates: `"DONE — IN AT 0.00012"`. The beam dims back to watching mode and resumes its 2-second hop between top movers.

You didn't do anything. You just saw a frog place a real trade with real money. You can leave the tab open on a second monitor. You'll come back tomorrow to see how he's doing.

That is the whole product.

---

## 6. Visual specification

### 6.1 Canvas

- **Logical grid:** 108 columns × 192 rows.
- **Dot:** 2px square, 1px gap. Total physical: 324px × 576px at scale 1; 648px × 1152px at scale 2.
- **Renderer:** HTML `<canvas>` painting `fillRect` per dot, RAF-driven, dirty-flag gated. Static intro screens may use the kit's per-dot `<span>` mode; the live board never does.
- **Display:** centered, on a `#03070d` background, with a soft outer glow (the kit's existing `boxShadow`).

### 6.2 Color tokens (no additions allowed)

| Token | Hex | Use |
|---|---|---|
| `off` | `rgba(8,18,30,0.78)` | board background |
| `ghost` | `rgba(30,57,86,0.42)` | dotted field, dividers |
| `dim` | `rgb(61,95,134)` | meta text, dim panels |
| `blue` | `rgb(68,163,255)` | structural panels, default rails |
| `cyan` | `rgb(65,235,224)` | accents, live state, primary text |
| `amber` | `rgb(255,154,54)` | warnings, fallback states, sells, P/L losses |
| `white` | `rgb(236,248,255)` | top-emphasis text, brand mark |

We will be tempted to add a green for wins. **Don't.** Cyan = active/positive, amber = negative, white = high emphasis. Three states is enough.

### 6.3 Typography

- `lg` (5×7 glyphs, scale ×2) — `PEPE HQ` brand only.
- `md` (5×7) — symbols, prices, bubble headline.
- `sm` (3×5) — meta, badges, labels, ticker timestamps, gain percentages.

### 6.4 Layout regions

```
Rows 0–11   ┃ HEADER         brand · live badge · wallet · pnl pill
Rows 12–14  ┃ DIVIDER        ghost dotted line + sparkline (last hour equity)
Rows 15–127 ┃ TOKEN TAPE     8 rows × 14px each, scrollable in v2
Rows 128–129┃ DIVIDER
Rows 130–188┃ PEPE HQ        habitat panel | beam | bubble | ticker
Rows 189–191┃ FOOTER         3 service-health dots
```

### 6.5 Token row anatomy (one of eight)

```
col: 0     6        38      64       84            107
     ┃ ▓ $POPCAT  0.0185  +28%  ███████░ 0.9 ▲HOLD ┃
       │   │       │        │       │         │
       │   │       │        │       │         └─ optional badge: NEW / HOLD / SOLD
       │   │       │        │       │
       │   │       │        │       └─ buy-pressure dot bar + numeric
       │   │       │        │
       │   │       │        └─ 5m gain (cyan if ≥0, amber if <0)
       │   │       │
       │   │       └─ price (auto-format: 4dp or scientific)
       │   │
       │   └─ symbol, max 6 chars
       │
       └─ row panel rail (cyan brighter if active beam target)
```

### 6.6 The beam

A stair-stepped trail of dots from a fixed eye anchor inside the habitat (~col 78, row 158) up to the right edge of the active row. Drawn one-dot-on, one-dot-off so it reads as discrete laser dots, not a line. Brightness is a sin-wave pulse with phase shift per dot for that "data-flowing-toward-Pepe" feel.

```
                                 ╲
                                  ·
                                   ·
                                    ·   ← every-other dot, level pulses
                                     ·
                                      ·
                              [PEPE FRAME]
```

### 6.7 Pepe's habitat

A drawn dot-matrix panel (kit `drawPanel`, dim level) at cols 8–72, rows 130–188. The PepeHead sprite (existing component, completely unchanged: float, blink, eye-tracking, lip-sync) is absolutely positioned over this region's pixel coordinates. The matrix and the sprite are in two layers but share one center of gravity.

### 6.8 Speech bubble

A small panel adjacent to Pepe (cols 18–88, rows 132–155 when visible). Drawn into the matrix, not as DOM. Wraps text on word boundaries, max 3 lines, `md` font. Fades in/out by stepping `level` from 0 → 0.85 over 200ms.

### 6.9 Ticker

Below the bubble (rows 168–188). Three most recent trades, newest first. Each line: `HH:MM ▲/▼ N.NN SOL $SYM   +/-$X.XX`. The arrow glyph and amount inherit the side color (cyan for buys, amber for sells). Older lines fade as new ones prepend.

### 6.10 Motion vocabulary

| Element | Motion | Duration |
|---|---|---|
| Pepe sprite | sin-wave Y bob (existing) | continuous, ~6px amplitude |
| Pepe blink | sprite swap (existing) | 150ms, every 2–5s random |
| Beam dots | level sin pulse, phase shift per dot | continuous, 2s period |
| Row flash | tone→amber, level→1.0, then back | 600ms ease-out |
| Wallet flash | white pulse on equity readout | 200ms |
| Bubble in/out | level fade | 200ms in, 300ms out |
| Ticker prepend | new line at level 0 → 1; oldest line 1 → 0 | 400ms |
| Active row | cyan rail brighter, active fill | step change, no tween |

No springs. No Framer-Motion layout animation. The whole product feels like a hardware display because the motion is honest about being made of dots.

---

## 7. Agent behavior specification

### 7.1 Inputs

- **Live token list** from `wss://data.cmem.ai/activity` (REST `https://data.cmem.ai/api/activity/top/50` fallback). Shapes match `lib/jupiter/realtime/activity-websocket.ts:7-33` from MemeDeck-OSS.
- **Self state** from a Redis (or flat-file) store: open positions, today's spend, last trade timestamp, kill-switch flag.
- **Quote prices** from MemeDeck's Jupiter proxy at decision time.

### 7.2 Decision loop (runs every WS update or 1s poll)

```
For each token T in feed:
  if T.id in open_positions: continue
  if open_positions.count >= 5: continue
  if T.id in blocklist: continue
  if T.fiveMinGain < 15%: continue
  if T.buyPressure5m < 0.7: continue
  if T.liquidity < $50,000: continue
  if T.updatesPerMinute < 20: continue
  if cooldown active: continue
  if dailyMaxSol exhausted: continue
  → enter CALLING(T) for 2.0s, then submit_trade(buy)

For each open position P:
  current = quote(P.id).price
  pnl = (current - P.entryPrice) / P.entryPrice
  if pnl >= 30% (take profit) or pnl <= -15% (stop loss):
    → enter CALLING(P) for 2.0s, then submit_trade(sell)
  if pnl <= -50% in one tick (likely rug):
    → submit_trade(sell) immediately, bubble "RUG — OUT"
```

### 7.3 Position sizing (v1, intentionally simple)

```
size = min(per_trade_max_sol, equity_sol * 0.05)
```

At 4.21 SOL, that's `min(0.25, 0.21) = 0.21 SOL`. We'll graduate to Kelly or Vol-targeting in v2 once we have a real win-rate sample. Don't optimize before we have data.

### 7.4 Hard caps (`lib/agent/trade-policy.ts`)

| Cap | Value | Reason |
|---|---|---|
| Per-trade max | 0.25 SOL | Limits any single-trade blast radius |
| Daily max | 2.0 SOL | Bounds daily downside |
| Cooldown | 30s | Prevents oscillation / spam |
| Max open positions | 5 | Cognitive load + concentration risk |
| Default slippage | 100 bps (1%) | |
| Hard slippage cap | 300 bps (3%) | Reject quote if higher; bubble: "SLIPPAGE TOO RICH — PASS" |
| Min wallet for trade | 0.05 SOL | Below this, agent goes idle; bubble: "TANK EMPTY" |
| Kill switch | env `KILL_SWITCH=1` | Checked every tick; halts trading immediately |

### 7.5 Daily reset

UTC midnight. Resets `dailyMaxSol` counter. Snapshots equity for the new day's P/L baseline. Posts a ticker line: `00:00 — NEW DAY. PNL RESET.`

### 7.6 The 2-second CALLING delay

This is the most important UX decision in the agent. From rule-fire to trade-fire there is a 2-second pause where:

- The beam latches.
- The bubble appears with intent text.
- The ticker stays unchanged.

During this pause:

- If price moves enough to break the rule (e.g. gain falls below 15%), the trade aborts. Bubble: "MOVED — PASS." This is a built-in cooler.
- The viewer sees the decision form before it executes. **This is the show.**

Without this pause, trades happen faster than the eye can track. With it, every trade is an event.

### 7.7 Voice narration (v1.1, optional)

When the user toggles voice on, ElevenLabs TTS reads the bubble text out loud at trade time. Drives the existing lip-sync via volume polling. Voice is **never** required for trades to execute. The agent trades silently if no one is listening.

---

## 8. Information architecture — what the viewer learns, in order of glance

| Glance | Question | Answer surface |
|---|---|---|
| 1 | Is the agent alive? | Status badge + beam motion |
| 2 | What's the market doing? | Token tape gain colors |
| 3 | What's Pepe looking at? | Beam target |
| 4 | What did Pepe just do? | Top ticker line + row flash residue |
| 5 | How is Pepe doing today? | P/L pill in header |
| 6 | What does Pepe think? | Bubble during CALLING/TRADING |
| 7 | Long-term track record | (v2 — out of scope here) |

Every glance after the first is faster because the layout never moves.

---

## 9. Onboarding

There isn't any.

A single non-modal first-visit hint can appear (localStorage-flagged): a dotted arrow drawn from the wallet readout to the ticker, with `"PEPE TRADES HIS OWN WALLET. WATCH ↓"`. Dismisses on any input. Never returns.

That's the entire onboarding.

---

## 10. Edge cases

| Situation | Behavior |
|---|---|
| Upstream WS down, REST fallback active | Status: `REST` (amber dim). Beam still moves. Trades still fire (REST data is delayed but valid). |
| Upstream fully down (no WS, no REST) | Status: `STALE`. Tape freezes on last good data. Bubble: "WAITING ON THE TAPE." No new trades. |
| Daily cap exhausted | Bubble: "DONE FOR THE DAY — RESETS AT MIDNIGHT UTC." Beam continues to pulse on top movers; no CALLING. |
| Cooldown active | Silent. No UI change. Internal only. |
| Quoted slippage > cap | Bubble: "SLIPPAGE TOO RICH — PASS." 3s, then back to WATCHING. |
| Wallet below min trade | Bubble: "TANK EMPTY." Header equity flashes amber. |
| Position drops 50% in one tick | Immediate market sell. Bubble: "RUG — OUT." Ticker line in amber. |
| Worker → /api/agent/trade partition | Worker queues intents in Redis with TTL 60s, idempotency keys. Replays on reconnect. No double-execute. |
| Tab backgrounded | Canvas pauses RAF. State store keeps running. Resumes paint on focus. |
| Resize | Recompute scale; re-render once. |
| Kill switch flipped | Every in-flight CALLING aborts; new trades blocked. Bubble: "PAUSED BY HUMAN." |

---

## 11. Performance budget

| Metric | Target | Measurement |
|---|---|---|
| Canvas full-board paint | <4 ms | DevTools Performance, M1 |
| React commit per tick | <8 ms | React Profiler under 6× CPU throttle |
| Time to first matrix paint | <500 ms | Lighthouse cold load |
| SSE first byte | <300 ms median | Vercel logs |
| Trade decision → confirmation visible | <3 s median | End-to-end trace |

---

## 12. Success metrics (v1)

- **Watchability:** median session length ≥ 4 minutes. (Anything shorter means the loop isn't compelling.)
- **Return rate:** 7-day return visit ≥ 25%.
- **Track record:** weekly P/L published transparently — even when negative. Honesty *is* the brand.
- **Uptime:** 99% — board is up even when trading is disabled.
- **Aesthetic resonance:** ≥ 5 organic Twitter posts/screenshots in the first month.

---

## 13. What is NOT in v1

These cuts are deliberate. Each one, if added, makes a different product.

- User wallets / connect-wallet / Privy.
- User-initiated trades.
- Multiple agents.
- Settings, customization, themes.
- Mobile-specific layout (works at scale=1 but not optimized).
- Notifications.
- Account / login.
- Trade history page (only the rolling 3-line ticker).
- Public API for embedders.
- Multi-chain. Solana only.
- ASCII WebGL background (archived to `feat/ascii-bg-revisit`).

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Agent loses real money | Hard caps, kill switch, public on-chain transparency. The float is the brand budget; treat it as such. |
| Single env-var private key | Acceptable ≤5 SOL float. Migrate to Turnkey/Privy server-wallets/AWS KMS once float grows. |
| Upstream `data.cmem.ai` data quality | Sanity check on every quote: if Jupiter price disagrees with feed by >10%, abort the trade. |
| Bad week, public visibility | This is a feature. Team must be aligned that drawdowns are part of the show. |
| Tax / accounting | Log every trade with on-chain proof + USD price at execution. Export as CSV. We are not the agent's accountant. |
| Rug pulls | 50%-drop emergency sell rule + manual blocklist + min-liquidity gate. |

---

## 15. Reference appendix

- **Source repo:** https://github.com/thedotmack/pepe-agent
- **UI kit:** `/Users/alexnewman/Downloads/DotMatrixMobileUIKit.jsx`
- **Live data:** `wss://data.cmem.ai/activity`, REST `https://data.cmem.ai/api/activity/top/50`
- **Activity shapes:** `lib/jupiter/realtime/activity-websocket.ts:7-33` in MemeDeck-OSS
- **Original CLI monitor:** `scripts/activity-monitor.js` in MemeDeck-OSS
- **Implementation plan:** `PLAN-live-board.md` (sibling file)

---

## 16. Open product questions to lock before build

1. **Voice ID.** Default is the southern guy `Bj9UqZbhQsanLzgalpEG` from the existing README. Worth a sample listen to confirm it's the Pepe we want.
2. **Initial float.** Devnet first (free). Then 0.5 SOL or 1.0 SOL on mainnet for the first dogfood?
3. **Worker host.** Fly.io (sub-second reaction, $5/mo) or Vercel Cron (30s cadence, $0)?
4. **First-visit hint.** Worth shipping, or strip it for absolute purity? Bias: ship it once, see if anyone complains.
5. **Memorial mode.** If the agent loses everything, do we silently refund and reset, or leave the board public as a memorial to the run? Bias: leave it. The track record is the product.
6. **Wallet visibility.** Do we publish the agent's address publicly so viewers verify on Solscan? Bias: yes — transparency is the trust mechanism.
7. **Block list curation.** Who decides which tokens are blocked? A flat env-var list for v1; needs a process by v1.5.

---

## 17. The 30-second pitch

You open a tab. A frog is trading memecoins on a glowing scoreboard. He looks at a row, says "I'm in," and a real trade hits his wallet. Two minutes later he sells at +20%. The board never stops. You don't have a wallet here. You don't trade here. You watch.

That's it. That's the whole thing. Ship it.
