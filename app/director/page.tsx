"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import PepeHead from "@/components/pepe-head/PepeHead";

type StageMode = "studio" | "camera" | "chroma";
type SpeechEngine = "browser" | "elevenlabs";

const PEPE_ASSETS = [
  "/frames/1-1.webp",
  "/frames/1-2.webp",
  "/frames/1-3.webp",
  "/frames/1-4.webp",
  "/frames/1-5.webp",
  "/frames/1-1-blink.webp",
  "/frames/1-2-blink.webp",
  "/frames/1-3-blink.webp",
  "/frames/1-4-blink.webp",
  "/frames/1-5-blink.webp",
  "/eyes/eyes-base.webp",
  "/eyes/eyes-frame.webp",
  "/eyes/eyes-pupil-left.webp",
  "/eyes/eyes-pupil-right.webp",
];

const ELEVENLABS_DEFAULT_MODEL = "eleven_flash_v2_5";
const INTRO_LINE = "gm, welcome back to Pepe HQ.";
const DIRECTOR_AUDIO_CACHE = "pepe-director-elevenlabs-audio-v1";
const AUDIO_ENVELOPE_STEP_SECONDS = 1 / 30;
const ENV_DIRECTOR_VOICE_ID = process.env.NEXT_PUBLIC_ELEVENLABS_DIRECTOR_VOICE_ID?.trim() ?? "";
const ENV_DIRECTOR_MODEL_ID =
  process.env.NEXT_PUBLIC_ELEVENLABS_DIRECTOR_MODEL_ID?.trim() || ELEVENLABS_DEFAULT_MODEL;
const HAS_ENV_DIRECTOR_ELEVENLABS =
  process.env.NEXT_PUBLIC_ELEVENLABS_DIRECTOR_ENABLED === "1" && Boolean(ENV_DIRECTOR_VOICE_ID);

let assetCachePromise: Promise<void> | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return clamp((words / 2.2) * 1000, 900, 30_000);
}

function isSpeechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function warmPepeAssets(): Promise<void> {
  if (assetCachePromise) return assetCachePromise;
  assetCachePromise = Promise.all(
    PEPE_ASSETS.map(
      (src) =>
        new Promise<void>((resolve) => {
          const image = new Image();
          image.onload = () => resolve();
          image.onerror = () => resolve();
          image.decoding = "async";
          image.src = src;
        }),
    ),
  ).then(() => undefined);
  return assetCachePromise;
}

async function sha256(value: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(i);
      hash |= 0;
    }
    return `fallback-${Math.abs(hash).toString(16)}`;
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function getDirectorAudioCacheKey(modelId: string, voiceId: string, text: string) {
  return sha256(`${modelId}\n${voiceId}\n${text}`);
}

async function readCachedAudio(cacheKey: string): Promise<Blob | null> {
  if (typeof caches === "undefined") return null;
  const cache = await caches.open(DIRECTOR_AUDIO_CACHE);
  const res = await cache.match(`/director-audio/${cacheKey}.mp3`);
  return res ? res.blob() : null;
}

async function writeCachedAudio(cacheKey: string, blob: Blob): Promise<void> {
  if (typeof caches === "undefined") return;
  const cache = await caches.open(DIRECTOR_AUDIO_CACHE);
  await cache.put(
    `/director-audio/${cacheKey}.mp3`,
    new Response(blob, {
      headers: { "Content-Type": blob.type || "audio/mpeg" },
    }),
  );
}

async function buildAudioEnvelope(context: AudioContext, blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await context.decodeAudioData(arrayBuffer);
  const windowSize = Math.max(1, Math.floor(audioBuffer.sampleRate * AUDIO_ENVELOPE_STEP_SECONDS));
  const windows = Math.max(1, Math.ceil(audioBuffer.length / windowSize));
  const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, channel) =>
    audioBuffer.getChannelData(channel),
  );
  const envelope = new Float32Array(windows);

  for (let windowIndex = 0; windowIndex < windows; windowIndex += 1) {
    const start = windowIndex * windowSize;
    const end = Math.min(audioBuffer.length, start + windowSize);
    let sumSquares = 0;
    let count = 0;

    for (const channel of channels) {
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        const sample = channel[sampleIndex];
        sumSquares += sample * sample;
        count += 1;
      }
    }

    envelope[windowIndex] = Math.sqrt(sumSquares / Math.max(1, count));
  }

  const sorted = Array.from(envelope).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.18)] ?? 0;
  const normalizer = Math.max(sorted[Math.floor(sorted.length * 0.92)] ?? 0, floor + 0.01);
  let smoothed = 0;

  for (let i = 0; i < envelope.length; i += 1) {
    const normalized = clamp((envelope[i] - floor) / (normalizer - floor), 0, 1);
    smoothed =
      normalized > smoothed ? smoothed * 0.18 + normalized * 0.82 : smoothed * 0.55 + normalized * 0.45;
    envelope[i] = smoothed;
  }

  return envelope;
}

export default function DirectorPage() {
  const [draft, setDraft] = useState("");
  const [lastLine, setLastLine] = useState(INTRO_LINE);
  const [status, setStatus] = useState("ready");
  const [engine, setEngine] = useState<SpeechEngine>(
    HAS_ENV_DIRECTOR_ELEVENLABS ? "elevenlabs" : "browser",
  );
  const [stageMode, setStageMode] = useState<StageMode>("studio");
  const [showBubble, setShowBubble] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
  const [pepeSize, setPepeSize] = useState(480);
  const [assetsReady, setAssetsReady] = useState(false);

  const apiKeyRef = useRef("");
  const voiceIdRef = useRef(ENV_DIRECTOR_VOICE_ID);
  const modelIdRef = useRef(ENV_DIRECTOR_MODEL_ID);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const speechRunRef = useRef(0);
  const volumeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const lipSyncRafRef = useRef<number | null>(null);
  const audioEnvelopeCacheRef = useRef<Map<string, Float32Array>>(new Map());

  useEffect(() => {
    void warmPepeAssets().then(() => setAssetsReady(true));
  }, []);

  useEffect(() => {
    const resize = () => {
      setPepeSize(clamp(Math.min(window.innerWidth, window.innerHeight) * 0.64, 300, 680));
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (isSpeechAvailable()) window.speechSynthesis.cancel();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      if (volumeTimerRef.current) clearInterval(volumeTimerRef.current);
      if (lipSyncRafRef.current) cancelAnimationFrame(lipSyncRafRef.current);
      void audioContextRef.current?.close().catch(() => undefined);
    };
  }, []);

  const stopLipSync = useCallback(() => {
    if (lipSyncRafRef.current) cancelAnimationFrame(lipSyncRafRef.current);
    lipSyncRafRef.current = null;
  }, []);

  const stopVolume = useCallback(() => {
    if (volumeTimerRef.current) clearInterval(volumeTimerRef.current);
    volumeTimerRef.current = null;
    stopLipSync();
    setVolume(0);
  }, [stopLipSync]);

  const startFakeVolume = useCallback((text: string) => {
    if (volumeTimerRef.current) clearInterval(volumeTimerRef.current);
    const started = Date.now();
    const estimated = estimateSpeechMs(text);
    volumeTimerRef.current = setInterval(() => {
      const progress = clamp((Date.now() - started) / estimated, 0, 1);
      const envelope = Math.sin(progress * Math.PI);
      const jitter = Math.sin(Date.now() * 0.027) * 0.24 + Math.sin(Date.now() * 0.049) * 0.18;
      setVolume(clamp(0.28 + envelope * 0.5 + jitter, 0.08, 0.98));
    }, 70);
  }, []);

  const ensureAudioContext = useCallback(async () => {
    const AudioContextCtor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) throw new Error("Web Audio unavailable");

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextCtor();
    }
    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  const startAudioEnvelopeLipSync = useCallback((envelope: Float32Array | null, text: string) => {
    if (!envelope) {
      startFakeVolume(text);
      return;
    }

    stopVolume();
    const audio = audioRef.current;
    if (!audio) return;

    const tick = () => {
      if (audio.paused || audio.ended) {
        setVolume(0);
        lipSyncRafRef.current = null;
        return;
      }

      const frame = Math.min(
        envelope.length - 1,
        Math.floor(audio.currentTime / AUDIO_ENVELOPE_STEP_SECONDS),
      );
      setVolume(envelope[frame] ?? 0);
      lipSyncRafRef.current = requestAnimationFrame(tick);
    };

    lipSyncRafRef.current = requestAnimationFrame(tick);
  }, [startFakeVolume, stopVolume]);

  const stop = useCallback(() => {
    speechRunRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (isSpeechAvailable()) window.speechSynthesis.cancel();
    setIsSpeaking(false);
    stopVolume();
    setStatus("stopped");
  }, [stopVolume]);

  const speakWithBrowser = useCallback(
    (line: string, runId: number) => {
      if (!isSpeechAvailable()) {
        setStatus("browser speech unavailable; use /engine elevenlabs");
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(line);
      utterance.rate = 0.92;
      utterance.pitch = 0.82;
      utterance.volume = 1;
      utterance.onend = () => {
        if (speechRunRef.current !== runId) return;
        setIsSpeaking(false);
        stopVolume();
        setStatus("ready");
      };
      utterance.onerror = () => {
        if (speechRunRef.current !== runId) return;
        setIsSpeaking(false);
        stopVolume();
        setStatus("speech stopped");
      };
      window.speechSynthesis.speak(utterance);
    },
    [stopVolume],
  );

  const speakWithElevenLabs = useCallback(
    async (line: string, runId: number) => {
      const apiKey = apiKeyRef.current.trim();
      const voiceId = voiceIdRef.current.trim();
      if ((!apiKey && !HAS_ENV_DIRECTOR_ELEVENLABS) || !voiceId) {
        setStatus("set /key and /voice before ElevenLabs speech");
        setIsSpeaking(false);
        stopVolume();
        return;
      }

      try {
        const cacheKey = await getDirectorAudioCacheKey(modelIdRef.current, voiceId, line);
        const cachedBlob = await readCachedAudio(cacheKey).catch(() => null);
        if (speechRunRef.current !== runId) return;
        let blob = cachedBlob;
        const controller = new AbortController();
        abortRef.current = controller;

        if (!blob) {
          setStatus("making audio");
          const res = await fetch("/api/director/elevenlabs/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              apiKey,
              voiceId,
              modelId: modelIdRef.current,
              text: line,
            }),
            signal: controller.signal,
            cache: "no-store",
          });
          if (!res.ok) {
            const details = await res.json().catch(() => null);
            throw new Error(details?.error ?? `ElevenLabs TTS failed with ${res.status}`);
          }
          blob = await res.blob();
          void writeCachedAudio(cacheKey, blob).catch(() => undefined);
        } else {
          setStatus("cached audio");
        }
        const envelope =
          audioEnvelopeCacheRef.current.get(cacheKey) ??
          (await buildAudioEnvelope(await ensureAudioContext(), blob).catch(() => null));
        if (envelope) audioEnvelopeCacheRef.current.set(cacheKey, envelope);
        if (speechRunRef.current !== runId || controller.signal.aborted) return;
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
        const audio = audioRef.current;
        if (!audio) throw new Error("audio unavailable");
        audio.src = url;
        audio.onended = () => {
          if (speechRunRef.current !== runId) return;
          setIsSpeaking(false);
          stopVolume();
          setStatus("ready");
        };
        audio.onerror = () => {
          if (speechRunRef.current !== runId) return;
          setIsSpeaking(false);
          stopVolume();
          setStatus("audio playback failed");
        };
        await audio.play();
        if (speechRunRef.current !== runId) {
          audio.pause();
          return;
        }
        setIsSpeaking(true);
        startAudioEnvelopeLipSync(envelope, line);
        setStatus("speaking");
      } catch (err) {
        if ((err as Error).name !== "AbortError" && speechRunRef.current === runId) {
          setStatus((err as Error).message);
          setIsSpeaking(false);
          stopVolume();
        }
      } finally {
        if (speechRunRef.current === runId) abortRef.current = null;
      }
    },
    [ensureAudioContext, startAudioEnvelopeLipSync, stopVolume],
  );

  const speak = useCallback(
    (line: string) => {
      const text = line.trim();
      if (!text) return;
      stop();
      const runId = speechRunRef.current + 1;
      speechRunRef.current = runId;
      setLastLine(text);
      if (engine === "elevenlabs") {
        setIsSpeaking(false);
        setStatus("checking audio cache");
        void speakWithElevenLabs(text, runId);
      } else {
        setIsSpeaking(true);
        setStatus("speaking");
        startFakeVolume(text);
        speakWithBrowser(text, runId);
      }
    },
    [engine, speakWithBrowser, speakWithElevenLabs, startFakeVolume, stop],
  );

  const runCommand = useCallback((input: string): boolean => {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return false;
    const [rawCommand, ...parts] = trimmed.slice(1).split(/\s+/);
    const command = rawCommand.toLowerCase();
    const value = parts.join(" ").trim();

    if (command === "key") {
      apiKeyRef.current = value;
      setEngine("elevenlabs");
      setStatus(value ? "ElevenLabs key set" : "ElevenLabs key cleared");
      return true;
    }
    if (command === "voice") {
      voiceIdRef.current = value;
      setEngine("elevenlabs");
      setStatus(value ? "ElevenLabs voice set" : "ElevenLabs voice cleared");
      return true;
    }
    if (command === "model") {
      modelIdRef.current = value || ELEVENLABS_DEFAULT_MODEL;
      setStatus(`model ${modelIdRef.current}`);
      return true;
    }
    if (command === "engine") {
      if (value === "browser" || value === "elevenlabs") {
        setEngine(value);
        setStatus(`engine ${value}`);
      } else {
        setStatus("engine must be browser or elevenlabs");
      }
      return true;
    }
    if (command === "stage") {
      if (value === "studio" || value === "camera" || value === "chroma") {
        setStageMode(value);
        setStatus(`stage ${value}`);
      } else {
        setStatus("stage must be studio, camera, or chroma");
      }
      return true;
    }
    if (command === "bubble") {
      const next = value !== "off";
      setShowBubble(next);
      setStatus(`bubble ${next ? "on" : "off"}`);
      return true;
    }
    if (command === "stop") {
      stop();
      return true;
    }
    if (command === "help") {
      setStatus("commands: /key, /voice, /engine, /stage, /bubble, /stop");
      return true;
    }

    setStatus("unknown command; try /help");
    return true;
  }, [stop]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (runCommand(text)) return;
    speak(text);
  };

  const stageClass =
    stageMode === "chroma"
      ? "bg-[#00ff00]"
      : stageMode === "camera"
        ? "bg-black"
        : "bg-[radial-gradient(circle_at_50%_42%,rgba(65,235,224,0.15),transparent_44%),#03070d]";

  return (
    <main className={`relative h-[100dvh] w-screen overflow-hidden text-white ${stageClass}`}>
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div
          className={`transition-opacity duration-200 ${assetsReady ? "opacity-100" : "opacity-0"}`}
          aria-hidden={!assetsReady}
        >
          <PepeHead
            volume={volume}
            isSpeaking={isSpeaking}
            transcript={showBubble ? lastLine : null}
            size={pepeSize}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-4 bottom-[88px] mx-auto max-w-5xl border border-cyan-200/20 bg-black/42 px-5 py-4 backdrop-blur-sm">
        <p className="text-[10px] uppercase tracking-[0.22em] text-cyan-100/55">Pepe Director</p>
        <p className="mt-2 text-2xl font-semibold leading-tight text-white md:text-4xl">{lastLine}</p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="absolute inset-x-4 bottom-4 mx-auto flex max-w-5xl items-center gap-3 border border-cyan-200/25 bg-[#04101a]/92 px-3 py-3 shadow-[0_0_34px_rgba(65,235,224,0.14)] backdrop-blur"
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Director line"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Type a sentence and press Enter. /help for setup."
          className="min-w-0 flex-1 bg-transparent px-2 py-2 text-base text-white outline-none placeholder:text-cyan-100/35 md:text-lg"
        />
        <div className="hidden shrink-0 text-right text-[10px] uppercase tracking-[0.14em] text-cyan-100/55 sm:block">
          <div>{engine}</div>
          <div>{status}</div>
        </div>
      </form>

      <audio ref={audioRef} className="hidden" />
    </main>
  );
}
