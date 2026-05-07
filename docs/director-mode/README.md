# Pepe Director Mode

Pepe Director is the screencast and live-call mode for Pepe HQ. It gives you a clean stage where you can type lines, make Pepe speak them, and capture the output as a virtual camera.

Route: `http://localhost:3010/director`

## Quick Start

```bash
npm install
npm run dev
open http://localhost:3010/director
```

Use Chrome for the most reliable browser speech voices and OBS Browser Source support.

## Make Pepe Talk

1. Open `/director`.
2. Type a sentence in the bottom input.
3. Press Enter.

Pepe lip-syncs while the audio plays. ElevenLabs playback drives the mouth from the real audio signal; browser speech uses estimated lip sync because the browser API does not expose its output stream. The page preloads the full Pepe sprite and eye asset set before showing the character, so frame swaps do not flash during a recording.

## Commands

Director Mode keeps the screen clean. Configuration is done through slash commands in the same input:

| Command | Example |
|---|---|
| `/help` | Show the command list in the status text. |
| `/stop` | Stop the current line. |
| `/engine browser` | Use built-in browser speech. |
| `/engine elevenlabs` | Use ElevenLabs TTS. |
| `/key <api-key>` | Set your ElevenLabs API key for this session. |
| `/voice <voice-id>` | Set the ElevenLabs voice ID for this session. |
| `/model <model-id>` | Set the ElevenLabs model, defaults to `eleven_flash_v2_5`. |
| `/stage studio` | Use the branded studio background. |
| `/stage camera` | Use a black camera background. |
| `/stage chroma` | Use a green chroma key background. |
| `/bubble off` | Hide the speech bubble. Use `/bubble on` to restore it. |

## ElevenLabs BYO Key

Director Mode is open-source friendly: contributors can use their own ElevenLabs key without changing repo config.

1. Type `/key <your-elevenlabs-api-key>` and press Enter.
2. Type `/voice <your-elevenlabs-voice-id>` and press Enter.
3. Optionally type `/model eleven_flash_v2_5`.
4. Type a normal sentence and press Enter.

The key is sent only to the local Next.js API route for that request:

- `POST /api/director/elevenlabs/voices`
- `POST /api/director/elevenlabs/tts`

The app keeps the key in memory for the current browser session only. It does not persist the key in localStorage, repo files, or environment variables.

Generated ElevenLabs audio is cached locally in the browser by model, voice, and line text. Repeating the same line avoids another network round trip and starts playback quickly. The cache does not include or persist the API key.

## Stage Modes

Director Mode has three stage presets:

| Mode | Use |
|---|---|
| `studio` | Default branded Pepe HQ scene for normal screencasts. |
| `camera` | Black background for a clean webcam-style feed. |
| `chroma` | Bright green background for chroma key workflows. |

Use `/bubble on` or `/bubble off` to control the speech bubble above Pepe. The lower caption bar stays visible for readability in recordings.

## Use in Zoom, Google Meet, Discord, or Any Mac App

The practical virtual camera path is OBS Virtual Camera.

1. Install OBS Studio.
2. Start Pepe HQ locally with `npm run dev`.
3. In OBS, add a `Browser Source`.
4. Set the URL to `http://localhost:3010/director`.
5. Set the source size to `1920x1080`.
6. In `/director`, type `/stage camera` or `/stage chroma`.
7. In OBS, click `Start Virtual Camera`.
8. In Zoom, Google Meet, Discord, or another app, select `OBS Virtual Camera`.

OBS references:

- https://obsproject.com/kb/virtual-camera-guide
- https://obsproject.com/kb/virtual-camera-troubleshooting

## Notes for Contributors

- UI route: `app/director/page.tsx`
- ElevenLabs TTS route: `app/api/director/elevenlabs/tts/route.ts`
- ElevenLabs voice list route: `app/api/director/elevenlabs/voices/route.ts`
- Pepe animation component: `components/pepe-head/PepeHead.tsx`

The Director page should keep working without secrets. Browser speech is the fallback, and ElevenLabs remains user-supplied at runtime.

## Native Camera Driver

A true Mac-wide camera device would require a native CoreMediaIO camera extension or DAL plugin. That should live in a separate macOS package if the project decides to own it. OBS Virtual Camera gives the same user-facing behavior for now without shipping a signed system extension.
