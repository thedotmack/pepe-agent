const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TtsRequest = {
  apiKey?: string;
  voiceId?: string;
  text?: string;
  modelId?: string;
};

export async function POST(req: Request) {
  let body: TtsRequest;
  try {
    body = (await req.json()) as TtsRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const apiKey = body.apiKey?.trim();
  const voiceId = body.voiceId?.trim();
  const text = body.text?.trim();
  const modelId = body.modelId?.trim() || "eleven_flash_v2_5";

  if (!apiKey) return Response.json({ error: "ElevenLabs API key required" }, { status: 400 });
  if (!voiceId) return Response.json({ error: "ElevenLabs voice ID required" }, { status: 400 });
  if (!text) return Response.json({ error: "Text required" }, { status: 400 });
  if (text.length > 2_500) {
    return Response.json({ error: "Text must be 2500 characters or fewer" }, { status: 400 });
  }

  const upstream = await fetch(`${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability: 0.42,
        similarity_boost: 0.78,
        style: 0.18,
        use_speaker_boost: true,
      },
    }),
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    const details = await upstream.text().catch(() => "");
    return Response.json(
      {
        error: `ElevenLabs TTS failed with ${upstream.status}`,
        details: details.slice(0, 600),
      },
      { status: upstream.status },
    );
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
