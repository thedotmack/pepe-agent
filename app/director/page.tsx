"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import PepeHead from "@/components/pepe-head/PepeHead";

type StageMode = "studio" | "camera" | "chroma";
type SpeechEngine = "elevenlabs" | "browser";
type SpeechVoice = SpeechSynthesisVoice;
type ElevenLabsVoice = {
  voiceId: string;
  name: string;
  category: string;
};

const DEFAULT_LINES = [
  "gm, welcome back to Pepe HQ.",
  "The tape is moving fast, but we are not chasing green candles.",
  "I am watching the launch window. Human review before Bags. Always.",
];

const ELEVENLABS_MODELS = [
  { id: "eleven_flash_v2_5", label: "Flash v2.5" },
  { id: "eleven_turbo_v2_5", label: "Turbo v2.5" },
  { id: "eleven_multilingual_v2", label: "Multilingual v2" },
  { id: "eleven_v3", label: "Eleven v3" },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function estimateSpeechMs(text: string, rate: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return clamp((words / (2.25 * rate)) * 1000, 900, 30_000);
}

function isSpeechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export default function DirectorPage() {
  const [draft, setDraft] = useState(DEFAULT_LINES[0]);
  const [lastLine, setLastLine] = useState(DEFAULT_LINES[0]);
  const [queue, setQueue] = useState<string[]>(DEFAULT_LINES.slice(1));
  const [voices, setVoices] = useState<SpeechVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState("");
  const [speechEngine, setSpeechEngine] = useState<SpeechEngine>("browser");
  const [elevenLabsKey, setElevenLabsKey] = useState("");
  const [elevenLabsVoiceId, setElevenLabsVoiceId] = useState("");
  const [elevenLabsVoices, setElevenLabsVoices] = useState<ElevenLabsVoice[]>([]);
  const [elevenLabsModelId, setElevenLabsModelId] = useState(ELEVENLABS_MODELS[0].id);
  const [isLoadingVoices, setIsLoadingVoices] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [rate, setRate] = useState(0.92);
  const [pitch, setPitch] = useState(0.82);
  const [stageMode, setStageMode] = useState<StageMode>("studio");
  const [showBubble, setShowBubble] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pepeSize, setPepeSize] = useState(420);

  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const volumeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queueRef = useRef<string[]>(queue);
  const rateRef = useRef(rate);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    const resize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const controlReserve = width >= 1024 ? 380 : 0;
      setPepeSize(clamp(Math.min(width - controlReserve, height) * 0.62, 280, 560));
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);

  useEffect(() => {
    if (!isSpeechAvailable()) {
      setError("Speech synthesis is not available in this browser.");
      return;
    }

    const loadVoices = () => {
      const next = window.speechSynthesis.getVoices();
      setVoices(next);
      setVoiceURI((current) => current || next[0]?.voiceURI || "");
    };

    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
      window.speechSynthesis.cancel();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.voiceURI === voiceURI) ?? voices[0],
    [voiceURI, voices],
  );

  const stopVolume = useCallback(() => {
    if (volumeTimerRef.current) clearInterval(volumeTimerRef.current);
    volumeTimerRef.current = null;
    setVolume(0);
  }, []);

  const startFakeVolume = useCallback((text: string) => {
    if (volumeTimerRef.current) clearInterval(volumeTimerRef.current);
    const started = Date.now();
    const estimated = estimateSpeechMs(text, rateRef.current);
    volumeTimerRef.current = setInterval(() => {
      const progress = clamp((Date.now() - started) / estimated, 0, 1);
      const envelope = Math.sin(progress * Math.PI);
      const jitter = Math.sin(Date.now() * 0.027) * 0.24 + Math.sin(Date.now() * 0.049) * 0.18;
      setVolume(clamp(0.28 + envelope * 0.48 + jitter, 0.08, 0.95));
    }, 70);
  }, []);

  const speak = useCallback(
    async (text: string) => {
      const line = text.trim();
      if (!line) return;

      fetchAbortRef.current?.abort();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      if (speechEngine === "elevenlabs") {
        if (!elevenLabsKey.trim()) {
          setError("Paste an ElevenLabs API key or switch to browser voice.");
          return;
        }
        if (!elevenLabsVoiceId.trim()) {
          setError("Choose or paste an ElevenLabs voice ID.");
          return;
        }

        const controller = new AbortController();
        fetchAbortRef.current = controller;
        stopVolume();
        setError(null);
        setLastLine(line);
        setIsGenerating(true);
        setIsSpeaking(true);
        startFakeVolume(line);

        try {
          const res = await fetch("/api/director/elevenlabs/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              apiKey: elevenLabsKey,
              voiceId: elevenLabsVoiceId,
              modelId: elevenLabsModelId,
              text: line,
            }),
            signal: controller.signal,
            cache: "no-store",
          });
          if (!res.ok) {
            const details = await res.json().catch(() => null);
            throw new Error(details?.error ?? `ElevenLabs TTS failed with ${res.status}`);
          }
          const blob = await res.blob();
          if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
          const url = URL.createObjectURL(blob);
          audioUrlRef.current = url;

          const audio = audioRef.current;
          if (!audio) throw new Error("Audio element unavailable");
          audio.src = url;
          audio.onended = () => {
            setIsSpeaking(false);
            stopVolume();
            const next = queueRef.current[0];
            if (!next) return;
            setQueue((current) => current.slice(1));
            window.setTimeout(() => void speak(next), 180);
          };
          audio.onerror = () => {
            setIsSpeaking(false);
            stopVolume();
            setError("Audio playback failed.");
          };
          await audio.play();
        } catch (err) {
          if ((err as Error).name !== "AbortError") {
            setError((err as Error).message);
            setIsSpeaking(false);
            stopVolume();
          }
        } finally {
          setIsGenerating(false);
          fetchAbortRef.current = null;
        }
        return;
      }

      if (!isSpeechAvailable()) {
        setError("Speech synthesis is not available in this browser.");
        return;
      }

      window.speechSynthesis.cancel();
      stopVolume();
      setError(null);
      setLastLine(line);
      setIsSpeaking(true);
      startFakeVolume(line);

      const utterance = new SpeechSynthesisUtterance(line);
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = 1;
      if (selectedVoice) utterance.voice = selectedVoice;
      utterance.onend = () => {
        setIsSpeaking(false);
        stopVolume();
        const next = queueRef.current[0];
        if (!next) return;
        setQueue((current) => current.slice(1));
        window.setTimeout(() => void speak(next), 180);
      };
      utterance.onerror = () => {
        setIsSpeaking(false);
        stopVolume();
        setError("Speech synthesis stopped.");
      };

      utteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    },
    [
      elevenLabsKey,
      elevenLabsModelId,
      elevenLabsVoiceId,
      pitch,
      rate,
      selectedVoice,
      speechEngine,
      startFakeVolume,
      stopVolume,
    ],
  );

  const stop = useCallback(() => {
    fetchAbortRef.current?.abort();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (isSpeechAvailable()) window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setIsGenerating(false);
    setIsSpeaking(false);
    stopVolume();
  }, [stopVolume]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void speak(draft);
  };

  const addToQueue = () => {
    const line = draft.trim();
    if (!line) return;
    setQueue((current) => [...current, line]);
    setDraft("");
  };

  const loadElevenLabsVoices = async () => {
    const apiKey = elevenLabsKey.trim();
    if (!apiKey) {
      setError("Paste an ElevenLabs API key first.");
      return;
    }
    setIsLoadingVoices(true);
    setError(null);
    try {
      const res = await fetch("/api/director/elevenlabs/voices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
        cache: "no-store",
      });
      if (!res.ok) {
        const details = await res.json().catch(() => null);
        throw new Error(details?.error ?? `Voice lookup failed with ${res.status}`);
      }
      const data = (await res.json()) as { voices?: ElevenLabsVoice[] };
      const next = data.voices ?? [];
      setElevenLabsVoices(next);
      setElevenLabsVoiceId((current) => current || next[0]?.voiceId || "");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoadingVoices(false);
    }
  };

  const stageClass =
    stageMode === "chroma"
      ? "bg-[#00ff00]"
      : stageMode === "camera"
        ? "bg-black"
        : "bg-[radial-gradient(circle_at_50%_38%,rgba(65,235,224,0.16),transparent_42%),#03070d]";

  return (
    <main className={`grid h-[100dvh] grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(320px,42dvh)] overflow-hidden text-white lg:grid-cols-[1fr_380px] lg:grid-rows-1 ${stageClass}`}>
      <section className="relative grid min-h-0 place-items-center overflow-hidden">
        {stageMode === "studio" && (
          <div className="pointer-events-none absolute inset-0 opacity-55">
            <div className="absolute left-8 top-8 h-px w-[calc(100%-4rem)] bg-cyan-200/20" />
            <div className="absolute bottom-8 left-8 h-px w-[calc(100%-4rem)] bg-cyan-200/20" />
            <div className="absolute left-8 top-8 h-[calc(100%-4rem)] w-px bg-cyan-200/20" />
            <div className="absolute right-8 top-8 h-[calc(100%-4rem)] w-px bg-cyan-200/20" />
          </div>
        )}

        <div className="relative grid place-items-center px-6">
          <PepeHead
            volume={volume}
            isSpeaking={isSpeaking}
            transcript={showBubble ? lastLine : null}
            size={pepeSize}
          />
        </div>

        <div className="pointer-events-none absolute bottom-4 left-1/2 w-[min(920px,calc(100%-2rem))] -translate-x-1/2 border border-cyan-200/25 bg-black/50 px-5 py-4 backdrop-blur lg:bottom-8">
          <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-100/65">Pepe Director</p>
          <p className="mt-2 text-2xl font-semibold leading-tight text-white md:text-4xl">
            {lastLine}
          </p>
        </div>
      </section>

      <aside className="flex min-h-0 flex-col overflow-y-auto border-t border-cyan-300/20 bg-[#06111d]/95 p-4 shadow-[0_0_44px_rgba(65,235,224,0.14)] lg:border-l lg:border-t-0">
        <header className="border-b border-cyan-300/20 pb-4">
          <p className="text-[10px] uppercase tracking-[0.22em] text-cyan-200/65">Pepe HQ</p>
          <h1 className="mt-1 text-xl font-semibold">Director Booth</h1>
        </header>

        <form onSubmit={handleSubmit} className="mt-4 grid gap-3">
          <label className="grid gap-2 text-[10px] uppercase tracking-[0.16em] text-cyan-100/65">
            Line
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={5}
              className="resize-none border border-cyan-300/24 bg-[#04101a] px-3 py-3 text-base normal-case tracking-normal text-white outline-none focus:border-cyan-200"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="submit"
              disabled={isGenerating}
              className="border border-cyan-200/45 bg-cyan-300/12 px-3 py-3 text-[11px] uppercase tracking-[0.14em] text-white"
            >
              {isGenerating ? "Making Audio" : "Speak"}
            </button>
            <button
              type="button"
              onClick={stop}
              className="border border-amber-200/45 bg-amber-300/12 px-3 py-3 text-[11px] uppercase tracking-[0.14em] text-amber-50"
            >
              Stop
            </button>
          </div>
          <button
            type="button"
            onClick={addToQueue}
            className="border border-cyan-300/24 px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-cyan-50"
          >
            Add to Queue
          </button>
        </form>

        <div className="mt-4 grid gap-3 border-t border-cyan-300/20 pt-4">
          <div className="grid grid-cols-2 gap-2 text-center text-[10px] uppercase tracking-[0.12em]">
            {(["elevenlabs", "browser"] as SpeechEngine[]).map((engine) => (
              <button
                key={engine}
                type="button"
                onClick={() => setSpeechEngine(engine)}
                className={`border px-2 py-2 ${
                  speechEngine === engine
                    ? "border-cyan-200 bg-cyan-300/16 text-white"
                    : "border-cyan-300/20 bg-cyan-950/18 text-cyan-100/75"
                }`}
              >
                {engine === "elevenlabs" ? "ElevenLabs" : "Browser"}
              </button>
            ))}
          </div>

          {speechEngine === "elevenlabs" ? (
            <div className="grid gap-3">
              <label className="grid gap-2 text-[10px] uppercase tracking-[0.16em] text-cyan-100/65">
                ElevenLabs API Key
                <input
                  type="password"
                  value={elevenLabsKey}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setElevenLabsKey(event.target.value)}
                  className="border border-cyan-300/24 bg-[#04101a] px-3 py-2 text-sm normal-case tracking-normal text-white outline-none focus:border-cyan-200"
                />
              </label>

              <div className="grid grid-cols-[1fr_auto] gap-2">
                <label className="grid gap-2 text-[10px] uppercase tracking-[0.16em] text-cyan-100/65">
                  ElevenLabs Voice
                  <select
                    value={elevenLabsVoiceId}
                    onChange={(event) => setElevenLabsVoiceId(event.target.value)}
                    className="border border-cyan-300/24 bg-[#04101a] px-3 py-2 text-sm normal-case tracking-normal text-white outline-none focus:border-cyan-200"
                  >
                    {elevenLabsVoices.length === 0 ? (
                      <option value={elevenLabsVoiceId}>
                        {elevenLabsVoiceId || "Paste voice ID below"}
                      </option>
                    ) : (
                      elevenLabsVoices.map((voice) => (
                        <option key={voice.voiceId} value={voice.voiceId}>
                          {voice.name}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void loadElevenLabsVoices()}
                  disabled={isLoadingVoices}
                  className="mt-6 border border-cyan-300/24 px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-cyan-50 disabled:opacity-50"
                >
                  {isLoadingVoices ? "Loading" : "Load"}
                </button>
              </div>

              <label className="grid gap-2 text-[10px] uppercase tracking-[0.16em] text-cyan-100/65">
                Voice ID
                <input
                  value={elevenLabsVoiceId}
                  spellCheck={false}
                  onChange={(event) => setElevenLabsVoiceId(event.target.value.trim())}
                  className="border border-cyan-300/24 bg-[#04101a] px-3 py-2 text-sm normal-case tracking-normal text-white outline-none focus:border-cyan-200"
                />
              </label>

              <label className="grid gap-2 text-[10px] uppercase tracking-[0.16em] text-cyan-100/65">
                Model
                <select
                  value={elevenLabsModelId}
                  onChange={(event) => setElevenLabsModelId(event.target.value)}
                  className="border border-cyan-300/24 bg-[#04101a] px-3 py-2 text-sm normal-case tracking-normal text-white outline-none focus:border-cyan-200"
                >
                  {ELEVENLABS_MODELS.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <label className="grid gap-2 text-[10px] uppercase tracking-[0.16em] text-cyan-100/65">
              Browser Voice
              <select
                value={voiceURI}
                onChange={(event) => setVoiceURI(event.target.value)}
                className="border border-cyan-300/24 bg-[#04101a] px-3 py-2 text-sm normal-case tracking-normal text-white outline-none focus:border-cyan-200"
              >
                {voices.map((voice) => (
                  <option key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name} ({voice.lang})
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="grid gap-2 text-[10px] uppercase tracking-[0.16em] text-cyan-100/65">
            Rate {rate.toFixed(2)}
            <input
              type="range"
              min="0.55"
              max="1.45"
              step="0.01"
              value={rate}
              onChange={(event) => setRate(Number(event.target.value))}
            />
          </label>

          <label className="grid gap-2 text-[10px] uppercase tracking-[0.16em] text-cyan-100/65">
            Pitch {pitch.toFixed(2)}
            <input
              type="range"
              min="0.5"
              max="1.45"
              step="0.01"
              value={pitch}
              onChange={(event) => setPitch(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="mt-4 grid gap-3 border-t border-cyan-300/20 pt-4">
          <div className="grid grid-cols-3 gap-2 text-center text-[10px] uppercase tracking-[0.12em]">
            {(["studio", "camera", "chroma"] as StageMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setStageMode(mode)}
                className={`border px-2 py-2 ${
                  stageMode === mode
                    ? "border-cyan-200 bg-cyan-300/16 text-white"
                    : "border-cyan-300/20 bg-cyan-950/18 text-cyan-100/75"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
          <label className="flex items-center justify-between border border-cyan-300/18 bg-black/18 px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-cyan-100/75">
            Bubble
            <input
              type="checkbox"
              checked={showBubble}
              onChange={(event) => setShowBubble(event.target.checked)}
            />
          </label>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto border-t border-cyan-300/20 pt-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] uppercase tracking-[0.18em] text-cyan-100/70">Queue</h2>
            <button
              type="button"
              onClick={() => setQueue([])}
              className="text-[10px] uppercase tracking-[0.14em] text-cyan-100/55"
            >
              Clear
            </button>
          </div>
          <div className="mt-3 grid gap-2">
            {queue.length === 0 ? (
              <p className="border border-cyan-300/12 bg-black/16 px-3 py-3 text-sm text-cyan-100/45">
                Queue empty.
              </p>
            ) : (
              queue.map((line, index) => (
                <button
                  key={`${line}-${index}`}
                  type="button"
                  onClick={() => void speak(line)}
                  className="border border-cyan-300/16 bg-cyan-950/12 px-3 py-2 text-left text-sm leading-snug text-cyan-50/86"
                >
                  {line}
                </button>
              ))
            )}
          </div>
        </div>

        {error && (
          <p className="mt-3 border border-amber-200/35 bg-amber-300/12 px-3 py-2 text-sm text-amber-50">
            {error}
          </p>
        )}
      </aside>
      <audio ref={audioRef} className="hidden" />
    </main>
  );
}
