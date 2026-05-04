# Plan: Pepe-Agent Live Tradeable Board (dot-matrix UI)

**Goal:** Extend `thedotmack/pepe-agent` so the floating Pepe head becomes the visible *agent autonomously trading* a real-time activity board. The whole screen is a **108×192 LED dot-matrix** rendered from `DotMatrixMobileUIKit.jsx`. The agent runs server-side with its own wallet; the UI is the audience seat.

**Design winner: "Pepe HQ"** (see PLAN-design-mockups section in this file or design notes). Pepe floats in a dedicated lower habitat; a dot-matrix beam connects his eye to the row he's analyzing; trades flash the row and append to a ticker in his HQ.

**No `create-next-app`.** The repo already is a Next.js 16 / React 19 / Tailwind v4 app. We add modules to it.

**ASCII background is retired (not deleted).** Move `components/ascii-background/` to a `feat/ascii-bg-revisit` branch and remove the import from `app/page.tsx`. The dot-matrix renderer covers the full screen.

**Source artifacts:**
- Repo: https://github.com/thedotmack/pepe-agent (default branch `main`)
- UI kit: `/Users/alexnewman/Downloads/DotMatrixMobileUIKit.jsx`
- Data sources (reuse from MemeDeck-OSS):
  - WS: `wss://data.cmem.ai/activity` — `lib/jupiter/realtime/activity-websocket.ts:7-33` for shapes
  - REST: `https://data.cmem.ai/api/activity/top/50`
  - Terminal reference: `scripts/activity-monitor.js`

---

## Phase 0 — Documentation Discovery + repo orientation

### 0.1 Source-of-truth citations

- Next.js Route Handler streaming (`ReadableStream`) — https://nextjs.org/docs/app/api-reference/file-conventions/route
- Vercel streaming functions — https://vercel.com/docs/functions/streaming-functions
- Vercel function limits (Node maxDuration 300s Hobby / up to 800s Pro; Edge 25s first byte) — https://vercel.com/docs/functions/limitations
- Route segment config (`dynamic`, `revalidate`; v16 Cache Components caveat) — https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config
- ElevenLabs client tools (function calling from voice) — https://elevenlabs.io/docs/conversational-ai/customization/tools/client-tools

### 0.2 Allowed primitives

| Need | Use | Don't use |
|---|---|---|
| Real-time fan-out | **SSE** in a Node-runtime Route Handler | Raw `ws` server (Vercel doesn't document WebSocket *server* support) |
| Drawing the board | DotMatrixMobileUIKit primitives (`drawText`, `drawCard`, `drawBadge`, `drawPanel`, `drawIcon`, `drawPhoto`) | DOM elements, shadcn, Tailwind classes for board content |
| Per-dot render | **`<canvas>`** (see Phase 2.3) | The kit's per-dot `<span>` grid for live data — 20,736 spans × N updates/sec is unrenderable |
| Voice → trade | ElevenLabs **client tools** | Raw text parsing of transcripts |
| Cache opt-out | `export const dynamic = 'force-dynamic'` + `Cache-Control: no-store` | Default fetch caching |

### 0.3 Repo orientation (already verified)

- `app/page.tsx` — top-level client component; layers ASCII bg → PepeHead → AgentControls
- `lib/agent.ts` — `PepeAgent` wraps `Conversation.startSession()`; exposes `onVolume`, `onTranscript`, `onStatusChange`
- `app/api/agent-token/route.ts` — server route returning signed ElevenLabs URL
- `components/pepe-head/PepeHead.tsx` — sprite-based head with lip sync from `volume` prop
- `components/ascii-background/index.tsx` — OGL/WebGL noise+ASCII shader (audioIntensity prop)
- Stack: Next 16, React 19, Tailwind v4, motion 12, ogl 1.0, @elevenlabs/client 1.4. Dev port 3010.

### 0.4 Anti-patterns to flag in every later phase

- Rendering 20,736 `<span>`s per tick — use canvas.
- Inventing Vercel WS server support — there is none documented.
- Holding an SSE stream past `maxDuration` — client must reconnect (`EventSource` does so automatically).
- Edge runtime for slow first-byte feeds — 25s deadline.
- Forgetting `Cache-Control: no-store` — Vercel CDN may buffer.
- Putting `ELEVENLABS_API_KEY` or any RPC key in `NEXT_PUBLIC_*`.

---

## Phase 1 — Fork the repo + drop the kit in

### What to do

```bash
cd /Users/alexnewman/Scripts
gh repo clone thedotmack/pepe-agent
cd pepe-agent
git checkout -b feat/live-board

# Drop the UI kit in as a TypeScript module.
mkdir -p lib/dot-matrix
cp /Users/alexnewman/Downloads/DotMatrixMobileUIKit.jsx lib/dot-matrix/dot-matrix-ui-kit.tsx
# Add 'use client' at top; convert exports to TS-friendly types in Phase 2.

pnpm install      # or npm/yarn — match what the repo uses (lockfile detection)
pnpm dev          # http://localhost:3010 — confirm Pepe boots
```

### Vercel project setup

```bash
vercel link        # creates .vercel/project.json
vercel env pull .env.local
# Set in Vercel dashboard (Production + Preview):
#   ELEVENLABS_API_KEY            (existing)
#   ELEVENLABS_AGENT_ID           (existing)
#   ACTIVITY_WS_UPSTREAM_URL      = wss://data.cmem.ai/activity
#   ACTIVITY_REST_FALLBACK_URL    = https://data.cmem.ai/api/activity/top/50
#   MEMEDECK_JUPITER_PROXY_URL    (server-only)
```

### Verification

- `pnpm dev` → Pepe head + ASCII bg loads on `:3010`.
- `vercel` (preview) returns a `*.vercel.app` URL, mic button works (existing flow).
- `lib/dot-matrix/dot-matrix-ui-kit.tsx` imports cleanly with `pnpm typecheck`.

### Anti-pattern guards

- Don't rename the existing components or change the agent flow — the live board is **additive**.
- Don't bring in shadcn — board is dots, controls already use Tailwind.
- Don't bump `next`/`react` — already on 16/19.

---

## Phase 2 — Convert the kit to a typed module + canvas renderer

### What to implement

**2.1** Convert `lib/dot-matrix/dot-matrix-ui-kit.tsx` to TS:

- Add `"use client"` at the top.
- Type the cell shape: `type Cell = { tone: keyof typeof COLORS; level: number }` and use it on `createMatrix`, `setDot`, `drawPanel`, etc.
- Re-export `DOT_BOARD`, `COLORS`, `FONTS`, `ICONS`, all `draw*` helpers, and `useDitheredPhoto`.
- **Keep the `LedDot` + `DotMatrixBoard` exports** for the static intro/tutorial screens — they're fine for a one-shot render.

**2.2** Add a canvas-based renderer for the live board: `components/dot-board/DotMatrixCanvas.tsx`.

```tsx
// components/dot-board/DotMatrixCanvas.tsx
"use client";
import { useEffect, useRef } from "react";
import { DOT_BOARD, COLORS } from "@/lib/dot-matrix/dot-matrix-ui-kit";
import type { Cell } from "@/lib/dot-matrix/dot-matrix-ui-kit";

const PIXEL = DOT_BOARD.dotSize + DOT_BOARD.gap;

export function DotMatrixCanvas({ matrix, scale = 1 }: { matrix: Cell[][]; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const W = DOT_BOARD.cols * PIXEL * scale;
    const H = DOT_BOARD.rows * PIXEL * scale;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    for (let y = 0; y < DOT_BOARD.rows; y++) {
      for (let x = 0; x < DOT_BOARD.cols; x++) {
        const cell = matrix[y][x];
        if (cell.tone === "off" && cell.level === 0) continue;
        const color = COLORS[cell.tone] ?? COLORS.off;
        ctx.globalAlpha = Math.max(0.18, cell.level);
        ctx.fillStyle = color;
        const px = x * PIXEL * scale;
        const py = y * PIXEL * scale;
        const size = DOT_BOARD.dotSize * scale;
        // Round dots: arc is ~3× slower than fillRect at this density. Use rect.
        ctx.fillRect(px, py, size, size);
      }
    }
    ctx.globalAlpha = 1;
  }, [matrix, scale]);

  return <canvas ref={ref} aria-label="Live trading dot-matrix board" />;
}
```

**2.3** Render-loop strategy:

- Build the matrix in a worker-thread-free helper (e.g. `lib/dot-matrix/render-board.ts`) that takes `(rows: ActivityToken[], state: BoardState) => Cell[][]`.
- The hook in Phase 4 owns a `Cell[][]` ref + a 30 fps `requestAnimationFrame` loop that *only* re-runs the helper if the underlying state changed (dirty flag set by SSE event handler). This decouples React renders from the canvas paint.
- Don't depend on React state for matrix data — it's 108×192. Use a ref and trigger redraw via a frame counter `useState`.

### Verification

- `pnpm typecheck` passes.
- A storybook-style page at `app/(dev)/kit/page.tsx` renders `DotMatrixBoard` (DOM) and `DotMatrixCanvas` (canvas) side by side with the kit's example screen — they look identical.
- DevTools Performance: canvas redraw of full board < 4ms on M1.

### Anti-pattern guards

- Don't try to reuse `<LedDot>` for the live board — it's 20k DOM nodes.
- Don't render the canvas inside `<motion.div>` with layout animation — let `transform` animate the wrapper, not children.

---

## Phase 3 — SSE feed endpoint (server bridge to data.cmem.ai)

### What to implement

`app/api/feed/route.ts` — opens a per-request **client** WebSocket to `wss://data.cmem.ai/activity`, forwards each `ActivityMessage` as SSE; falls back to REST polling if upstream WS fails.

```ts
// app/api/feed/route.ts
import { NextRequest } from "next/server";
import WebSocket from "ws";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  const wsUrl = process.env.ACTIVITY_WS_UPSTREAM_URL!;
  const restUrl = process.env.ACTIVITY_REST_FALLBACK_URL!;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      send("hello", { ts: Date.now() });

      let timer: NodeJS.Timeout | null = null;
      let upstream: WebSocket | null = null;

      const startWs = () => {
        upstream = new WebSocket(wsUrl);
        upstream.on("message", (buf) => send("tokens", JSON.parse(buf.toString())));
        upstream.on("close", () => startRest());
        upstream.on("error", () => upstream?.close());
        timer = setInterval(() => send("ping", { ts: Date.now() }), 15_000);
      };
      const startRest = () => {
        const tick = async () => {
          try {
            const r = await fetch(restUrl, { cache: "no-store" });
            send("tokens", { type: "update", data: await r.json(), timestamp: Date.now() });
          } catch (e) { send("error", { message: String(e) }); }
        };
        tick();
        timer = setInterval(tick, 1500);
      };
      startWs();

      req.signal.addEventListener("abort", () => {
        if (timer) clearInterval(timer);
        upstream?.close();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

Add `ws` to deps: `pnpm add ws && pnpm add -D @types/ws`.

### Verification

- `curl -N http://localhost:3010/api/feed` → `event: hello`, then a stream of `event: tokens`.
- Block `data.cmem.ai` in `/etc/hosts` → REST fallback engages within 2s.
- Disconnect curl → server logs show abort handler cleared interval and closed upstream.

### Anti-pattern guards

- Do not start the WS at module scope. One per request, owned by `start()`.
- Do not maintain a global `Set<Controller>` for fan-out. If concurrency >100 per region or upstream rate-limits, add Upstash Redis pub/sub later — not now.

---

## Phase 4 — `useActivityFeed` + board layout

### 4.1 Hook

`components/dot-board/use-activity-feed.ts` — opens `EventSource('/api/feed')`, reduces `tokens` events into a `Map<tokenId, ActivityToken>`, exposes `{ rows, status, lastUpdated }`. Buffer events for 100ms, then commit one update.

```ts
"use client";
import { useEffect, useRef, useSyncExternalStore } from "react";

export type ActivityToken = {
  tokenId: string; symbol: string; name: string; price: number;
  liquidity: number; volume24h: number;
  oneMinGain: number; threeMinGain: number; fiveMinGain: number;
  buyPressure5m: number; updatesPerMinute: number; signal: string;
  // Match shapes from MemeDeck-OSS lib/jupiter/realtime/activity-websocket.ts:7-27
};
type Status = "connecting" | "live" | "reconnecting" | "rest-fallback" | "stale";

class FeedStore {
  private map = new Map<string, ActivityToken>();
  private listeners = new Set<() => void>();
  status: Status = "connecting";
  lastUpdated = 0;
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => ({ rows: Array.from(this.map.values()), status: this.status, lastUpdated: this.lastUpdated });
  ingest(tokens: ActivityToken[]) {
    for (const t of tokens) this.map.set(t.tokenId, t);
    this.lastUpdated = Date.now();
    this.status = "live";
    this.listeners.forEach((l) => l());
  }
  setStatus(s: Status) { this.status = s; this.listeners.forEach((l) => l()); }
}

export function useActivityFeed() {
  const storeRef = useRef<FeedStore>();
  if (!storeRef.current) storeRef.current = new FeedStore();
  const store = storeRef.current;

  useEffect(() => {
    const es = new EventSource("/api/feed");
    let buf: ActivityToken[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => { if (buf.length) { store.ingest(buf); buf = []; } flushTimer = null; };

    es.addEventListener("tokens", (e) => {
      const payload = JSON.parse((e as MessageEvent).data);
      buf = buf.concat(payload.data ?? []);
      if (!flushTimer) flushTimer = setTimeout(flush, 100);
    });
    es.addEventListener("error", () => store.setStatus("reconnecting"));
    es.addEventListener("ping", () => {/* keep-alive */});
    return () => { es.close(); if (flushTimer) clearTimeout(flushTimer); };
  }, [store]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
```

### 4.2 Board layout (using kit primitives)

`lib/dot-matrix/render-board.ts`:

```ts
import { DotMatrixKit, DOT_BOARD } from "./dot-matrix-ui-kit";
import type { ActivityToken } from "@/components/dot-board/use-activity-feed";

const { createMatrix, drawText, drawPanel, drawBadge, drawIcon, drawLine } = DotMatrixKit;

export function renderBoard(rows: ActivityToken[], opts: {
  status: "live" | "reconnecting" | "rest-fallback" | "stale" | "connecting";
  selectedTokenId?: string;
  pepeIsSpeaking: boolean;
}) {
  const m = createMatrix();
  // Header (rows 0-12): "PEPE BOARD" + clock + status
  drawText(m, "PEPE BOARD", 6, 4, { font: "lg", tone: "cyan", level: 0.95 });
  const statusTone = opts.status === "live" ? "cyan" : opts.status === "rest-fallback" ? "amber" : "dim";
  drawBadge(m, 78, 4, opts.status.toUpperCase(), { tone: statusTone, active: opts.status === "live", width: 24 });

  // Token rows (rows 16-170): one per token, 12px tall
  const ROW_HEIGHT = 14;
  const MAX_VISIBLE = Math.floor((170 - 16) / ROW_HEIGHT); // ~11 rows
  rows.slice(0, MAX_VISIBLE).forEach((t, i) => {
    const y = 16 + i * ROW_HEIGHT;
    const active = t.tokenId === opts.selectedTokenId;
    drawPanel(m, 4, y, 100, ROW_HEIGHT - 1, { tone: "blue", level: active ? 0.7 : 0.32, active });
    drawText(m, t.symbol.slice(0, 6), 7, y + 3, { font: "md", tone: "white", level: 0.95, maxWidth: 30 });
    drawText(m, formatPrice(t.price), 38, y + 4, { font: "sm", tone: "cyan", level: 0.85, maxWidth: 24 });
    const gainTone = t.fiveMinGain >= 0 ? "cyan" : "amber";
    drawText(m, formatGain(t.fiveMinGain), 64, y + 4, { font: "sm", tone: gainTone, level: 0.9, maxWidth: 18 });
    // buy-pressure bar
    const barW = Math.round(Math.min(1, Math.max(0, t.buyPressure5m)) * 16);
    drawLine(m, 84, y + 6, barW, "cyan", 0.85);
    drawLine(m, 84 + barW, y + 6, 16 - barW, "ghost", 0.3);
  });

  // Footer (rows 172-191): pepe status + nav
  drawText(m, opts.pepeIsSpeaking ? "PEPE: TRADING" : "PEPE: WATCHING", 6, 178, {
    font: "sm", tone: opts.pepeIsSpeaking ? "amber" : "dim", level: 0.8,
  });
  return m;
}

function formatPrice(p: number) { return p < 0.01 ? p.toExponential(1) : p.toFixed(4); }
function formatGain(g: number)  { return `${g >= 0 ? "+" : ""}${(g * 100).toFixed(0)}%`; }
```

### 4.3 "Pepe HQ" composition in `app/page.tsx`

ASCII background is **detached** in this phase (`git mv components/ascii-background components/.archived/ascii-background` or simply remove the import). The dot-matrix canvas is the entire screen.

Layer stack (z-index ascending), all centered in the same pixel space so the beam math works:

1. **Layer 0:** `<DotMatrixCanvas>` — full-screen on mobile, scale 2–3 centered on desktop. Renders header, rows, beam, transcript-bubble panel, and ticker. Pepe's *frame* (the empty habitat panel at the bottom) is drawn here too — but **not the sprite itself**.
2. **Layer 1:** `<PepeHead>` — absolutely positioned over the habitat panel coordinates from layer 0. Keeps its existing float (`Math.sin(t) * 6`), blink, eye-tracking, and lip-sync. Width/height match the kit panel.
3. **Layer 2:** Voice mic button (existing `AgentControls`) — kept but optional in v1; agent runs autonomously without user voice.

Coordinate handoff: export the habitat panel's pixel rect from `renderBoard()` so React knows where to place Pepe's DOM element. Something like:

```ts
export function renderBoard(...): { matrix: Cell[][]; pepeFrame: { x: number; y: number; w: number; h: number } } { ... }
```

Then in `app/page.tsx`:

```tsx
const { matrix, pepeFrame } = useMemo(() => renderBoard(rows, state), [rows, state]);
const PIXEL = DOT_BOARD.dotSize + DOT_BOARD.gap;
const px = (n: number) => n * PIXEL * scale;
return (
  <main className="relative h-screen w-screen bg-[#03070d] grid place-items-center">
    <div className="relative">
      <DotMatrixCanvas matrix={matrix} scale={scale} />
      <div className="absolute" style={{ left: px(pepeFrame.x), top: px(pepeFrame.y), width: px(pepeFrame.w), height: px(pepeFrame.h) }}>
        <PepeHead volume={agentVolume} isSpeaking={agentIsSpeaking} transcript={null /* drawn into the matrix instead */} />
      </div>
    </div>
  </main>
);
```

### 4.4 The selection beam

In `renderBoard()`, after rendering rows and Pepe's habitat frame, draw the beam from Pepe's "eye anchor" (a fixed point inside the habitat) to the active row's right edge. Use `drawLine` + `drawVerticalLine` in a stair-stepped path so it reads as discrete dots, not a smooth diagonal.

```ts
function drawBeam(m: Cell[][], from: {x:number;y:number}, to: {x:number;y:number}, t: number) {
  // t = phase 0..1 from a sin wave for pulse animation; modulate level.
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  let x = from.x, y = from.y;
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  for (let i = 0; i < steps; i += 2) { // every other dot = "laser-dot" feel
    setDot(m, x, y, "cyan", 0.4 + 0.5 * Math.abs(Math.sin(t * Math.PI * 2 + i * 0.3)));
    if (i % 3 === 0 && x !== to.x) x += dx;
    else if (y !== to.y) y += dy;
    else x += dx;
  }
}
```

### 4.5 Three paint modes (driven by agent state from Phase 5)

| Mode | Beam | Row flash | Pepe sprite | Bubble |
|---|---|---|---|---|
| `WATCHING` | Pulses softly between top-3 rows on a 2s cycle | none | closed-mouth, slow blink | hidden |
| `CALLING` | Latched on one row | none | mid-mouth | "MOG IS COILED FOR A PUMP — IM IN HALF SOL" |
| `TRADING` | Latched, brighter | amber flash 600ms | open-mouth | trade summary; ticker line prepended |

### Verification

- Open page → board renders 11 rows that update without flicker.
- Status badge flips `LIVE` → `RECONNECTING` when network is offline → `LIVE` on restore within 2s.
- Pepe head stays floating + blinks + lip-syncs when speaking.
- React Profiler: page-level commit < 8ms per tick under 6× CPU throttle.

### Anti-pattern guards

- Do not subscribe per-row to the feed. One `useActivityFeed()` per page.
- Do not animate the canvas with motion's layout animation — only `transform` on the wrapper.
- Do not include all rows in dependency arrays — pass via ref to the canvas.

---

## Phase 5 — Autonomous server-side trading agent

**No user wallet. No Privy. No browser signing.** A server-held custodial agent wallet executes trades when the agent decides to. The UI broadcasts what just happened.

### 5.1 Agent wallet (server-only)

- Generate a fresh Solana keypair: `solana-keygen new -o agent-wallet.json` (do **not** commit). Take the secret key bytes and base58-encode them.
- Set `AGENT_WALLET_PRIVATE_KEY_BASE58` in Vercel env (Production + Preview, encrypted at rest).
- Fund it with a small float (e.g. 1 SOL on devnet, 0.5 SOL on mainnet for first dogfood).
- Set `AGENT_WALLET_PUBLIC_KEY` (derivable, but cache it for log lines and the header display).

**Security stance for v1:** single env-var key. Acceptable for a small float because (a) Vercel encrypts env vars at rest, (b) the server never echoes the key, (c) trade caps below limit blast radius. **Do not** store more than the agent's working capital. Plan a Phase 8 migration to a managed signer (Turnkey, Privy server-wallets, AWS KMS+custom signer) if the float crosses ~5 SOL.

### 5.2 Trade caps + safety rails (`lib/agent/trade-policy.ts`)

```ts
export const TRADE_POLICY = {
  perTradeMaxSol: 0.25,
  dailyMaxSol: 2.0,
  cooldownMs: 30_000,           // min time between trades
  maxOpenPositions: 5,
  defaultSlippageBps: 100,      // 1%
  hardSlippageCapBps: 300,
  blockedTokenIds: new Set<string>(),
};
```

Enforce in the `/api/trade` handler — **before** signing — and reject with 4xx if any cap would trip. Persist `dailyMaxSol` consumption in a small server store: Upstash Redis if available, else a flat file `.cache/agent-trades-YYYY-MM-DD.json` for dev. Reset at UTC midnight.

### 5.3 Server endpoints

```
POST /api/agent/trade        body: { tokenId, side, amountSol, slippageBps? }
                              auth: x-agent-secret header (shared between agent loop & route; not exposed to browser)
                              returns: { signature, route, outAmount, txUrl }

GET  /api/agent/state         returns: { walletPubkey, equitySol, pnlUsd, openPositions, dailyUsedSol, lastTradeAt, recentTrades: TradeLog[] }
                              public — drives the header + ticker on the board

GET  /api/feed                (Phase 3 — unchanged)
```

`/api/agent/trade` flow:

1. Parse body, validate caps via `TRADE_POLICY`.
2. Fetch quote from MemeDeck Jupiter proxy (`MEMEDECK_JUPITER_PROXY_URL`).
3. Reject if quoted slippage > `hardSlippageCapBps`.
4. Build the transaction (Jupiter returns a serialized v0 tx).
5. Sign with `Keypair.fromSecretKey(bs58.decode(process.env.AGENT_WALLET_PRIVATE_KEY_BASE58!))`.
6. Submit via the proxy or a configured RPC. Return signature.
7. Append a `TradeLog` row to the agent state store.

### 5.4 Decision loop (`lib/agent/loop.ts`)

This is the brain. It runs server-side, polls the same `/api/feed` data (or directly subscribes to the upstream WS), evaluates rules, and POSTs to `/api/agent/trade`.

Two execution options — pick one:

- **A. Vercel Cron job** every 30s hits `/api/agent/tick`. Simple, fits free tier, but minimum 30s granularity.
- **B. Long-lived worker on Fly.io / Railway / Render.** Subscribes directly to `wss://data.cmem.ai/activity`, calls `/api/agent/trade` via internal URL when a rule fires. Sub-second reaction. **Recommended** because the whole point is a *live* board that reacts.

Default to **B**. Build a thin `Dockerfile` in the pepe-agent repo at `worker/` that runs `pnpm tsx lib/agent/loop.ts`. Deploy to Fly with `fly launch`.

Rule v1 (deliberately simple — refine later):

```ts
function shouldBuy(t: ActivityToken, state: AgentState): boolean {
  return (
    t.fiveMinGain > 0.15 &&
    t.buyPressure5m > 0.7 &&
    t.liquidity > 50_000 &&
    t.updatesPerMinute > 20 &&
    !state.openPositions.has(t.tokenId) &&
    state.openPositions.size < TRADE_POLICY.maxOpenPositions
  );
}
function shouldSell(pos: Position, t: ActivityToken): boolean {
  const pnlPct = (t.price - pos.entryPrice) / pos.entryPrice;
  return pnlPct > 0.30 || pnlPct < -0.15; // +30% take-profit or −15% stop
}
```

### 5.5 ElevenLabs voice — kept but optional

Voice flow stays for color commentary: when a trade fires, the worker can hit `/api/agent/say` with a one-liner like "MOG just ripped 30% — taking it" and the ElevenLabs session in the browser narrates it. **Not required for v1 trading**; the agent trades without anyone listening.

### 5.6 Visual feedback (in `renderBoard`)

`useAgentState()` (mirror of `useActivityFeed` but pointing at `/api/agent/state` via SSE or 1s poll) feeds `renderBoard` with:

- `walletEquitySol`, `pnlUsd` → header
- `openPositions: Set<tokenId>` → rows with open positions get a `▲ HOLD` badge
- `recentTrades` → ticker lines in Pepe HQ
- `mode: 'watching' | 'calling' | 'trading'` → drives the three paint modes from 4.5
- `selectedTokenId` → beam target

### Verification

- `curl -X POST http://localhost:3010/api/agent/trade -H 'x-agent-secret: ...' -d '{"tokenId":"...","side":"buy","amountSol":0.05}'` → returns a real Solana signature on devnet, viewable on Solscan.
- Trip a cap intentionally (`amountSol: 1.0` with `perTradeMaxSol: 0.25`) → 4xx with clear reason.
- Worker boots, subscribes to upstream WS, prints `tick` lines, fires a buy when a token meets `shouldBuy` rule.
- Board shows `▲ HOLD` badge on the bought token, ticker line appears within 2s.
- Daily cap test: simulate 9 small trades to exhaust `dailyMaxSol` → 10th rejects.

### Anti-pattern guards

- Never expose `AGENT_WALLET_PRIVATE_KEY_BASE58` to a client component or `NEXT_PUBLIC_*` var.
- Never let `/api/agent/trade` run without `x-agent-secret` validation.
- Never skip the slippage hard cap.
- Never persist trade-cap counters in-process — use Redis or a flat file. Serverless functions are ephemeral.
- Never bypass the policy module by reaching into Jupiter directly from the worker — always go through `/api/agent/trade` so the caps are the single source of truth.

---

## Phase 6 — Polish + production

- `vercel.json` regions pinned near `data.cmem.ai`.
- OG image: render the dot-matrix board to PNG via `next/og` (route `app/opengraph-image.tsx`).
- `app/loading.tsx` + `app/error.tsx` for the live board route.
- Domain: `pepe.<your-domain>` or default `*.vercel.app`.
- README updates: new env vars table, voice-command reference card.

---

## Phase 7 — Final verification

- [ ] `curl -N https://<prod>/api/feed` streams `tokens` for >60s.
- [ ] Two browsers see synchronized rows within 1s.
- [ ] Disable network 10s — both reconnect cleanly.
- [ ] `pnpm typecheck` and `pnpm lint` pass with zero errors.
- [ ] `grep -rn "new WebSocket" .` returns ONLY `app/api/feed/route.ts`.
- [ ] `grep -rn "NEXT_PUBLIC_.*KEY\|NEXT_PUBLIC_.*SECRET" .` returns nothing.
- [ ] Voice: "buy 0.1 sol of $X" → on-chain tx confirmed (devnet first, then mainnet $5 dogfood).
- [ ] Lighthouse mobile ≥ 85 (canvas + WebGL background limit headroom — accept).
- [ ] 1h soak: zero `FUNCTION_INVOCATION_TIMEOUT` in Vercel logs.

---

## Open questions to confirm before Phase 1

1. **PR target:** open against `thedotmack/pepe-agent` `main` directly, or fork to your account first?
2. **Worker host:** Fly.io (recommended for sub-second reaction) or Vercel Cron (30s granularity, simpler)?
3. **Network for first trades:** devnet for Phase 5 dogfood, then mainnet with 0.5 SOL float for Phase 7?
4. **Voice in v1:** keep ElevenLabs narration on every trade (yes/no)? Plan currently keeps it as optional; the agent trades without it.
5. **Mobile scale:** `scale=1` (~324×576px) or `scale=2`? Affects which font sizes the kit needs to support.
