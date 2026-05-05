/**
 * SSE chat-stream helper for Phase 6.
 *
 * Drives a single agent turn:
 *   1. Calls `agent.injectUserMessage(userText)` to force a query.
 *   2. Forwards every `assistantText` chunk emitted on the loop's emitter as
 *      an SSE `event: chunk\ndata: {"text":"..."}` frame.
 *   3. Closes the stream when a `result` event lands (turn complete) by
 *      sending a final `event: end\ndata: {"reason":"turn-complete"}` frame.
 *
 * The agent loop is shared (one long-lived `query()` per worker). This helper
 * does NOT spawn a new query — it only *injects* into the existing streaming
 * input generator.
 *
 * Concurrency: the agent's `outbound` emitter is process-global, so two
 * simultaneous chat connections would otherwise both observe each other's
 * `assistantText` chunks AND both close on the first `result`. To avoid this
 * cross-talk we serialize chat streams behind a per-process mutex; a second
 * concurrent /chat call awaits the prior turn's completion before injecting.
 */
import type { AgentLoopHandle } from "../agent/loop.ts";

export interface ChatStreamArgs {
  agent: AgentLoopHandle;
  userText: string;
  signal?: AbortSignal;
}

const encoder = new TextEncoder();

function encodeSseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Per-process mutex serializing chat turns. The agent loop processes one
// user turn at a time anyway (sequential SDK iterator), so queueing here
// matches real backend ordering and prevents listener cross-talk.
let chatTurnLock: Promise<void> = Promise.resolve();

export function createChatStream(args: ChatStreamArgs): ReadableStream<Uint8Array> {
  const { agent, userText, signal } = args;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let onAssistantText: ((text: string) => void) | null = null;
      let onResult: (() => void) | null = null;
      let onError: ((err: unknown) => void) | null = null;
      let onAbort: (() => void) | null = null;
      let releaseLock: (() => void) | null = null;

      const cleanup = () => {
        if (onAssistantText) agent.emitter.off("assistantText", onAssistantText);
        if (onResult) agent.emitter.off("result", onResult);
        if (onError) agent.emitter.off("error", onError);
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
        onAssistantText = null;
        onResult = null;
        onError = null;
        onAbort = null;
        if (releaseLock) {
          releaseLock();
          releaseLock = null;
        }
      };

      const closeWith = (event: string, data: unknown) => {
        if (closed) return;
        closed = true;
        try {
          controller.enqueue(encodeSseFrame(event, data));
        } catch {
          // controller may already be closed
        }
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Acquire the per-process chat lock. Until it resolves, do not touch
      // the agent emitter or inject — another turn may be in flight.
      const prior = chatTurnLock;
      chatTurnLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });

      const earlyAbort = () => {
        // Client gave up before we even acquired the lock. Make sure the
        // lock-release fires so we don't deadlock the next caller.
        closeWith("end", { reason: "client-aborted" });
      };

      if (signal) {
        if (signal.aborted) {
          earlyAbort();
          return;
        }
        // Pre-lock abort listener; we replace it with the real `onAbort`
        // once we own the turn.
        signal.addEventListener("abort", earlyAbort, { once: true });
      }

      void prior.then(() => {
        if (closed) return; // aborted while queued

        if (signal) {
          signal.removeEventListener("abort", earlyAbort);
          if (signal.aborted) {
            closeWith("end", { reason: "client-aborted" });
            return;
          }
        }

        onAssistantText = (text: string) => {
          if (closed) return;
          try {
            controller.enqueue(encodeSseFrame("chunk", { text }));
          } catch {
            // stream closed under us — bail
            closeWith("end", { reason: "stream-closed" });
          }
        };

        onResult = () => {
          closeWith("end", { reason: "turn-complete" });
        };

        onError = (err: unknown) => {
          closeWith("error", { message: String(err) });
        };

        onAbort = () => {
          closeWith("end", { reason: "client-aborted" });
        };

        agent.emitter.on("assistantText", onAssistantText);
        agent.emitter.on("result", onResult);
        agent.emitter.on("error", onError);
        if (signal) signal.addEventListener("abort", onAbort);

        // Inject *after* listeners are wired so we can't miss the first chunk.
        try {
          agent.injectUserMessage(userText);
        } catch (err) {
          closeWith("error", { message: String(err) });
        }
      });
    },

    cancel() {
      // ReadableStream consumer aborted — listeners + lock release happen
      // via the abort signal / closeWith path.
    },
  });
}
