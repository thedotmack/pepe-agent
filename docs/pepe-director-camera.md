# Pepe Director Camera

`/director` is a live-performance page for screencasts and calls. Type a line, press Speak, and Pepe lip-syncs while the browser or ElevenLabs speaks the line.

## Local Run

```bash
npm run dev
open http://localhost:3010/director
```

Use Chrome for the most predictable browser `speechSynthesis` voice list.

## ElevenLabs BYO Key

Pepe Director supports contributor-owned ElevenLabs keys:

1. Switch the voice engine to `ElevenLabs`.
2. Paste your ElevenLabs API key.
3. Click `Load` to fetch voices for that key, or paste a voice ID directly.
4. Pick a model and press `Speak`.

The key is sent to the local Next.js route for that request and is not persisted in localStorage, repo files, or environment variables.

## OBS Virtual Camera

The practical macOS path is OBS Virtual Camera:

1. Open OBS Studio.
2. Add a Browser Source pointed at `http://localhost:3010/director`.
3. Set the browser source size to `1920x1080`.
4. In Pepe Director, choose `camera` or `chroma` stage mode.
5. In OBS, click `Start Virtual Camera`.
6. In Zoom, Google Meet, Discord, or other apps, select `OBS Virtual Camera`.

OBS's own docs describe Virtual Camera as a way to send OBS output as a camera source to other applications:

- https://obsproject.com/kb/virtual-camera-guide
- https://obsproject.com/kb/virtual-camera-troubleshooting

## Native Camera Driver Note

A real Mac-wide faux camera device is a native CoreMediaIO camera extension or DAL plugin, not a Next.js feature. That should live in a separate macOS package if we decide to own it. For now, OBS gives us the same user-facing behavior without shipping a signed system extension.
