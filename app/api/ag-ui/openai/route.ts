import { EventType, RunAgentInputSchema, type Message } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import OpenAI from "openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

type OpenAIChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function messageContentToText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toOpenAIMessages(messages: Message[]): OpenAIChatMessage[] {
  const mapped = messages
    .map((message): OpenAIChatMessage | null => {
      if (
        message.role !== "system" &&
        message.role !== "developer" &&
        message.role !== "user" &&
        message.role !== "assistant"
      ) {
        return null;
      }
      const content = messageContentToText(message.content);
      if (!content.trim()) return null;
      return {
        role: message.role === "developer" ? "system" : message.role,
        content,
      };
    })
    .filter((message): message is OpenAIChatMessage => Boolean(message));

  if (mapped.some((message) => message.role === "system")) return mapped;

  return [
    {
      role: "system",
      content:
        "You are Pepe HQ chat. Be concise, practical, and useful. Help contributors understand and run the open-source Pepe Agent project.",
    },
    ...mapped,
  ];
}

export async function POST(req: Request) {
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return Response.json({ error: "Invalid AG-UI JSON body" }, { status: 400 });
  }

  const parsed = RunAgentInputSchema.safeParse(input);
  if (!parsed.success) {
    return Response.json({ error: "Invalid AG-UI run input" }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const baseURL = process.env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const runInput = parsed.data;
  const eventEncoder = new EventEncoder({
    accept: req.headers.get("accept") ?? undefined,
  });
  const textEncoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: Parameters<typeof eventEncoder.encode>[0]) => {
        controller.enqueue(textEncoder.encode(eventEncoder.encode(event)));
      };

      try {
        emit({
          type: EventType.RUN_STARTED,
          threadId: runInput.threadId,
          runId: runInput.runId,
        });

        if (!apiKey) {
          const messageId = crypto.randomUUID();
          emit({
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
          });
          emit({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta:
              "OPENAI_API_KEY is not set yet. Add OPENAI_API_KEY to .env.local, optionally set OPENAI_BASE_URL and OPENAI_MODEL, then restart the dev server.",
          });
          emit({
            type: EventType.TEXT_MESSAGE_END,
            messageId,
          });
          emit({
            type: EventType.RUN_FINISHED,
            threadId: runInput.threadId,
            runId: runInput.runId,
          });
          return;
        }

        const client = new OpenAI({ apiKey, baseURL });
        const messageId = crypto.randomUUID();
        emit({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
        });

        const completionStream = await client.chat.completions.create({
          model,
          messages: toOpenAIMessages(runInput.messages),
          stream: true,
        });

        for await (const chunk of completionStream) {
          if (req.signal.aborted) break;
          const delta = chunk.choices[0]?.delta?.content;
          if (!delta) continue;
          emit({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta,
          });
        }

        emit({ type: EventType.TEXT_MESSAGE_END, messageId });
        emit({
          type: EventType.RUN_FINISHED,
          threadId: runInput.threadId,
          runId: runInput.runId,
        });
      } catch (err) {
        emit({
          type: EventType.RUN_ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": eventEncoder.getContentType(),
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
