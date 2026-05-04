"use client";

import { useCallback, useRef, useState } from "react";
import AsciiBackground from "@/components/ascii-background";
import PepeHead from "@/components/pepe-head/PepeHead";
import AgentControls from "@/components/agent-ui/AgentControls";
import { PepeAgent, AgentStatus } from "@/lib/agent";

export default function HomePage() {
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [transcript, setTranscript] = useState<string | null>(null);
  const [volume, setVolume] = useState(0);

  const agentRef = useRef<PepeAgent | null>(null);

  const handleToggle = useCallback(async () => {
    if (agentRef.current?.isActive()) {
      await agentRef.current.stop();
      agentRef.current = null;
      setTranscript(null);
      setVolume(0);
      return;
    }

    const agent = new PepeAgent({
      onStatusChange: setStatus,
      onTranscript: (text) => setTranscript(text),
      onVolume: setVolume,
      onError: (err) => {
        console.error("[PepeAgent]", err);
        setStatus("idle");
      },
    });
    agentRef.current = agent;
    await agent.start();
  }, []);

  const isSpeaking = status === "speaking";

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-black flex flex-col items-center justify-center">
      {/* Layer 0 — ASCII background, reacts to audio */}
      <AsciiBackground audioIntensity={volume} />

      {/* Layer 1 — Pepe head */}
      <div className="relative z-10 flex flex-col items-center gap-0">
        <PepeHead
          volume={volume}
          isSpeaking={isSpeaking}
          transcript={transcript}
        />
      </div>

      {/* Layer 2 — Controls pinned to bottom */}
      <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-20">
        <AgentControls status={status} onToggle={handleToggle} />
      </div>
    </main>
  );
}
