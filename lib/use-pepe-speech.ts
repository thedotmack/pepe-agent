"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type PepeSpeechEngine = "browser" | "elevenlabs";

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
const PEPE_AUDIO_CACHE = "pepe-director-elevenlabs-audio-v1";
const AUDIO_ENVELOPE_STEP_SECONDS = 1 / 30;
const MAX_TTS_TEXT_LENGTH = 2_500;
const ENV_DIRECTOR_VOICE_ID = process.env.NEXT_PUBLIC_ELEVENLABS_DIRECTOR_VOICE_ID?.trim() ?? "";
const ENV_DIRECTOR_MODEL_ID =
  process.env.NEXT_PUBLIC_ELEVENLABS_DIRECTOR_MODEL_ID?.trim() || ELEVENLABS_DEFAULT_MODEL;

export const HAS_ENV_DIRECTOR_ELEVENLABS =
  process.env.NEXT_PUBLIC_ELEVENLABS_DIRECTOR_ENABLED === "1";

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

async function getPepeAudioCacheKey(modelId: string, voiceId: string, text: string) {
  return sha256(`${modelId}\n${voiceId}\n${text}`);
}

async function readCachedAudio(cacheKey: string): Promise<Blob | null> {
  if (typeof caches === "undefined") return null;
  const cache = await caches.open(PEPE_AUDIO_CACHE);
  const res = await cache.match(`/director-audio/${cacheKey}.mp3`);
  return res ? res.blob() : null;
}

async function writeCachedAudio(cacheKey: string, blob: Blob): Promise<void> {
  if (typeof caches === "undefined") return;
  const cache = await caches.open(PEPE_AUDIO_CACHE);
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

function ttsTextFor(text: string): string {
  if (text.length <= MAX_TTS_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_TTS_TEXT_LENGTH - 3)}...`;
}

export function usePepeSpeech({
  initialLine = "",
  initialEngine,
}: {
  initialLine?: string;
  initialEngine?: PepeSpeechEngine;
} = {}) {
  const [lastLine, setLastLine] = useState(initialLine);
  const [status, setStatus] = useState("ready");
  const [engine, setEngineState] = useState<PepeSpeechEngine>(
    initialEngine ?? (HAS_ENV_DIRECTOR_ELEVENLABS ? "elevenlabs" : "browser"),
  );
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
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

  const startAudioEnvelopeLipSync = useCallback(
    (envelope: Float32Array | null, text: string) => {
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
    },
    [startFakeVolume, stopVolume],
  );

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
      const modelId = modelIdRef.current;
      const hasServerElevenLabs = HAS_ENV_DIRECTOR_ELEVENLABS;

      if (!apiKey && !hasServerElevenLabs) {
        setStatus("set /key before ElevenLabs speech");
        setIsSpeaking(false);
        stopVolume();
        return;
      }
      if (!voiceId && !hasServerElevenLabs) {
        setStatus("set /voice before ElevenLabs speech");
        setIsSpeaking(false);
        stopVolume();
        return;
      }

      const spokenText = ttsTextFor(line);
      const cacheVoiceId = voiceId || "server-env";

      try {
        const cacheKey = await getPepeAudioCacheKey(modelId, cacheVoiceId, spokenText);
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
              apiKey: apiKey || undefined,
              voiceId: voiceId || undefined,
              modelId,
              text: spokenText,
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
        startAudioEnvelopeLipSync(envelope, spokenText);
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

  const setEngine = useCallback((nextEngine: PepeSpeechEngine) => {
    setEngineState(nextEngine);
    setStatus(`engine ${nextEngine}`);
  }, []);

  const setElevenLabsApiKey = useCallback((value: string) => {
    apiKeyRef.current = value.trim();
    setEngineState("elevenlabs");
    setStatus(apiKeyRef.current ? "ElevenLabs key set" : "ElevenLabs key cleared");
  }, []);

  const setElevenLabsVoiceId = useCallback((value: string) => {
    voiceIdRef.current = value.trim();
    setEngineState("elevenlabs");
    setStatus(voiceIdRef.current ? "ElevenLabs voice set" : "ElevenLabs voice cleared");
  }, []);

  const setElevenLabsModelId = useCallback((value: string) => {
    modelIdRef.current = value.trim() || ELEVENLABS_DEFAULT_MODEL;
    setStatus(`model ${modelIdRef.current}`);
  }, []);

  return {
    audioRef,
    assetsReady,
    engine,
    isSpeaking,
    lastLine,
    setElevenLabsApiKey,
    setElevenLabsModelId,
    setElevenLabsVoiceId,
    setEngine,
    setStatus,
    speak,
    status,
    stop,
    volume,
  };
}
