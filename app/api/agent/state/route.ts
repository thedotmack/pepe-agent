import { NextResponse } from "next/server";

const WORKER_URL = process.env.AGENT_WORKER_URL ?? "http://127.0.0.1:7011";
const SHARED_SECRET = process.env.AGENT_SHARED_SECRET ?? "";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!SHARED_SECRET) {
    return NextResponse.json(
      { error: "AGENT_SHARED_SECRET not set" },
      { status: 503 },
    );
  }
  try {
    const res = await fetch(`${WORKER_URL}/state`, {
      headers: { "x-agent-secret": SHARED_SECRET },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `worker returned ${res.status}` },
        { status: 502 },
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json(
      { error: `worker unreachable: ${String(err)}` },
      { status: 503 },
    );
  }
}
