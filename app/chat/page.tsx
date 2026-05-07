"use client";

import { CopilotKit } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";

export default function ChatPage() {
  return (
    <CopilotKit
      agent="pepe_openai"
      runtimeUrl="/api/copilotkit"
      enableInspector={false}
      showDevConsole={false}
    >
      <main className="h-[100dvh] w-screen overflow-hidden bg-[#07090f] text-white">
        <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-4 py-4 md:px-6 md:py-6">
          <header className="flex shrink-0 items-center justify-between border-b border-white/10 pb-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.22em] text-cyan-200/60">
                Pepe HQ
              </p>
              <h1 className="mt-1 text-xl font-semibold text-white md:text-2xl">
                OpenAI-compatible chat
              </h1>
            </div>
            <a
              href="/director"
              className="rounded-sm border border-cyan-200/25 px-3 py-2 text-xs font-medium uppercase tracking-[0.14em] text-cyan-100 hover:border-cyan-200/55"
            >
              Director
            </a>
          </header>

          <section className="min-h-0 flex-1 py-4">
            <CopilotChat
              className="h-full rounded-sm border border-white/10 bg-[#0b111a]"
              labels={{
                title: "Pepe Agent",
                initial:
                  "Ask about Pepe Agent, director mode, contributor setup, or the next feature.",
                placeholder: "Ask Pepe Agent...",
              }}
              instructions="You are Pepe HQ chat. Be concise, practical, and useful. Help contributors run and extend the open-source Pepe Agent project."
            />
          </section>
        </div>
      </main>
    </CopilotKit>
  );
}
