# Pepe Launch Council - Phased Implementation Plan

**Status:** first UI slice implemented
**Goal:** Turn the tweet sketch into a usable Pepe HQ surface for community chat, daily token drafting, vote-based launch readiness, and a human-reviewed Bags launch path.

## Phase 0 - Documentation Discovery

### Sources consulted

- Existing product brief: `BRIEF-pepe-hq.md`
- Current app surface: `app/page.tsx`, `lib/dot-matrix/render-board.ts`, `components/dot-board/DotMatrixCanvas.tsx`
- Bags launch intent docs: `https://docs.bags.fm/how-to-guides/create-launch-intent`
- Bags API intro: `https://docs.bags.fm/api-reference/introduction`

### Allowed APIs and patterns

- Keep the Pepe board as the primary live show surface: canvas matrix plus `PepeHead`.
- Use the existing `PepeAgent` chat transport for "ask Pepe" actions.
- For Bags launches, use a launch intent URL first. The official docs say `intent=true` is required, no API key is required for intent URLs, and supported query params include `name`, `ticker`, `description`, `image`, `initialBuy`, `feeShareEnabled`, `feeShareType`, and JSON `feeShare`.
- Do not put private keys or API keys in the browser. Launch signing and final review stay on Bags.

### Anti-pattern guards

- Do not auto-launch a token from the browser.
- Do not invent unsupported Bags query parameters.
- Do not expose wallet private keys, RPC credentials, or Bags API keys through `NEXT_PUBLIC_*`.
- Do not replace the dot-matrix board with a landing page.

## Phase 1 - Launch Intent Helper

### What to implement

- Add `lib/bags/launch-intent.ts`.
- Copy the documented Bags URL construction pattern: `new URL("/launch", "https://bags.fm")`, `intent=true`, scalar setters, boolean setters, and JSON serialization for `feeShare`.
- Normalize ticker client-side to alphanumeric uppercase, max 10 chars.
- Trim token name to max 32 chars.

### Verification

- `npm run typecheck`
- Inspect generated links and confirm they start with `https://bags.fm/launch?intent=true`.

## Phase 2 - Community Launch Console

### What to implement

- Add `components/community-launch/LaunchCouncil.tsx`.
- Include a daily launch status strip, local community vote controls, token draft editor, lightweight community chat, "Ask Pepe to judge", and "Review on Bags".
- Seed the draft from the active live-tape token when available.
- Keep final launch as a Bags review link, not an automated transaction.

### Verification

- `npm run typecheck`
- `npm run build`
- Browser check desktop and mobile to ensure the overlay does not blank or hide the primary board.

## Phase 3 - Page Integration

### What to implement

- Mount `LaunchCouncil` in `app/page.tsx` as a responsive overlay.
- Refactor chat submission into `sendTextToPepe()` so dot-matrix input and council actions share the same agent path.
- Reserve desktop board space behind the overlay so the panel does not cover the board center.

### Verification

- Send a message from the dot-matrix input.
- Click "Ask Pepe to judge" and confirm it appears in the board chat log.
- Click "Review on Bags" and confirm Bags opens with launch fields prefilled.

## Phase 4 - Future Backend Reality

### What to implement later

- Persist community messages and votes server-side.
- Add authenticated room membership.
- Add a daily launch scheduler with explicit human approval.
- Add partner key support only after server-side config and validation exist.
- Emit launch intents to Claude-Mem as observations for continuity.

### Anti-pattern guards

- Do not move signing into the community chat.
- Do not make quorum imply launch execution.
- Do not trust client-side vote counts for real governance.
