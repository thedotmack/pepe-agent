/**
 * Browser-side SSE streaming-fetch parser for /api/agent/chat.
 *
 * EventSource doesn't support POST, so we POST the user's text and then read
 * the response body as a stream of SSE frames. Frames look like:
 *
 *   event: chunk
 *   data: {"text":"..."}
 *
 *   event: end
 *   data: {"reason":"turn-complete"}
 *
 * (Empty line terminates each frame.)
 *
 * Used by both text mode (lib/agent.ts -> sendUserMessage) and the future
 * voice-mode hijack path that posts ElevenLabs's STT transcript here instead
 * of letting ElevenLabs's bundled LLM respond.
 */

export interface ChatStreamHandlers {
  onChunk: (text: string) => void;
  onEnd: (reason: string) => void;
  onError: (err: string) => void;
}

export async function streamChat(
  text: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch (err) {
    handlers.onError(`fetch failed: ${String(err)}`);
    return;
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    handlers.onError(`chat ${res.status}${detail ? `: ${detail}` : ""}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on the SSE frame terminator: blank line.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        if (!frame.trim()) continue;
        let eventType: string | null = null;
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
          // ignore comment lines (`:`) and unknown fields
        }
        if (!eventType || dataLines.length === 0) continue;
        const dataRaw = dataLines.join("\n");
        let data: unknown;
        try {
          data = JSON.parse(dataRaw);
        } catch {
          continue;
        }

        if (eventType === "chunk") {
          const t = (data as { text?: unknown } | null)?.text;
          if (typeof t === "string") handlers.onChunk(t);
        } else if (eventType === "end") {
          const reason = (data as { reason?: unknown } | null)?.reason;
          handlers.onEnd(typeof reason === "string" ? reason : "end");
          return;
        } else if (eventType === "error") {
          const message = (data as { message?: unknown } | null)?.message;
          handlers.onError(
            typeof message === "string" ? message : "stream error",
          );
          return;
        }
      }
    }
    // Stream ended without explicit `end` event — treat as complete.
    handlers.onEnd("stream-closed");
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      handlers.onEnd("aborted");
      return;
    }
    handlers.onError(`stream read failed: ${String(err)}`);
  }
}
