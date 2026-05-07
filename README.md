# Pepe HQ

A standalone Next.js app where Pepe is the show: a 108x192 LED dot-matrix board that makes an autonomous Solana memecoin trading loop legible in real time.

## Stack

- **Next.js 16** App Router
- **React 19**
- **Tailwind CSS v4**
- **Canvas dot-matrix renderer** for the live board
- **motion/react** for Pepe blink, float, eye tracking, and lip sync
- **@11labs/client** for optional voice narration
- **SSE feed bridge** over the `data.cmem.ai` activity WebSocket with REST fallback

## Product Shape

- One screen: no routes, login, wallet connect, menus, or cockpit controls.
- The matrix owns the UI: header, live status, wallet/P&L, token tape, beam, decision bubble, ticker, and service dots are all drawn into the board.
- Pepe is layered over the HQ habitat and can still run the optional ElevenLabs voice session by double-clicking the sprite.
- If the upstream feed is unavailable, the board keeps breathing with a demo tape instead of showing an empty state.

## Run

```bash
npm install
npm run dev
```

Local app: <http://localhost:3010>

## Director Mode

Pepe Director is a screencast and live-call stage where you can type lines and make Pepe speak them with browser speech or a contributor-owned ElevenLabs key.

```bash
npm run dev
open http://localhost:3010/director
```

For OBS Virtual Camera setup, ElevenLabs BYO-key usage, and contributor notes, see [docs/director-mode/README.md](docs/director-mode/README.md).

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `ELEVENLABS_API_KEY` | Server-side ElevenLabs API key for optional voice | none |
| `ELEVENLABS_AGENT_ID` | ElevenLabs conversational agent ID | none |
| `ELEVENLABS_DIRECTOR_VOICE_ID` | Server-side Director voice override | none |
| `ELEVENLABS_DIRECTOR_MODEL_ID` | Server-side Director model override | `eleven_flash_v2_5` |
| `NEXT_PUBLIC_ELEVENLABS_DIRECTOR_ENABLED` | Start Director in ElevenLabs mode when set to `1` | none |
| `NEXT_PUBLIC_ELEVENLABS_DIRECTOR_VOICE_ID` | Browser-visible Director voice id for cache keys and defaults | none |
| `NEXT_PUBLIC_ELEVENLABS_DIRECTOR_MODEL_ID` | Browser-visible Director model id for cache keys and defaults | `eleven_flash_v2_5` |
| `ACTIVITY_WS_UPSTREAM_URL` | Upstream activity WebSocket | `wss://data.cmem.ai/activity` |
| `ACTIVITY_REST_FALLBACK_URL` | REST fallback polled when WS is unavailable | `https://data.cmem.ai/api/activity/top/50` |

## Key Files

| File | Purpose |
|---|---|
| `app/page.tsx` | Main one-screen board composition |
| `app/api/feed/route.ts` | SSE bridge for live activity data |
| `components/dot-board/DotMatrixCanvas.tsx` | Canvas renderer for the 108x192 matrix |
| `components/dot-board/use-activity-feed.ts` | EventSource client store |
| `lib/dot-matrix/render-board.ts` | Board layout and animation drawing |
| `components/pepe-head/PepeHead.tsx` | Pepe sprite, blink, float, eye tracking, and lip sync |
