# Pepe Agent 🐸

A standalone Next.js app featuring an interactive Pepe frog head floating on an ASCII effect background, powered by **ElevenLabs Conversational AI**.

## Stack

- **Next.js 16** (App Router, TypeScript)
- **React 19**
- **Tailwind CSS v4**
- **Framer Motion** (`motion/react`) — float / blink / eye-tracking animations
- **OGL** — WebGL 2 ASCII background renderer
- **@11labs/client** — ElevenLabs Conversational AI (persistent WebSocket session)

## Features

- 🎨 **WebGL ASCII background** — Perlin noise rendered through an ASCII post-process shader; brightness reacts to Pepe's audio output
- 🐸 **Animated Pepe head** — layered sprites with eye tracking, blinking, float bobbing, and live lip-sync driven by volume
- 🎤 **Conversational AI** — click the mic button to start a duplex voice session with the ElevenLabs agent; Pepe listens and responds in real-time
- 💬 **Transcript bubble** — last agent utterance displayed above Pepe's head

## Getting Started

### 1. Install dependencies

```bash
cd pepe-agent
npm install
```

### 2. Configure ElevenLabs

Copy the example env file and fill in your credentials:

```bash
cp .env.local.example .env.local
```

Create an **ElevenLabs Conversational Agent** at <https://elevenlabs.io/app/conversational-ai>:

- **Voice**: use `Bj9UqZbhQsanLzgalpEG` (southern guy) or any voice you prefer
- **System prompt**: give Pepe a personality — paste phrases from MemeDeck's `lib/pepe/phrases.ts`
- **First message**: `"Sup anon, ready to talk memes?"`

Copy the Agent ID into `ELEVENLABS_AGENT_ID`.

### 3. Run

```bash
npm run dev   # http://localhost:3010
```

Click the **mic button** at the bottom of the screen and start talking.

## Architecture

```
User mic → ElevenLabs Agent WS → Agent response audio
                                         ↓
                               Web Audio AnalyserNode
                               ↙               ↘
                     Mouth frame selection    ASCII background
                     (PepeHead lip sync)      uValue uniform
```

### File structure

```
pepe-agent/
├── app/
│   ├── layout.tsx                  # Root layout
│   ├── page.tsx                    # Main page — wires everything together
│   ├── globals.css
│   └── api/
│       └── agent-token/
│           └── route.ts            # Server route — returns signed ElevenLabs URL
├── components/
│   ├── ascii-background/
│   │   └── index.tsx               # WebGL ASCII renderer
│   ├── pepe-head/
│   │   └── PepeHead.tsx            # Animated Pepe head with lip sync
│   └── agent-ui/
│       └── AgentControls.tsx       # Mic button + status ring
├── lib/
│   └── agent.ts                    # ElevenLabs session manager
├── public/
│   ├── frames/                     # Mouth/body sprite frames
│   └── eyes/                       # Pupil layer stack
├── .env.local.example
└── README.md
```

## Environment Variables

| Variable | Description |
|---|---|
| `ELEVENLABS_API_KEY` | Your ElevenLabs API key (server-side only) |
| `ELEVENLABS_AGENT_ID` | Agent ID from the ElevenLabs dashboard |
