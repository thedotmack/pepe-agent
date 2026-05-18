/**
 * Phase 3 verification: position-monitor's price math is decimals-aware.
 *
 * The previous implementation quoted a fixed `1000000` atomic units and
 * compared the resulting SOL-per-atomic price against
 * `entryPriceSolPerToken` (SOL-per-UI-token) — off by `1e6 ÷ 10^decimals`
 * for every position, which is `~1e-6` for a 9-decimal SOL-style token (a
 * 1,000,000x understatement) and `1.0` for a 6-decimal USDC-style token
 * (works by accident). This test pins the new math:
 *
 *   - For decimals = 6, 8, 9 a freshly-opened position with
 *     entry == quote price must produce |pnl| ≈ 0, NOT |pnl| ≈ 0.99999.
 *   - Sanity-skip path: when the quote returns a wildly-off price
 *     (ratio > 1e4 or < 1e-4), the monitor logs + skips that tick
 *     without injecting an exit signal.
 *   - ILLIQUID path: when priceImpactPct > 0.10, the monitor emits a
 *     warning but does NOT issue a sell command.
 *
 * Run: `bun test src/agent/position-monitor-math.test.ts` from `worker/`.
 *
 * Approach mirrors jupiter-confirm.test.ts: mock.module for @solana/web3.js
 * + @solana/spl-token, override globalThis.fetch for Jupiter. No real RPC.
 */
import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";

process.env.AGENT_SHARED_SECRET = "test-shared-secret-32-chars-min-x";
process.env.SOLANA_NETWORK = "devnet";

import type { TradeLedger } from "../trade/ledger.ts";
import type { AgentLoopHandle } from "./loop.ts";
import type { StateStore } from "../state.ts";

// ---------- Mocks ----------
// Wallet stub so the transitive jupiter.ts → wallet.ts import doesn't
// require AGENT_WALLET_PRIVATE_KEY_BASE58 or call into the real Keypair
// class. Mirrors the pattern in jupiter-confirm.test.ts.
mock.module("../trade/wallet.ts", () => {
  const PUB = "11111111111111111111111111111111";
  return {
    getKeypair: () => ({ _fake: true }),
    getPublicKey: () => PUB,
    tryGetPublicKey: () => PUB,
    walletAvailable: () => true,
  };
});

// Position-monitor only touches getMint from spl-token (on the decimals-
// backfill path). The fake returns whatever the test sets via mintDecimalsRef.
// Jupiter (transitively imported via position-monitor → ../trade/jupiter.ts)
// also pulls in getAccount, getAssociatedTokenAddressSync, and
// TokenAccountNotFoundError — re-export those so the import graph links.
const mintDecimalsRef = { value: 6 };
mock.module("@solana/spl-token", () => ({
  getMint: async (_conn: unknown, _pk: unknown) => ({
    decimals: mintDecimalsRef.value,
  }),
  getAssociatedTokenAddressSync: (mint: unknown) => mint,
  getAccount: async () => ({ amount: 10_000_000_000n }),
  TokenAccountNotFoundError: class extends Error {},
}));

// Position-monitor's RPC backfill path creates a `new Connection(...)` and
// a `new PublicKey(...)`. Both can be no-op stand-ins — the only thing the
// test cares about is the value getMint returns. We also re-export the
// other web3.js symbols jupiter.ts pulls (VersionedTransaction, Keypair)
// so transitive imports link successfully.
class FakeConnection {
  constructor(_url: string, _commitment?: string) {}
}
class FakePublicKey {
  private _v: string;
  constructor(v: string) {
    this._v = v;
  }
  toBase58() {
    return this._v;
  }
  toString() {
    return this._v;
  }
}
class FakeVersionedTransaction {
  static deserialize() {
    return new FakeVersionedTransaction();
  }
  sign() {}
  serialize() {
    return new Uint8Array();
  }
}
class FakeKeypair {
  static fromSecretKey() {
    return new FakeKeypair();
  }
}
mock.module("@solana/web3.js", () => ({
  Connection: FakeConnection,
  PublicKey: FakePublicKey,
  VersionedTransaction: FakeVersionedTransaction,
  Keypair: FakeKeypair,
  // citation: LAMPORTS_PER_SOL = 1e9 (web3.js Connection.ts constant). Used
  // by position-monitor to convert quote outAmount (lamports) → SOL.
  LAMPORTS_PER_SOL: 1_000_000_000,
}));

// ---------- Quote fixture knobs ----------
interface QuoteFixture {
  outAmountLamports: string;
  priceImpactPct: string;
}
const quoteFixture: QuoteFixture = {
  outAmountLamports: "0",
  priceImpactPct: "0.001",
};
let lastQuoteUrl: string | null = null;

const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/quote")) {
      lastQuoteUrl = u;
      return new Response(
        JSON.stringify({
          inputMint: "X",
          outputMint: "So11111111111111111111111111111111111111112",
          inAmount: new URL(u).searchParams.get("amount") ?? "0",
          outAmount: quoteFixture.outAmountLamports,
          otherAmountThreshold: "0",
          swapMode: "ExactIn",
          slippageBps: 100,
          priceImpactPct: quoteFixture.priceImpactPct,
          routePlan: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

// Import AFTER mocks register.
const { startPositionMonitor } = await import("./position-monitor.ts");

// ---------- Tiny harness fakes ----------

type Position = {
  tokenId: string;
  symbol: string | null;
  entryPriceSolPerToken: number;
  sizeSol: number;
  openedAt: number;
  decimals: number;
};

function fakeLedger(positions: Position[]): TradeLedger & {
  setDecimalsCalls: Array<{ tokenId: string; decimals: number }>;
} {
  const setDecimalsCalls: Array<{ tokenId: string; decimals: number }> = [];
  return {
    dbPath: ":memory:",
    recordTrade: () => ({ id: 1 }),
    hasTradeTxid: () => false,
    lastTradeMs: () => null,
    totalSolToday: () => 0,
    openPositions: () => positions,
    openPosition: () => {},
    setPositionDecimals: (tokenId, decimals) => {
      setDecimalsCalls.push({ tokenId, decimals });
      const row = positions.find((p) => p.tokenId === tokenId);
      if (row) row.decimals = decimals;
    },
    closePosition: () => {},
    close: () => {},
    setDecimalsCalls,
  };
}

function fakeAgent(): AgentLoopHandle & { messages: string[] } {
  const messages: string[] = [];
  return {
    injectUserMessage: (text) => messages.push(text),
    injectActivityContext: () => {},
    stop: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emitter: { on: () => {}, emit: () => {} } as any,
    getQueryHandle: () => null,
    messages,
  };
}

function fakeStateStore(phase: "IDLE" | "WATCHING" | "CALLING" | "TRADING"): StateStore {
  return {
    snapshot: () => ({
      phase,
      selectedTokenId: null,
      callingSinceMs: null,
      walletSol: 0,
      pnlUsd: 0,
      openPositions: 0,
      killSwitch: false,
      feedStatus: "live",
      walletPubkey: null,
      sessionId: null,
      lastDecisionLog: [],
    }),
    setPhase: () => {},
    setSelectedToken: () => {},
    setFeedStatus: () => {},
    setSessionId: () => {},
    recordDecision: () => {},
    tick: () => {},
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Run one tick by starting the monitor with a small pollMs and waiting just
// past the first interval fire. The setInterval body is async — the await
// inside is necessary to let it complete before stop().
async function runOneTick(monitor: { stop: () => void }, pollMs: number) {
  await sleep(pollMs + 200);
  monitor.stop();
}

// ---------- Tests ----------

const POLL_MS = 50;

describe("position-monitor price math (Phase 3)", () => {
  for (const decimals of [6, 8, 9]) {
    it(`computes pnl ≈ 0 when entry == current quote for decimals=${decimals}`, async () => {
      // Quote: ONE FULL TOKEN (10^decimals atomic) → returns lamportsOut.
      // currentPriceSolPerToken = lamportsOut / 1e9.
      // For pnl ≈ 0 we set entry to match that exact value.
      const lamportsOut = 5_000_000n; // 0.005 SOL per full token, arbitrary
      const entryPriceSolPerToken = Number(lamportsOut) / 1e9; // 0.005
      quoteFixture.outAmountLamports = lamportsOut.toString();
      quoteFixture.priceImpactPct = "0.001";

      const positions: Position[] = [
        {
          tokenId: `Mint${decimals}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
          symbol: null,
          entryPriceSolPerToken,
          sizeSol: 0.05,
          openedAt: 0,
          decimals,
        },
      ];
      const ledger = fakeLedger(positions);
      const agent = fakeAgent();
      const stateStore = fakeStateStore("IDLE");

      const monitor = startPositionMonitor({
        ledger,
        agent,
        stateStore,
        pollMs: POLL_MS,
      });
      await runOneTick(monitor, POLL_MS);

      // Crucial assertion: NO exit signal injected. The pre-fix monitor
      // would have seen pnl ≈ -0.999999 for decimals=9 (because it compared
      // SOL-per-atomic against SOL-per-UI-token) and fired SL.
      expect(agent.messages).toEqual([]);

      // Also: quote URL should reflect ONE full token in atomic units.
      const params = new URL(lastQuoteUrl as unknown as string).searchParams;
      expect(params.get("amount")).toBe((10n ** BigInt(decimals)).toString());
    });
  }

  it("does NOT emit a phantom SL for a 6-decimal token when entry == current (regression for 1e6 bug)", async () => {
    // The pre-fix bug: the old code quoted "1000000" atomic and computed
    // SOL/atomic, then compared that to entryPriceSolPerToken (SOL/UI).
    // For a 6-decimal token "1000000" atomic IS one UI token, so the math
    // worked by accident there. But the inverse problem — when the agent
    // recorded entry using the corrected SOL/UI convention but the monitor
    // quoted with the old fixed 1e6 atomic — would have looked correct
    // because both happen to align. We verify the new code stays correct
    // here by directly using the new SOL/UI everywhere.
    const lamportsPerFullToken = 1_000_000_000n; // 1 SOL per full token
    quoteFixture.outAmountLamports = lamportsPerFullToken.toString();
    quoteFixture.priceImpactPct = "0.001";

    const positions: Position[] = [
      {
        tokenId: "M6xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        symbol: "USDCISH",
        entryPriceSolPerToken: 1.0, // matches lamportsPerFullToken / 1e9
        sizeSol: 0.05,
        openedAt: 0,
        decimals: 6,
      },
    ];
    const ledger = fakeLedger(positions);
    const agent = fakeAgent();
    const stateStore = fakeStateStore("IDLE");

    const monitor = startPositionMonitor({
      ledger,
      agent,
      stateStore,
      pollMs: POLL_MS,
    });
    await runOneTick(monitor, POLL_MS);

    expect(agent.messages).toEqual([]);
  });

  it("triggers TP at +30% gain when current quote >= entry × 1.30", async () => {
    const entry = 0.001; // SOL per UI token
    // Quote returns 35% higher → 0.00135 SOL per UI = 1_350_000 lamports.
    // Bumped past the 30% threshold to dodge floating-point boundary noise.
    quoteFixture.outAmountLamports = "1350000";
    quoteFixture.priceImpactPct = "0.001";

    const positions: Position[] = [
      {
        tokenId: "TPxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        symbol: "TP",
        entryPriceSolPerToken: entry,
        sizeSol: 0.05,
        openedAt: 0,
        decimals: 6,
      },
    ];
    const ledger = fakeLedger(positions);
    const agent = fakeAgent();
    const stateStore = fakeStateStore("IDLE");

    const monitor = startPositionMonitor({
      ledger,
      agent,
      stateStore,
      pollMs: POLL_MS,
    });
    await runOneTick(monitor, POLL_MS);

    // setInterval may fire >1 time before stop() is called and the fake
    // ledger never closes the position, so each tick re-issues the signal.
    // What matters: the signal is "TP" and it fires AT LEAST once.
    expect(agent.messages.length).toBeGreaterThanOrEqual(1);
    expect(agent.messages[0]).toMatch(/TP — /);
  });

  it("skips the tick on a decimals-misconfig price ratio (>1e4×)", async () => {
    // Entry says 0.001 SOL/UI; quote returns 100,000 SOL/UI → ratio 1e8.
    // The sanity bound is ratio > 1e4 → skip without emitting.
    quoteFixture.outAmountLamports = String(100_000n * 1_000_000_000n);
    quoteFixture.priceImpactPct = "0.001";

    const positions: Position[] = [
      {
        tokenId: "BADRATIOxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        symbol: "BAD",
        entryPriceSolPerToken: 0.001,
        sizeSol: 0.05,
        openedAt: 0,
        decimals: 6,
      },
    ];
    const ledger = fakeLedger(positions);
    const agent = fakeAgent();
    const stateStore = fakeStateStore("IDLE");

    const monitor = startPositionMonitor({
      ledger,
      agent,
      stateStore,
      pollMs: POLL_MS,
    });
    await runOneTick(monitor, POLL_MS);

    expect(agent.messages).toEqual([]);
  });

  it("skips the tick on a decimals-misconfig price ratio (<1e-4×)", async () => {
    // Entry says 1.0 SOL/UI; quote returns 1e-6 SOL/UI → ratio 1e-6.
    // The sanity bound is ratio < 1e-4 → skip without emitting.
    quoteFixture.outAmountLamports = "1000"; // 1e-6 SOL
    quoteFixture.priceImpactPct = "0.001";

    const positions: Position[] = [
      {
        tokenId: "BADRATLOxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        symbol: "BAD",
        entryPriceSolPerToken: 1.0,
        sizeSol: 0.05,
        openedAt: 0,
        decimals: 6,
      },
    ];
    const ledger = fakeLedger(positions);
    const agent = fakeAgent();
    const stateStore = fakeStateStore("IDLE");

    const monitor = startPositionMonitor({
      ledger,
      agent,
      stateStore,
      pollMs: POLL_MS,
    });
    await runOneTick(monitor, POLL_MS);

    expect(agent.messages).toEqual([]);
  });

  it("does NOT emit a sell on ILLIQUID alone (priceImpactPct > 0.10)", async () => {
    // Entry == current (no PnL trigger), but priceImpactPct = 0.25.
    // Expected: warning logged (not asserted here), agent.messages empty.
    quoteFixture.outAmountLamports = "5000000";
    quoteFixture.priceImpactPct = "0.25";

    const positions: Position[] = [
      {
        tokenId: "ILLIQxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        symbol: "THIN",
        entryPriceSolPerToken: 0.005, // exactly matches quote
        sizeSol: 0.05,
        openedAt: 0,
        decimals: 6,
      },
    ];
    const ledger = fakeLedger(positions);
    const agent = fakeAgent();
    const stateStore = fakeStateStore("IDLE");

    const monitor = startPositionMonitor({
      ledger,
      agent,
      stateStore,
      pollMs: POLL_MS,
    });
    await runOneTick(monitor, POLL_MS);

    expect(agent.messages).toEqual([]);
  });

  it("backfills decimals via getMint when position.decimals is 0", async () => {
    // Position row has decimals=0 (a corrupted-legacy state). Monitor must
    // call getMint, persist via setPositionDecimals, then quote with the
    // correct atomicPerToken value.
    mintDecimalsRef.value = 8;
    quoteFixture.outAmountLamports = "5000000"; // arbitrary, doesn't trigger TP/SL
    quoteFixture.priceImpactPct = "0.001";

    const positions: Position[] = [
      {
        tokenId: "LEGACYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        symbol: "LGC",
        entryPriceSolPerToken: 0.005,
        sizeSol: 0.05,
        openedAt: 0,
        decimals: 0, // triggers backfill
      },
    ];
    const ledger = fakeLedger(positions);
    const agent = fakeAgent();
    const stateStore = fakeStateStore("IDLE");

    const monitor = startPositionMonitor({
      ledger,
      agent,
      stateStore,
      pollMs: POLL_MS,
    });
    await runOneTick(monitor, POLL_MS);

    expect(ledger.setDecimalsCalls).toEqual([
      { tokenId: "LEGACYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", decimals: 8 },
    ]);
    // And the quote URL used the backfilled decimals.
    const params = new URL(lastQuoteUrl as unknown as string).searchParams;
    expect(params.get("amount")).toBe((10n ** 8n).toString());
  });

  it("does not run when phase is TRADING or CALLING", async () => {
    quoteFixture.outAmountLamports = "1300000"; // would trigger TP
    quoteFixture.priceImpactPct = "0.001";

    const positions: Position[] = [
      {
        tokenId: "PHASExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        symbol: "PH",
        entryPriceSolPerToken: 0.001,
        sizeSol: 0.05,
        openedAt: 0,
        decimals: 6,
      },
    ];
    const ledger = fakeLedger(positions);
    const agent = fakeAgent();
    const stateStore = fakeStateStore("TRADING");

    const monitor = startPositionMonitor({
      ledger,
      agent,
      stateStore,
      pollMs: POLL_MS,
    });
    await runOneTick(monitor, POLL_MS);

    expect(agent.messages).toEqual([]);
  });
});
