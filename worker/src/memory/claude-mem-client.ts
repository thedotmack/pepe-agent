/**
 * HTTP client for the local claude-mem worker.
 *
 * Worker URL resolution order:
 *   1. process.env.CLAUDE_MEM_WORKER_URL (full URL override)
 *   2. ~/.claude-mem/settings.json -> CLAUDE_MEM_WORKER_PORT
 *   3. fallback: 127.0.0.1:(37700 + uid % 100)
 *
 * Endpoints (see PLAN-pepe-harness.md Phase 0.B):
 *   POST /api/sessions/init
 *   POST /api/sessions/observations
 *   POST /api/sessions/summarize
 *   GET  /api/search?query=...&project=...&limit=...
 *   GET  /health
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export interface InitSessionInput {
  contentSessionId: string;
  project: string;
  prompt: string;
  platformSource?: string;
}

export interface RecordObservationInput {
  contentSessionId: string;
  tool_name: string;
  tool_input: string;
  tool_response: string;
  cwd: string;
  platformSource?: string;
  agentId?: string;
  agentType?: string;
  tool_use_id?: string;
}

export interface SummarizeInput {
  contentSessionId: string;
}

export interface SearchInput {
  query: string;
  project: string;
  limit?: number;
}

export interface ClaudeMemClient {
  baseUrl: string;
  health: () => Promise<boolean>;
  initSession: (input: InitSessionInput) => Promise<unknown>;
  recordObservation: (input: RecordObservationInput) => Promise<unknown>;
  summarize: (input: SummarizeInput) => Promise<unknown>;
  search: (input: SearchInput) => Promise<unknown>;
}

function resolveClaudeMemUrl(): string {
  if (process.env.CLAUDE_MEM_WORKER_URL) return process.env.CLAUDE_MEM_WORKER_URL;
  try {
    const settings = JSON.parse(
      readFileSync(`${homedir()}/.claude-mem/settings.json`, "utf-8")
    ) as Record<string, unknown>;
    const port = settings.CLAUDE_MEM_WORKER_PORT;
    const host = (settings.CLAUDE_MEM_WORKER_HOST as string | undefined) ?? "127.0.0.1";
    if (port !== undefined && port !== null && String(port).length > 0) {
      return `http://${host}:${port}`;
    }
  } catch {
    /* fall through to default */
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `http://127.0.0.1:${37700 + (uid % 100)}`;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no-body>");
    throw new Error(`POST ${url} -> ${res.status} ${res.statusText}: ${text}`);
  }
  // 204/empty bodies are fine
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "<no-body>");
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}: ${text}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

export function createClaudeMemClient(baseUrlOverride?: string): ClaudeMemClient {
  const baseUrl = (baseUrlOverride ?? resolveClaudeMemUrl()).replace(/\/+$/, "");

  return {
    baseUrl,

    async health(): Promise<boolean> {
      try {
        const res = await fetch(`${baseUrl}/health`);
        return res.ok;
      } catch (err) {
        console.warn(`[claude-mem] health probe failed at ${baseUrl}: ${String(err)}`);
        return false;
      }
    },

    async initSession(input: InitSessionInput): Promise<unknown> {
      return postJson(`${baseUrl}/api/sessions/init`, input);
    },

    async recordObservation(input: RecordObservationInput): Promise<unknown> {
      return postJson(`${baseUrl}/api/sessions/observations`, input);
    },

    async summarize(input: SummarizeInput): Promise<unknown> {
      return postJson(`${baseUrl}/api/sessions/summarize`, input);
    },

    async search(input: SearchInput): Promise<unknown> {
      const params = new URLSearchParams({
        query: input.query,
        project: input.project,
      });
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      return getJson(`${baseUrl}/api/search?${params.toString()}`);
    },
  };
}
