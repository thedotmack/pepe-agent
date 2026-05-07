"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import PepeHead from "@/components/pepe-head/PepeHead";
import { type PepeSpeechEngine, usePepeSpeech } from "@/lib/use-pepe-speech";

type StageMode = "studio" | "camera" | "chroma";

const INTRO_LINE = "gm, welcome back to Pepe HQ.";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export default function DirectorPage() {
  const [draft, setDraft] = useState("");
  const [stageMode, setStageMode] = useState<StageMode>("studio");
  const [showBubble, setShowBubble] = useState(true);
  const [pepeSize, setPepeSize] = useState(480);
  const speech = usePepeSpeech({ initialLine: INTRO_LINE });

  useEffect(() => {
    const resize = () => {
      setPepeSize(clamp(Math.min(window.innerWidth, window.innerHeight) * 0.64, 300, 680));
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const runCommand = useCallback(
    (input: string): boolean => {
      const trimmed = input.trim();
      if (!trimmed.startsWith("/")) return false;
      const [rawCommand, ...parts] = trimmed.slice(1).split(/\s+/);
      const command = rawCommand.toLowerCase();
      const value = parts.join(" ").trim();

      if (command === "key") {
        speech.setElevenLabsApiKey(value);
        return true;
      }
      if (command === "voice") {
        speech.setElevenLabsVoiceId(value);
        return true;
      }
      if (command === "model") {
        speech.setElevenLabsModelId(value);
        return true;
      }
      if (command === "engine") {
        if (value === "browser" || value === "elevenlabs") {
          speech.setEngine(value as PepeSpeechEngine);
        } else {
          speech.setStatus("engine must be browser or elevenlabs");
        }
        return true;
      }
      if (command === "stage") {
        if (value === "studio" || value === "camera" || value === "chroma") {
          setStageMode(value);
          speech.setStatus(`stage ${value}`);
        } else {
          speech.setStatus("stage must be studio, camera, or chroma");
        }
        return true;
      }
      if (command === "bubble") {
        const next = value !== "off";
        setShowBubble(next);
        speech.setStatus(`bubble ${next ? "on" : "off"}`);
        return true;
      }
      if (command === "stop") {
        speech.stop();
        return true;
      }
      if (command === "help") {
        speech.setStatus("commands: /key, /voice, /engine, /stage, /bubble, /stop");
        return true;
      }

      speech.setStatus("unknown command; try /help");
      return true;
    },
    [speech],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (runCommand(text)) return;
    speech.speak(text);
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
          className={`transition-opacity duration-200 ${speech.assetsReady ? "opacity-100" : "opacity-0"}`}
          aria-hidden={!speech.assetsReady}
        >
          <PepeHead
            volume={speech.volume}
            isSpeaking={speech.isSpeaking}
            transcript={showBubble ? speech.lastLine : null}
            size={pepeSize}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-4 bottom-[88px] mx-auto max-w-5xl border border-cyan-200/20 bg-black/42 px-5 py-4 backdrop-blur-sm">
        <p className="text-[10px] uppercase tracking-[0.22em] text-cyan-100/55">Pepe Director</p>
        <p className="mt-2 text-2xl font-semibold leading-tight text-white md:text-4xl">
          {speech.lastLine}
        </p>
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
          <div>{speech.engine}</div>
          <div>{speech.status}</div>
        </div>
      </form>

      <audio ref={speech.audioRef} className="hidden" />
    </main>
  );
}
