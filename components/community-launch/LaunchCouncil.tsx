"use client";

import { FormEvent, useMemo, useState } from "react";
import type { ActivityToken } from "@/lib/activity/activity-websocket";
import type { AgentStatus } from "@/lib/agent";
import type { FeedStatus } from "@/lib/dot-matrix/render-board";
import { buildLaunchIntentUrl, normalizeTicker } from "@/lib/bags/launch-intent";

type CouncilVote = "ship" | "hold" | "rename";

type CommunityMessage = {
  id: string;
  author: string;
  text: string;
  tone: "pepe" | "member" | "system";
};

type LaunchProposal = {
  name: string;
  ticker: string;
  description: string;
  website: string;
  twitter: string;
  image: string;
  initialBuy: string;
};

type LaunchCouncilProps = {
  agentStatus: AgentStatus;
  feedStatus: FeedStatus;
  selectedToken?: ActivityToken;
  onAskPepe: (prompt: string) => void;
};

const DEFAULT_PROPOSAL: LaunchProposal = {
  name: "Pepe HQ Daily",
  ticker: "PHQD",
  description:
    "A community-launched daily token coordinated by Pepe HQ. Launch intent generated for human review on Bags.",
  website: "https://github.com/thedotmack/pepe-agent",
  twitter: "https://x.com/Claude_Memory",
  image: "",
  initialBuy: "100",
};

const START_MESSAGES: CommunityMessage[] = [
  {
    id: "m-1",
    author: "Pepe",
    tone: "pepe",
    text: "I can turn the room vibe into a Bags launch draft. I still need human review before launch.",
  },
  {
    id: "m-2",
    author: "Alex",
    tone: "member",
    text: "Daily token window, community chat, and fee share for the crew.",
  },
  {
    id: "m-3",
    author: "System",
    tone: "system",
    text: "Launch intent mode is client-side. No private keys in the browser.",
  },
];

function statusCopy(status: AgentStatus): string {
  switch (status) {
    case "connecting":
      return "Pepe connecting";
    case "listening":
      return "Pepe listening";
    case "speaking":
      return "Pepe speaking";
    case "idle":
    default:
      return "Pepe idle";
  }
}

function votePercent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

function feeShareTotal(): string {
  return "50% @Claude_Memory";
}

export function LaunchCouncil({
  agentStatus,
  feedStatus,
  selectedToken,
  onAskPepe,
}: LaunchCouncilProps) {
  const [proposal, setProposal] = useState<LaunchProposal>(DEFAULT_PROPOSAL);
  const [messages, setMessages] = useState<CommunityMessage[]>(START_MESSAGES);
  const [messageDraft, setMessageDraft] = useState("");
  const [vote, setVote] = useState<CouncilVote | null>(null);

  const voteCounts = useMemo(() => {
    const base = { ship: 37, hold: 8, rename: 5 };
    if (vote) base[vote] += 1;
    return base;
  }, [vote]);

  const totalVotes = voteCounts.ship + voteCounts.hold + voteCounts.rename;
  const shipPercent = votePercent(voteCounts.ship, totalVotes);
  const quorumPercent = Math.min(100, votePercent(totalVotes, 60));

  const launchIntentUrl = useMemo(
    () =>
      buildLaunchIntentUrl({
        name: proposal.name,
        ticker: proposal.ticker,
        description: proposal.description,
        website: proposal.website,
        twitter: proposal.twitter,
        image: proposal.image,
        initialBuy: proposal.initialBuy,
        feeMode: "DEFAULT",
        feeShareEnabled: true,
        feeShareType: "multi",
        feeShare: [
          {
            allocationBps: 5000,
            platform: "twitter",
            username: "Claude_Memory",
          },
        ],
        showSocial: true,
      }),
    [proposal],
  );

  const addCommunityMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = messageDraft.trim();
    if (!text) return;
    setMessages((current) => [
      ...current.slice(-5),
      {
        id: `m-${Date.now()}`,
        author: "You",
        tone: "member",
        text,
      },
    ]);
    setMessageDraft("");
  };

  const seedFromTape = () => {
    const token = selectedToken;
    if (!token) return;
    const symbol = normalizeTicker(token.symbol ?? token.name ?? "HQ");
    setProposal((current) => ({
      ...current,
      name: `${symbol || "Pepe"} Signal Club`.slice(0, 32),
      ticker: `${symbol || "PEPE"}HQ`.slice(0, 10),
      description: `Community launch inspired by the live Pepe HQ tape: ${symbol || "a token"} is showing ${Math.round(
        (token.fiveMinGain ?? 0) * 100,
      )}% five-minute momentum with ${Math.round((token.buyPressure5m ?? 0) * 100)}% buy pressure.`,
    }));
  };

  const askPepe = () => {
    onAskPepe(
      `Review this community Bags launch proposal. Name: ${proposal.name}. Ticker: ${proposal.ticker}. Description: ${proposal.description}. Vote: ${shipPercent}% ship, quorum ${quorumPercent}%. Tell us whether to ship, hold, or rename.`,
    );
  };

  return (
    <aside className="launch-council flex h-full min-h-0 w-full flex-col overflow-hidden border border-cyan-300/25 bg-[#06111d]/92 text-cyan-50 shadow-[0_0_40px_rgba(65,235,224,0.12)] backdrop-blur md:max-w-[420px]">
      <header className="border-b border-cyan-300/20 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.22em] text-cyan-200/70">
              Pepe HQ
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-[0.02em] text-white">
              Launch Council
            </h1>
          </div>
          <div className="grid gap-1 text-right text-[10px] uppercase tracking-[0.14em] text-cyan-100/70">
            <span>{statusCopy(agentStatus)}</span>
            <span>Feed {feedStatus}</span>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <section className="border border-cyan-300/18 bg-black/20 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-200/60">
                Daily Launch Window
              </p>
              <p className="mt-1 text-sm text-white">Community draft, vote, Bags review</p>
            </div>
            <span className="border border-cyan-200/30 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100">
              {quorumPercent}% quorum
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px] uppercase tracking-[0.1em]">
            <button
              type="button"
              onClick={() => setVote("ship")}
              className={`border px-2 py-2 ${
                vote === "ship"
                  ? "border-cyan-200 bg-cyan-300/18 text-white"
                  : "border-cyan-300/20 bg-cyan-950/20 text-cyan-100/80"
              }`}
            >
              Ship {voteCounts.ship}
            </button>
            <button
              type="button"
              onClick={() => setVote("hold")}
              className={`border px-2 py-2 ${
                vote === "hold"
                  ? "border-amber-200 bg-amber-300/15 text-white"
                  : "border-cyan-300/20 bg-cyan-950/20 text-cyan-100/80"
              }`}
            >
              Hold {voteCounts.hold}
            </button>
            <button
              type="button"
              onClick={() => setVote("rename")}
              className={`border px-2 py-2 ${
                vote === "rename"
                  ? "border-blue-200 bg-blue-300/15 text-white"
                  : "border-cyan-300/20 bg-cyan-950/20 text-cyan-100/80"
              }`}
            >
              Rename {voteCounts.rename}
            </button>
          </div>
          <div className="mt-3 h-2 bg-cyan-950/60">
            <div className="h-full bg-cyan-200" style={{ width: `${shipPercent}%` }} />
          </div>
          <p className="mt-2 text-[11px] text-cyan-100/65">
            Ship score {shipPercent}%. Fee share preview: {feeShareTotal()}.
          </p>
        </section>

        <section className="border border-cyan-300/18 bg-black/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-cyan-100">
              Token Draft
            </h2>
            <button
              type="button"
              onClick={seedFromTape}
              disabled={!selectedToken}
              className="border border-cyan-300/20 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-cyan-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Seed from tape
            </button>
          </div>
          <div className="mt-3 grid gap-2">
            <label className="grid gap-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/60">
              Name
              <input
                value={proposal.name}
                maxLength={32}
                onChange={(event) =>
                  setProposal((current) => ({ ...current, name: event.target.value }))
                }
                className="border border-cyan-300/20 bg-[#04101a] px-2 py-2 text-sm normal-case tracking-normal text-white outline-none focus:border-cyan-200"
              />
            </label>
            <label className="grid gap-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/60">
              Ticker
              <input
                value={proposal.ticker}
                maxLength={10}
                onChange={(event) =>
                  setProposal((current) => ({
                    ...current,
                    ticker: normalizeTicker(event.target.value),
                  }))
                }
                className="border border-cyan-300/20 bg-[#04101a] px-2 py-2 text-sm tracking-[0.08em] text-white outline-none focus:border-cyan-200"
              />
            </label>
            <label className="grid gap-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/60">
              Description
              <textarea
                value={proposal.description}
                rows={3}
                onChange={(event) =>
                  setProposal((current) => ({ ...current, description: event.target.value }))
                }
                className="resize-none border border-cyan-300/20 bg-[#04101a] px-2 py-2 text-sm normal-case tracking-normal text-white outline-none focus:border-cyan-200"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/60">
                Initial Buy USD
                <input
                  value={proposal.initialBuy}
                  inputMode="numeric"
                  onChange={(event) =>
                    setProposal((current) => ({
                      ...current,
                      initialBuy: event.target.value.replace(/[^\d.]/g, ""),
                    }))
                  }
                  className="border border-cyan-300/20 bg-[#04101a] px-2 py-2 text-sm text-white outline-none focus:border-cyan-200"
                />
              </label>
              <label className="grid gap-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/60">
                Image URL
                <input
                  value={proposal.image}
                  placeholder="optional"
                  onChange={(event) =>
                    setProposal((current) => ({ ...current, image: event.target.value }))
                  }
                  className="border border-cyan-300/20 bg-[#04101a] px-2 py-2 text-sm normal-case tracking-normal text-white outline-none placeholder:text-cyan-100/30 focus:border-cyan-200"
                />
              </label>
            </div>
          </div>
        </section>

        <section className="border border-cyan-300/18 bg-black/20 p-3">
          <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-cyan-100">
            Community Chat
          </h2>
          <div className="mt-3 grid gap-2">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`border px-2 py-2 ${
                  message.tone === "pepe"
                    ? "border-cyan-300/28 bg-cyan-300/10"
                    : message.tone === "system"
                      ? "border-blue-300/20 bg-blue-300/10"
                      : "border-cyan-300/14 bg-cyan-950/14"
                }`}
              >
                <p className="text-[10px] uppercase tracking-[0.14em] text-cyan-100/55">
                  {message.author}
                </p>
                <p className="mt-1 text-sm leading-snug text-cyan-50/88">{message.text}</p>
              </div>
            ))}
          </div>
          <form onSubmit={addCommunityMessage} className="mt-3 flex gap-2">
            <input
              value={messageDraft}
              onChange={(event) => setMessageDraft(event.target.value)}
              placeholder="vibe check, name idea, launch rule..."
              className="min-w-0 flex-1 border border-cyan-300/20 bg-[#04101a] px-2 py-2 text-sm text-white outline-none placeholder:text-cyan-100/30 focus:border-cyan-200"
            />
            <button
              type="submit"
              className="border border-cyan-200/40 px-3 py-2 text-[11px] uppercase tracking-[0.12em] text-cyan-50"
            >
              Send
            </button>
          </form>
        </section>
      </div>

      <footer className="grid gap-2 border-t border-cyan-300/20 p-3">
        <button
          type="button"
          onClick={askPepe}
          className="border border-cyan-200/40 bg-cyan-300/12 px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-white"
        >
          Ask Pepe to judge
        </button>
        <a
          href={launchIntentUrl}
          target="_blank"
          rel="noreferrer"
          className="border border-amber-200/50 bg-amber-300/12 px-3 py-2 text-center text-[11px] uppercase tracking-[0.14em] text-amber-50"
        >
          Review on Bags
        </a>
        <p className="text-[10px] leading-snug text-cyan-100/50">
          Bags opens with fields prefilled. Wallet signing and final launch stay on Bags.
        </p>
      </footer>
    </aside>
  );
}
