/**
 * Pepe-Agent session manager.
 *
 * One brain (worker's Claude Agent SDK loop) wrapped in two transports:
 * text-only (POST /api/agent/chat) and voice (ElevenLabs as mic + speaker).
 * In voice mode we hijack ElevenLabs's user-role transcript and route it to
 * the worker; ElevenLabs's own agent-role LLM output is suppressed.
 */

import { Conversation } from "@elevenlabs/client";
import { streamChat } from "./agent-chat-stream";

export type AgentStatus = "idle" | "connecting" | "listening" | "speaking";

type AgentMode = "text" | "voice" | null;

export type ChatMessage = {
  role: "user" | "agent";
  text: string;
  createdAt: Date;
  id?: string;
};

type ElevenLabsMessagePayload = {
  message: string;
  event_id?: number;
  role?: "user" | "agent";
  source?: "user" | "ai";
};

type StartOptions = {
  textOnly?: boolean;
};

export interface AgentCallbacks {
  onStatusChange: (status: AgentStatus) => void;
  onTranscript: (text: string, isFinal: boolean) => void;
  onMessage?: (message: ChatMessage) => void;
  /** Called ~60fps while agent is speaking with a 0-1 volume level */
  onVolume: (level: number) => void;
  onError: (error: string) => void;
}

export class PepeAgent {
  private conversation: Conversation | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private volumeRafId: number | null = null;
  private callbacks: AgentCallbacks;
  private mode: AgentMode = null;
  private chatAbort: AbortController | null = null;

  constructor(callbacks: AgentCallbacks) {
    this.callbacks = callbacks;
  }

  async start({ textOnly = false }: StartOptions = {}): Promise<void> {
    if (textOnly) {
      this.mode = "text";
      // Text mode: no socket, no ElevenLabs. We're "listening" the moment
      // start() resolves — the user can type immediately and sendUserMessage()
      // will open a streaming POST per turn.
      this.callbacks.onStatusChange("listening");
      return;
    }

    this.mode = "voice";
    this.callbacks.onStatusChange("connecting");

    // Fetch a signed URL from our server route (keeps API key server-side)
    let signedUrl: string;
    try {
      const res = await fetch("/api/agent-token");
      if (!res.ok) throw new Error(`agent-token: ${res.status}`);
      const data = await res.json();
      signedUrl = data.signedUrl;
    } catch (err) {
      this.callbacks.onError(`Failed to get agent token: ${err}`);
      this.callbacks.onStatusChange("idle");
      return;
    }

    try {
      this.conversation = await Conversation.startSession({
        signedUrl,
        textOnly,

        onConnect: () => {
          this.callbacks.onStatusChange("listening");
        },

        onDisconnect: () => {
          this.stopVolumePolling();
          this.callbacks.onStatusChange("idle");
        },

        onError: (message: string) => {
          this.callbacks.onError(message);
        },

        onModeChange: (mode: { mode: string }) => {
          if (mode.mode === "speaking") {
            this.callbacks.onStatusChange("speaking");
            this.startVolumePolling();
          } else {
            this.stopVolumePolling();
            this.callbacks.onStatusChange("listening");
            this.callbacks.onVolume(0);
          }
        },

        // Per PLAN-pepe-harness.md:481 — ElevenLabs is mic + speaker, never
        // the brain. We split incoming messages by role:
        //   - role === "user": this is the finalized STT transcript. Echo
        //     it to the chat log AND hijack it to /api/agent/chat so the
        //     worker's Claude Agent SDK loop is the one that responds.
        //   - role === "agent": this is the ElevenLabs-bundled LLM trying
        //     to answer. SUPPRESS — never surface, never log. The worker's
        //     response (streamed back as SSE chunks) is what reaches the
        //     dot-matrix log instead.
        onMessage: (message: ElevenLabsMessagePayload) => {
          const role = this.getMessageRole(message);
          if (role === "agent") {
            // Discard the ElevenLabs brain's response. The real reply will
            // arrive via streamChat chunks below.
            return;
          }

          const chatMessage: ChatMessage = {
            role: "user",
            text: message.message,
            createdAt: new Date(),
            ...(message.event_id !== undefined
              ? { id: String(message.event_id) }
              : {}),
          };
          this.callbacks.onMessage?.(chatMessage);

          // Hijack the transcript: forward it to the worker just like the
          // text-mode path. We intentionally do NOT echo the user message a
          // second time (sendWorkerTurn would normally echo) since
          // ElevenLabs already gave us the canonical event_id'd version.
          this.sendWorkerTurn(message.message, { echoUser: false });
        },
      });
    } catch (err) {
      this.callbacks.onError(`Failed to start session: ${err}`);
      this.callbacks.onStatusChange("idle");
    }
  }

  sendUserMessage(text: string): boolean {
    if (this.mode === "text") {
      this.sendWorkerTurn(text, { echoUser: true });
      return true;
    }
    if (!this.conversation) return false;

    // Voice mode: forward to ElevenLabs ONLY. ElevenLabs will echo back a
    // finalized `onMessage(role: "user")` payload (with its canonical
    // event_id), and our onMessage handler is the single place that
    // hijacks the transcript into a worker turn. Calling sendWorkerTurn
    // directly here would double-fire the worker turn.
    this.conversation.sendUserMessage(text);
    return true;
  }

  /**
   * One assistant turn driven by the worker's Claude Agent SDK loop.
   *
   * POST /api/agent/chat -> SSE chunks -> `onMessage({role: "agent", ...})`.
   * Used by both text mode and the voice-mode hijack path
   * (PLAN-pepe-harness.md:481). Concurrent calls are allowed — the worker's
   * streaming-input generator queues them — but we still abort an in-flight
   * stream from the SAME mode to avoid interleaving the same assistant
   * buffer.
   *
   * @param text the user's prompt (already a finalized utterance / typed line)
   * @param echoUser whether to add a `{role: "user"}` chat entry first.
   *   Text mode: true (no other UI source). Voice hijack: false (the
   *   ElevenLabs onMessage handler already emitted the user line with its
   *   canonical event_id).
   */
  private sendWorkerTurn(
    text: string,
    { echoUser }: { echoUser: boolean },
  ): void {
    if (echoUser) {
      this.callbacks.onMessage?.({
        role: "user",
        text,
        createdAt: new Date(),
      });
    }

    // Cancel any in-flight chat stream from a previous turn so we never
    // interleave two turns into the same assistant message buffer.
    if (this.chatAbort) {
      this.chatAbort.abort();
    }
    const abort = new AbortController();
    this.chatAbort = abort;

    this.callbacks.onStatusChange("speaking");

    void streamChat(
      text,
      {
        onChunk: (chunkText) => {
          // Emit each chunk as its own chat entry so the dot-matrix log
          // grows incrementally — matches how the agent emits one
          // `assistantText` per assistant message in a turn.
          this.callbacks.onMessage?.({
            role: "agent",
            text: chunkText,
            createdAt: new Date(),
          });
          this.callbacks.onTranscript(chunkText, true);
        },
        onEnd: () => {
          if (this.chatAbort === abort) this.chatAbort = null;
          // In voice mode, ElevenLabs's onModeChange owns the
          // listening/speaking status; only flip it back here for text mode.
          if (this.mode === "text") {
            this.callbacks.onStatusChange("listening");
          }
        },
        onError: (err) => {
          if (this.chatAbort === abort) this.chatAbort = null;
          this.callbacks.onError(err);
          if (this.mode === "text") {
            this.callbacks.onStatusChange("listening");
          }
        },
      },
      abort.signal,
    );
  }

  sendUserActivity(): void {
    if (this.mode === "text") return;
    this.conversation?.sendUserActivity();
  }

  async stop(): Promise<void> {
    this.stopVolumePolling();
    if (this.chatAbort) {
      this.chatAbort.abort();
      this.chatAbort = null;
    }
    if (this.conversation) {
      await this.conversation.endSession();
      this.conversation = null;
    }
    this.mode = null;
    this.callbacks.onStatusChange("idle");
    this.callbacks.onVolume(0);
  }

  /**
   * Poll the output audio stream for volume levels so we can drive lip-sync
   * and the ASCII background reactivity.
   *
   * @11labs/client routes agent audio through a standard <audio> element that
   * it creates on the page. We grab it via the AudioContext and an AnalyserNode.
   */
  private startVolumePolling(): void {
    if (this.volumeRafId !== null) return;

    try {
      if (!this.audioContext) {
        this.audioContext = new AudioContext();
      }
      if (!this.analyser) {
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 256;

        // Connect any playing <audio> element created by @11labs/client
        const audioEl = document.querySelector<HTMLAudioElement>(
          "audio[data-elevenlabs]"
        );
        if (audioEl) {
          const src =
            this.audioContext.createMediaElementSource(audioEl);
          src.connect(this.analyser);
          this.analyser.connect(this.audioContext.destination);
        }
      }

      const data = new Uint8Array(this.analyser.frequencyBinCount);
      const poll = () => {
        this.analyser!.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        this.callbacks.onVolume(Math.min(avg / 128, 1));
        this.volumeRafId = requestAnimationFrame(poll);
      };
      this.volumeRafId = requestAnimationFrame(poll);
    } catch {
      // Web Audio not available — fall back to a simple pulsing value
      let t = 0;
      const poll = () => {
        t += 0.1;
        this.callbacks.onVolume(0.4 + 0.4 * Math.abs(Math.sin(t)));
        this.volumeRafId = requestAnimationFrame(poll);
      };
      this.volumeRafId = requestAnimationFrame(poll);
    }
  }

  private getMessageRole(message: ElevenLabsMessagePayload): ChatMessage["role"] {
    if (message.role) return message.role;
    return message.source === "ai" ? "agent" : "user";
  }

  private stopVolumePolling(): void {
    if (this.volumeRafId !== null) {
      cancelAnimationFrame(this.volumeRafId);
      this.volumeRafId = null;
    }
  }

  isActive(): boolean {
    return this.mode !== null;
  }
}
