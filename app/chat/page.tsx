"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { HttpAgent, type AgentSubscriber, type Message } from "@ag-ui/client";
import PepeHead from "@/components/pepe-head/PepeHead";
import { usePepeSpeech } from "@/lib/use-pepe-speech";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "pepe-intro",
    role: "assistant",
    content: "gm. Pepe is online. Ask me what to build, fix, ship, or explain.",
  },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toAgUiMessages(messages: ChatMessage[]): Message[] {
  return messages
    .filter((message) => message.content.trim())
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    })) as Message[];
}

export default function ChatPage() {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamStatus, setStreamStatus] = useState("ready");
  const [pepeSize, setPepeSize] = useState(360);
  const messagesRef = useRef<ChatMessage[]>(INITIAL_MESSAGES);
  const assistantBuffersRef = useRef<Map<string, string>>(new Map());
  const activeAgentRef = useRef<HttpAgent | null>(null);
  const activeAbortRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const threadIdRef = useRef(createId("pepe-thread"));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const speech = usePepeSpeech({ initialLine: INITIAL_MESSAGES[0].content });

  const setSyncedMessages = useCallback(
    (updater: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => {
      setMessages((current) => {
        const next = typeof updater === "function" ? updater(current) : updater;
        messagesRef.current = next;
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    const resize = () => {
      const base = Math.min(window.innerWidth * 0.46, window.innerHeight * 0.44);
      setPepeSize(clamp(base, 210, 440));
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ block: "end" });
  }, [messages, isStreaming]);

  useEffect(() => {
    return () => {
      activeAbortRef.current?.abort();
      activeAgentRef.current?.abortRun();
    };
  }, []);

  const stopRun = useCallback(() => {
    activeAbortRef.current?.abort();
    activeAgentRef.current?.abortRun();
    activeAbortRef.current = null;
    activeAgentRef.current = null;
    activeRunIdRef.current = null;
    setIsStreaming(false);
    setStreamStatus("stopped");
  }, []);

  const appendAssistantDelta = useCallback(
    (messageId: string, delta: string) => {
      assistantBuffersRef.current.set(
        messageId,
        `${assistantBuffersRef.current.get(messageId) ?? ""}${delta}`,
      );
      setSyncedMessages((current) =>
        current.map((message) =>
          message.id === messageId ? { ...message, content: message.content + delta } : message,
        ),
      );
    },
    [setSyncedMessages],
  );

  const runAgent = useCallback(
    async (history: ChatMessage[]) => {
      const runId = createId("pepe-run");
      const controller = new AbortController();
      const agent = new HttpAgent({
        url: "/api/ag-ui/openai",
        threadId: threadIdRef.current,
        initialMessages: toAgUiMessages(history),
        initialState: {},
      });

      activeRunIdRef.current = runId;
      activeAbortRef.current = controller;
      activeAgentRef.current = agent;
      setIsStreaming(true);
      setStreamStatus("thinking");

      const subscriber: AgentSubscriber = {
        onTextMessageStartEvent: ({ event }) => {
          assistantBuffersRef.current.set(event.messageId, "");
          setSyncedMessages((current) => {
            if (current.some((message) => message.id === event.messageId)) return current;
            return [...current, { id: event.messageId, role: "assistant", content: "" }];
          });
          setStreamStatus("streaming");
        },
        onTextMessageContentEvent: ({ event }) => {
          appendAssistantDelta(event.messageId, event.delta);
        },
        onTextMessageEndEvent: ({ event, textMessageBuffer }) => {
          const finalText = (
            assistantBuffersRef.current.get(event.messageId) ??
            textMessageBuffer ??
            ""
          ).trim();
          assistantBuffersRef.current.delete(event.messageId);
          setStreamStatus("speaking");
          if (finalText) speech.speak(finalText);
        },
        onRunErrorEvent: ({ event }) => {
          const errorText = event.message || "The AG-UI run failed.";
          setSyncedMessages((current) => [
            ...current,
            { id: createId("pepe-error"), role: "assistant", content: errorText },
          ]);
          setStreamStatus("error");
        },
      };

      try {
        await agent.runAgent({ runId, abortController: controller }, subscriber);
        if (activeRunIdRef.current === runId) {
          setStreamStatus("ready");
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError" && activeRunIdRef.current === runId) {
          const errorText = err instanceof Error ? err.message : String(err);
          setSyncedMessages((current) => [
            ...current,
            { id: createId("pepe-error"), role: "assistant", content: errorText },
          ]);
          setStreamStatus("error");
        }
      } finally {
        if (activeRunIdRef.current === runId) {
          activeRunIdRef.current = null;
          activeAbortRef.current = null;
          activeAgentRef.current = null;
          setIsStreaming(false);
        }
      }
    },
    [appendAssistantDelta, setSyncedMessages, speech],
  );

  const handleSubmit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || isStreaming) return;

    speech.stop();
    const userMessage: ChatMessage = {
      id: createId("user"),
      role: "user",
      content: text,
    };
    const nextMessages = [...messagesRef.current, userMessage];
    setDraft("");
    setSyncedMessages(nextMessages);
    void runAgent(nextMessages);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    handleSubmit();
  };

  const latestAssistantMessage =
    messages.findLast((message) => message.role === "assistant")?.content || "";
  const latestAssistantLine = isStreaming
    ? latestAssistantMessage || speech.lastLine
    : speech.lastLine || latestAssistantMessage;

  return (
    <main className="h-[100dvh] w-screen overflow-hidden bg-[#05070a] text-white">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-white/10 bg-[#070b10]/96 px-4 py-3 md:px-6">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.2em] text-cyan-100/55">Pepe HQ</p>
            <h1 className="truncate text-lg font-semibold text-white md:text-xl">Pepe chat</h1>
          </div>
          <nav className="flex shrink-0 items-center gap-2">
            <a
              href="/director"
              className="border border-cyan-200/25 px-3 py-2 text-xs font-medium uppercase tracking-[0.12em] text-cyan-100 hover:border-cyan-200/55"
            >
              Director
            </a>
            <button
              type="button"
              onClick={speech.stop}
              className="border border-white/12 px-3 py-2 text-xs font-medium uppercase tracking-[0.12em] text-white/70 hover:border-white/30 hover:text-white"
            >
              Mute
            </button>
          </nav>
        </header>

        <section className="grid min-h-0 flex-1 grid-rows-[minmax(220px,40dvh)_minmax(0,1fr)] bg-[radial-gradient(circle_at_28%_20%,rgba(41,210,194,0.16),transparent_32%),radial-gradient(circle_at_78%_12%,rgba(240,202,78,0.1),transparent_24%),#05070a] md:grid-cols-[minmax(280px,0.9fr)_minmax(420px,1.1fr)] md:grid-rows-1">
          <div className="relative min-h-0 overflow-hidden border-b border-white/10 md:border-b-0 md:border-r">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/45 to-transparent" />
            <div className="absolute inset-0 grid place-items-center">
              <div
                className={`transition-opacity duration-200 ${speech.assetsReady ? "opacity-100" : "opacity-0"}`}
                aria-hidden={!speech.assetsReady}
              >
                <PepeHead
                  volume={speech.volume}
                  isSpeaking={speech.isSpeaking}
                  transcript={latestAssistantLine}
                  size={pepeSize}
                />
              </div>
            </div>
            <div className="absolute inset-x-4 bottom-4 border border-cyan-200/18 bg-black/45 px-4 py-3 backdrop-blur">
              <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.16em] text-cyan-100/55">
                <span>Voice {speech.engine}</span>
                <span>{speech.status}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm leading-5 text-white/82">{latestAssistantLine}</p>
            </div>
          </div>

          <div className="flex min-h-0 flex-col bg-[#090d12]/94">
            <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3 md:px-5">
              <div>
                <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">
                  CopilotKit AG-UI
                </p>
                <p className="mt-1 text-sm font-medium text-white">Pepe voice bridge</p>
              </div>
              <div className="border border-white/10 px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-white/55">
                {isStreaming ? streamStatus : "ready"}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-5">
              <div className="mx-auto flex max-w-3xl flex-col gap-3">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[84%] border px-4 py-3 text-sm leading-6 shadow-sm md:max-w-[76%] ${
                        message.role === "user"
                          ? "border-cyan-200/25 bg-cyan-200/10 text-cyan-50"
                          : "border-white/10 bg-[#101820] text-white/88"
                      }`}
                    >
                      <p className="mb-1 text-[10px] uppercase tracking-[0.16em] text-white/35">
                        {message.role === "user" ? "You" : "Pepe"}
                      </p>
                      <p className="whitespace-pre-wrap break-words">
                        {message.content || (isStreaming ? "..." : "")}
                      </p>
                    </div>
                  </div>
                ))}
                <div ref={scrollRef} />
              </div>
            </div>

            <form
              onSubmit={handleSubmit}
              className="shrink-0 border-t border-white/10 bg-[#070b10] px-4 py-3 md:px-5"
            >
              <div className="mx-auto flex max-w-3xl items-end gap-3">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isStreaming}
                  aria-label="Message Pepe"
                  autoFocus
                  rows={1}
                  placeholder="Message Pepe..."
                  className="max-h-36 min-h-11 flex-1 resize-none border border-white/12 bg-black/28 px-3 py-3 text-sm leading-5 text-white outline-none placeholder:text-white/32 focus:border-cyan-200/45 disabled:cursor-not-allowed disabled:opacity-55"
                />
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={stopRun}
                    className="h-11 shrink-0 border border-rose-200/35 px-4 text-xs font-semibold uppercase tracking-[0.14em] text-rose-100 hover:border-rose-200/70"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!draft.trim()}
                    className="h-11 shrink-0 border border-cyan-200/35 bg-cyan-200/10 px-4 text-xs font-semibold uppercase tracking-[0.14em] text-cyan-50 hover:border-cyan-200/70 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-white/28"
                  >
                    Send
                  </button>
                )}
              </div>
            </form>
          </div>
        </section>
      </div>

      <audio ref={speech.audioRef} className="hidden" />
    </main>
  );
}
