"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PepeHead from "@/components/pepe-head/PepeHead";
import AgentControls from "@/components/agent-ui/AgentControls";
import { PepeAgent, AgentStatus } from "@/lib/agent";
import { DotMatrixCanvas } from "@/components/dot-board/DotMatrixCanvas";
import { useActivityFeed } from "@/components/dot-board/use-activity-feed";
import { renderBoard } from "@/lib/dot-matrix/render-board";
import { DOT_BOARD } from "@/lib/dot-matrix/dot-matrix-ui-kit";

const PIXEL = DOT_BOARD.dotSize + DOT_BOARD.gap;

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

  // ── Activity feed ──────────────────────────────────────────────────────────
  const { rows, status: feedStatus } = useActivityFeed();

  // Pick the highest fiveMinGain row as the "selected" token (rotates as data updates).
  const selectedTokenId = useMemo(() => {
    if (rows.length === 0) return undefined;
    let best = rows[0];
    let bestGain = best.fiveMinGain ?? -Infinity;
    for (let i = 1; i < rows.length; i++) {
      const g = rows[i].fiveMinGain ?? -Infinity;
      if (g > bestGain) {
        best = rows[i];
        bestGain = g;
      }
    }
    return best.tokenId;
  }, [rows]);

  // ── Beam pulse tick (200ms) ────────────────────────────────────────────────
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1024), 200);
    return () => clearInterval(id);
  }, []);
  const beamPhase = (tick % 10) / 10; // 2s cycle (10 ticks * 200ms)

  // ── Responsive scale ──────────────────────────────────────────────────────
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(min-width: 640px)");
    const apply = () => setScale(mql.matches ? 2 : 1);
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);

  // ── Render the board ──────────────────────────────────────────────────────
  const { matrix, pepeFrame } = useMemo(
    () =>
      renderBoard(rows, {
        status: feedStatus,
        selectedTokenId,
        pepeIsSpeaking: isSpeaking,
        beamPhase,
      }),
    [rows, feedStatus, selectedTokenId, isSpeaking, beamPhase],
  );

  const px = (n: number) => n * PIXEL * scale;

  return (
    <main className="relative h-screen w-screen bg-[#03070d] grid place-items-center overflow-hidden">
      <div className="relative">
        {/* Layer 0 — full dot-matrix board */}
        <DotMatrixCanvas matrix={matrix} scale={scale} />

        {/* Layer 1 — Pepe sprite over the habitat panel */}
        <div
          className="absolute pointer-events-none"
          style={{
            left: px(pepeFrame.x),
            top: px(pepeFrame.y),
            width: px(pepeFrame.w),
            height: px(pepeFrame.h),
            display: "grid",
            placeItems: "center",
          }}
        >
          <div
            className="pointer-events-auto"
            style={{
              // Scale the 240px-square PepeHead into the habitat panel.
              transform: `scale(${Math.min(px(pepeFrame.w), px(pepeFrame.h)) / 240})`,
              transformOrigin: "center",
            }}
          >
            <PepeHead
              volume={volume}
              isSpeaking={isSpeaking}
              transcript={transcript}
            />
          </div>
        </div>
      </div>

      {/* Layer 2 — voice controls pinned to bottom */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-20">
        <AgentControls status={status} onToggle={handleToggle} />
      </div>
    </main>
  );
}
