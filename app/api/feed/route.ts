import type { NextRequest } from "next/server";
import WebSocket from "ws";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_WS_URL = "wss://data.cmem.ai/activity";
const DEFAULT_REST_URL = "https://data.cmem.ai/api/activity/top/50";

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  const wsUrl = process.env.ACTIVITY_WS_UPSTREAM_URL ?? DEFAULT_WS_URL;
  const restUrl = process.env.ACTIVITY_REST_FALLBACK_URL ?? DEFAULT_REST_URL;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      const send = (event: string, data: unknown) => {
        safeEnqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      send("hello", { ts: Date.now() });

      let timer: ReturnType<typeof setInterval> | null = null;
      let restTimer: ReturnType<typeof setInterval> | null = null;
      let upstream: WebSocket | null = null;

      const clearTimers = () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        if (restTimer) {
          clearInterval(restTimer);
          restTimer = null;
        }
      };

      const startRest = () => {
        clearTimers();
        const tick = async () => {
          if (closed) return;
          try {
            const r = await fetch(restUrl, { cache: "no-store" });
            const data = await r.json();
            send("tokens", {
              type: "update",
              data,
              timestamp: Date.now(),
            });
            send("status", { mode: "rest-fallback" });
          } catch (e) {
            send("error", { message: String(e) });
          }
        };
        // fire immediately, then poll
        void tick();
        restTimer = setInterval(tick, 1500);
      };

      const startWs = () => {
        try {
          upstream = new WebSocket(wsUrl);
        } catch (e) {
          send("error", { message: `ws-init: ${String(e)}` });
          startRest();
          return;
        }

        upstream.on("open", () => {
          send("status", { mode: "live" });
        });

        upstream.on("message", (buf) => {
          try {
            const text = buf.toString();
            const payload = JSON.parse(text);
            send("tokens", payload);
          } catch {
            // silently drop non-JSON pings/binary frames
          }
        });

        upstream.on("close", () => {
          if (closed) return;
          startRest();
        });

        upstream.on("error", () => {
          // close() will fire and trigger startRest()
          try {
            upstream?.close();
          } catch {
            /* noop */
          }
        });

        // SSE keepalive ping (separate from upstream lifecycle)
        timer = setInterval(() => send("ping", { ts: Date.now() }), 15_000);
      };

      startWs();

      const onAbort = () => {
        if (closed) return;
        closed = true;
        clearTimers();
        try {
          upstream?.close();
        } catch {
          /* noop */
        }
        try {
          controller.close();
        } catch {
          /* noop */
        }
      };

      req.signal.addEventListener("abort", onAbort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
