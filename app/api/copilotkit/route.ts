import { HttpAgent } from "@ag-ui/client";
import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const agUiUrl =
    process.env.AG_UI_OPENAI_AGENT_URL?.trim() ||
    new URL("/api/ag-ui/openai", req.url).toString();

  const runtime = new CopilotRuntime({
    agents: {
      pepe_openai: new HttpAgent({ url: agUiUrl }),
    },
  });

  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: "/api/copilotkit",
  });

  return handleRequest(req);
}
