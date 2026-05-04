import { NextResponse } from "next/server";

/**
 * Returns a signed ElevenLabs conversation URL.
 * The API key never leaves the server.
 */
export async function GET() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;

  if (!apiKey || !agentId) {
    return NextResponse.json(
      { error: "ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID must be set" },
      { status: 500 }
    );
  }

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
      {
        headers: { "xi-api-key": apiKey },
        cache: "no-store",
      }
    );

    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        { error: `ElevenLabs API error: ${res.status}`, details: body },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json({ signedUrl: data.signed_url });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch signed URL", details: String(err) },
      { status: 500 }
    );
  }
}
