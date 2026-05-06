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
2. Type a line in the `Line` box.
3. Choose a voice engine:
   - `Browser`: no setup, uses `window.speechSynthesis`.
   - `ElevenLabs`: paste your own API key and voice ID.
4. Press `Speak`.

Pepe lip-syncs while the audio plays. The `Stop` button cancels the current line. `Add to Queue` lets you stack lines for a longer screencast.

## ElevenLabs BYO Key

Director Mode is open-source friendly: contributors can use their own ElevenLabs key without changing repo config.

1. Switch the voice engine to `ElevenLabs`.
2. Paste your ElevenLabs API key.
3. Click `Load` to fetch voices for that key, or paste a voice ID directly.
4. Pick a model.
5. Press `Speak`.

The key is sent only to the local Next.js API route for that request:

- `POST /api/director/elevenlabs/voices`
- `POST /api/director/elevenlabs/tts`

The app does not persist the key in localStorage, repo files, or environment variables.

## Stage Modes

Director Mode has three stage presets:

| Mode | Use |
|---|---|
| `studio` | Default branded Pepe HQ scene for normal screencasts. |
| `camera` | Black background for a clean webcam-style feed. |
| `chroma` | Bright green background for chroma key workflows. |

The `Bubble` toggle controls the speech bubble above Pepe. The lower caption bar stays visible for readability in recordings.

## Use in Zoom, Google Meet, Discord, or Any Mac App

The practical virtual camera path is OBS Virtual Camera.

1. Install OBS Studio.
2. Start Pepe HQ locally with `npm run dev`.
3. In OBS, add a `Browser Source`.
4. Set the URL to `http://localhost:3010/director`.
5. Set the source size to `1920x1080`.
6. In `/director`, choose `camera` or `chroma`.
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
