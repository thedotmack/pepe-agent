"use client";

import { useCallback, useEffect, useMemo, useRef, useState, FormEvent } from "react";
import PepeHead from "@/components/pepe-head/PepeHead";
import { PepeAgent, AgentStatus, type ChatMessage } from "@/lib/agent";
import { DotMatrixCanvas } from "@/components/dot-board/DotMatrixCanvas";
import {
  useActivityFeed,
  type ActivityToken,
} from "@/components/dot-board/use-activity-feed";
import { renderBoard, type ChatLogEntry } from "@/lib/dot-matrix/render-board";
import { DOT_BOARD, DOT_BOARD_DESKTOP } from "@/lib/dot-matrix/dot-matrix-ui-kit";

const PIXEL = DOT_BOARD.dotSize + DOT_BOARD.gap;
const SCREEN_MARGIN = 24;

type SessionKind = "idle" | "text" | "voice";

const DEMO_ROWS: ActivityToken[] = [
  { tokenId: "mog", symbol: "MOG", name: "Mog", price: 0.00012, fiveMinGain: 0.44, buyPressure5m: 0.9, liquidity: 112000, updatesPerMinute: 48, signal: "STRONG" },
  { tokenId: "popcat", symbol: "POPCAT", name: "Popcat", price: 0.0185, fiveMinGain: 0.28, buyPressure5m: 0.76, liquidity: 94000, updatesPerMinute: 39, signal: "STRONG" },
  { tokenId: "wif", symbol: "WIF", name: "Dogwifhat", price: 1.82, fiveMinGain: 0.19, buyPressure5m: 0.68, liquidity: 250000, updatesPerMinute: 31, signal: "RISING" },
  { tokenId: "bonk", symbol: "BONK", name: "Bonk", price: 0.000025, fiveMinGain: 0.13, buyPressure5m: 0.58, liquidity: 180000, updatesPerMinute: 27, signal: "RISING" },
  { tokenId: "pepe", symbol: "PEPE", name: "Pepe", price: 0.000009, fiveMinGain: 0.09, buyPressure5m: 0.52, liquidity: 154000, updatesPerMinute: 25, signal: "WATCH" },
  { tokenId: "fwog", symbol: "FWOG", name: "Fwog", price: 0.031, fiveMinGain: -0.08, buyPressure5m: 0.36, liquidity: 72000, updatesPerMinute: 21, signal: "FLAT" },
  { tokenId: "boden", symbol: "BODEN", name: "Boden", price: 0.0068, fiveMinGain: -0.11, buyPressure5m: 0.31, liquidity: 64000, updatesPerMinute: 18, signal: "FLAT" },
  { tokenId: "michi", symbol: "MICHI", name: "Michi", price: 0.092, fiveMinGain: -0.16, buyPressure5m: 0.24, liquidity: 58000, updatesPerMinute: 16, signal: "FLAT" },
];

export default function HomePage() {
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [transcript, setTranscript] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatLogEntry[]>([]);
  const [chatError, setChatError] = useState<string | undefined>();
  const [sessionKind, setSessionKind] = useState<SessionKind>("idle");
  const [volume, setVolume] = useState(0);
  const [draft, setDraft] = useState("");
  const [inputFocused, setInputFocused] = useState(false);

  const agentRef = useRef<PepeAgent | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);

  const appendSystemMessage = useCallback((text: string) => {
    setChatMessages((current) => [
      ...current,
      { id: `system-${Date.now()}-${current.length}`, role: "system", text },
    ]);
  }, []);

  const appendAgentMessage = useCallback((message: ChatMessage) => {
    setChatMessages((current) => [
      ...current,
      {
        id: message.id ?? `${message.role}-${message.createdAt.getTime()}-${current.length}`,
        role: message.role === "agent" ? "assistant" : "user",
        text: message.text,
      },
    ]);
  }, []);

  const createAgent = useCallback(() => {
    const agent = new PepeAgent({
      onStatusChange: (nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus === "idle") setSessionKind("idle");
      },
      onTranscript: (text) => setTranscript(text),
      onMessage: appendAgentMessage,
      onVolume: setVolume,
      onError: (err) => {
        console.error("[PepeAgent]", err);
        setChatError(err);
        appendSystemMessage(err);
        setStatus("idle");
      },
    });
    agentRef.current = agent;
    return agent;
  }, [appendAgentMessage, appendSystemMessage]);

  const ensureAgent = useCallback(async () => {
    const activeAgent = agentRef.current;
    if (activeAgent?.isActive()) return activeAgent;
    setChatError(undefined);
    const agent = createAgent();
    setSessionKind("text");
    await agent.start({ textOnly: true });
    return agent.isActive() ? agent : null;
  }, [createAgent]);

  const handleToggleVoice = useCallback(async () => {
    if (agentRef.current?.isActive()) {
      await agentRef.current.stop();
      agentRef.current = null;
      setSessionKind("idle");
      setTranscript(null);
      setVolume(0);
      return;
    }
    setChatError(undefined);
    const agent = createAgent();
    setSessionKind("voice");
    await agent.start();
  }, [createAgent]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const text = draft.trim();
      if (!text) return;
      // Optimistically render the user message in the dot-matrix chat log.
      setChatMessages((current) => [
        ...current,
        { id: `user-${Date.now()}-${current.length}`, role: "user", text },
      ]);
      setDraft("");
      setChatError(undefined);
      const agent = await ensureAgent();
      if (!agent) {
        setChatError("Unable to connect Pepe HQ chat.");
        return;
      }
      const sent = agent.sendUserMessage(text);
      if (!sent) setChatError("Pepe HQ chat is not connected.");
    },
    [draft, ensureAgent],
  );

  useEffect(() => {
    return () => {
      void agentRef.current?.stop();
    };
  }, []);

  const isSpeaking = status === "speaking";

  // ── Activity feed ──────────────────────────────────────────────────────────
  const { rows, status: feedStatus } = useActivityFeed();

  // ── Beam pulse + cursor blink tick (200ms) ─────────────────────────────────
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1024), 200);
    return () => clearInterval(id);
  }, []);
  const beamPhase = (tick % 10) / 10;
  const cursorOn = inputFocused && tick % 4 < 2;

  const demoRows = useMemo<ActivityToken[]>(
    () =>
      DEMO_ROWS.map((row, index) => {
        const wave = Math.sin(tick * 0.18 + index * 0.7);
        return {
          ...row,
          price: (row.price ?? 0) * (1 + wave * 0.006),
          fiveMinGain: (row.fiveMinGain ?? 0) + wave * 0.018,
          buyPressure5m: Math.max(
            0.05,
            Math.min(0.98, (row.buyPressure5m ?? 0) + wave * 0.05),
          ),
        };
      }),
    [tick],
  );

  const boardRows = useMemo(
    () =>
      [...(rows.length ? rows : demoRows)]
        .sort((a, b) => (b.fiveMinGain ?? -Infinity) - (a.fiveMinGain ?? -Infinity))
        .slice(0, 9),
    [demoRows, rows],
  );

  const selectedTokenId = useMemo(() => {
    if (boardRows.length === 0) return undefined;
    const index = Math.floor(tick / 10) % boardRows.length;
    return boardRows[index]?.tokenId;
  }, [boardRows, tick]);

  // ── Layout selection + responsive scale ───────────────────────────────────
  const [layout, setLayout] = useState<"mobile" | "desktop">("mobile");
  const [fitScale, setFitScale] = useState(1);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const apply = () => {
      const el = screenRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      const isDesktop = window.innerWidth >= 768;
      const dims = isDesktop ? DOT_BOARD_DESKTOP : DOT_BOARD;
      const boardWidth = dims.cols * PIXEL;
      const boardHeight = dims.rows * PIXEL;
      const scale = Math.max(
        0.4,
        Math.min(
          (width - SCREEN_MARGIN * 2) / boardWidth,
          (height - SCREEN_MARGIN * 2) / boardHeight,
          isDesktop ? 4 : 3,
        ),
      );
      setLayout(isDesktop ? "desktop" : "mobile");
      setFitScale(scale);
    };
    apply();
    const observer = new ResizeObserver(apply);
    if (screenRef.current) observer.observe(screenRef.current);
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, []);

  // ── Render the matrix ─────────────────────────────────────────────────────
  const result = useMemo(
    () =>
      renderBoard(boardRows, {
        status: feedStatus,
        selectedTokenId,
        pepeIsSpeaking: isSpeaking,
        transcript,
        beamPhase,
        layout,
        chat: chatMessages,
        draft,
        cursorOn,
      }),
    [boardRows, feedStatus, selectedTokenId, isSpeaking, transcript, beamPhase, layout, chatMessages, draft, cursorOn],
  );

  const { matrix, pepeFrame, chatInputFrame, cols: boardCols, rows: boardRowsCount } = result;
  const px = (n: number) => n * PIXEL * fitScale;
  const fittedWidth = boardCols * PIXEL * fitScale;
  const fittedHeight = boardRowsCount * PIXEL * fitScale;
  const matrixScale = Math.max(1, Math.round(fitScale));

  return (
    <main className="relative h-[100dvh] w-screen overflow-hidden bg-[#03070d] text-white">
      <div
        ref={screenRef}
        className="grid h-full w-full place-items-center overflow-hidden"
        style={{
          background:
            "radial-gradient(circle at 50% 45%, rgba(65,235,224,0.10), transparent 60%)",
        }}
      >
        <div
          className="relative"
          style={{ width: fittedWidth, height: fittedHeight }}
        >
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              width: boardCols * PIXEL,
              height: boardRowsCount * PIXEL,
              transform: `translate(-50%, -50%) scale(${fitScale})`,
              transformOrigin: "center",
              boxShadow: "0 0 60px rgba(65, 235, 224, 0.22)",
            }}
          >
            {/* Layer 0 — full dot-matrix board (canvas) */}
            <DotMatrixCanvas matrix={matrix} scale={1} />

            {/* Layer 1 — Pepe sprite over the habitat panel */}
            <div
              className="absolute"
              style={{
                left: pepeFrame.x * PIXEL,
                top: pepeFrame.y * PIXEL,
                width: pepeFrame.w * PIXEL,
                height: pepeFrame.h * PIXEL,
                display: "grid",
                placeItems: "center",
              }}
              onDoubleClick={handleToggleVoice}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void handleToggleVoice();
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={
                agentRef.current?.isActive() ? "Stop Pepe voice" : "Start Pepe voice"
              }
              title="Double-click for voice"
            >
              <PepeHead
                volume={volume}
                isSpeaking={isSpeaking}
                transcript={null}
                size={Math.min(pepeFrame.w, pepeFrame.h) * PIXEL}
              />
            </div>

            {/* Layer 2 — chat input overlay aligned to the dot-matrix chat strip */}
            <form
              onSubmit={handleSubmit}
              className="absolute"
              style={{
                left: chatInputFrame.x * PIXEL,
                top: chatInputFrame.y * PIXEL,
                width: chatInputFrame.w * PIXEL,
                height: chatInputFrame.h * PIXEL,
              }}
            >
              <input
                type="text"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                placeholder=""
                aria-label="Message Pepe"
                spellCheck={false}
                autoCapitalize="characters"
                className="absolute inset-0 bg-transparent text-cyan-100 outline-none caret-cyan-200"
                style={{
                  paddingLeft: 22 * (PIXEL),
                  paddingRight: 26 * (PIXEL),
                  fontFamily: '"VT323", "IBM Plex Mono", ui-monospace, monospace',
                  fontSize: Math.max(10, chatInputFrame.h * PIXEL * 0.62),
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
              />
              <button
                type="submit"
                aria-label="Send message"
                className="absolute right-0 top-0 h-full"
                style={{
                  width: 22 * PIXEL,
                  background: "transparent",
                  border: "none",
                  cursor: draft.trim() ? "pointer" : "default",
                }}
              />
            </form>
          </div>
        </div>
      </div>

      {chatError && (
        <div
          className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-[0.18em] text-amber-300"
          role="status"
        >
          {chatError}
        </div>
      )}

      {/* Hidden helpers for screen readers and tests */}
      <div className="sr-only" aria-live="polite">
        Status: {status}. Session: {sessionKind}. Feed: {feedStatus}.
      </div>

      {/* Use these so TypeScript isn't grumpy if `px` is not referenced inline */}
      <span className="hidden">{px(0)}</span>
    </main>
  );
}
