export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VoicesRequest = {
  apiKey?: string;
};

export async function POST(req: Request) {
  let body: VoicesRequest;
  try {
    body = (await req.json()) as VoicesRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY?.trim() || body.apiKey?.trim();
  if (!apiKey) {
    return Response.json({ error: "ElevenLabs API key required" }, { status: 400 });
  }

  const upstream = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
    cache: "no-store",
  });

  if (!upstream.ok) {
    const details = await upstream.text().catch(() => "");
    return Response.json(
      {
        error: `ElevenLabs voices failed with ${upstream.status}`,
        details: details.slice(0, 600),
      },
      { status: upstream.status },
    );
  }

  const json = await upstream.json();
  return Response.json({
    voices: Array.isArray(json.voices)
      ? json.voices.map((voice: Record<string, unknown>) => ({
          voiceId: String(voice.voice_id ?? ""),
          name: String(voice.name ?? "Untitled voice"),
          category: String(voice.category ?? ""),
        }))
      : [],
  });
}
