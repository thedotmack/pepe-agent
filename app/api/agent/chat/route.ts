/**
 * POST /api/agent/chat
 *
 * Phase 6 chat proxy: forwards the user's text to the worker's /chat endpoint
 * and streams the worker's SSE response back to the browser unchanged.
 *
 * The worker is gated by AGENT_SHARED_SECRET — we attach it server-side so it
 * never touches the browser. The response is forwarded as text/event-stream;
 * the browser parses SSE frames via lib/agent-chat-stream.ts.
 */
const WORKER_URL = process.env.AGENT_WORKER_URL ?? "http://127.0.0.1:7011";
const SHARED_SECRET = process.env.AGENT_SHARED_SECRET ?? "";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!SHARED_SECRET) {
    return new Response("AGENT_SHARED_SECRET not set", { status: 503 });
  }

  const body = await req.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${WORKER_URL}/chat`, {
      method: "POST",
      headers: {
        "x-agent-secret": SHARED_SECRET,
        "content-type": "application/json",
      },
      body,
      signal: req.signal,
      cache: "no-store",
    });
  } catch (err) {
    return new Response(`worker unreachable: ${String(err)}`, { status: 503 });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return new Response(
      `worker returned ${upstream.status}${detail ? `: ${detail}` : ""}`,
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
