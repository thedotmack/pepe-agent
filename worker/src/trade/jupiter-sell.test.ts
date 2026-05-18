/**
 * Phase 1 verification: executeTrade now handles TOKEN→SOL (SELL).
 *
 * The previous implementation hard-threw with "Phase 5" when `inputMint !==
 * SOL_MINT`. This file proves the throw is gone, the SELL branch builds an
 * atomic-units quote, and the missing-ATA case returns a structured failure
 * instead of throwing.
 *
 * No real RPC, no real Jupiter. fetch + Connection + spl-token are mocked.
 *
 * Run: `bun test src/trade/jupiter-sell.test.ts` from `worker/`.
 */
import { describe, it, expect, beforeAll, mock } from "bun:test";

// config.ts parses process.env at boot — set required vars BEFORE the
// transitive import chain pulls config in. (policy.test.ts dodges this with
// type-only imports; this file actually needs jupiter.ts at runtime.)
process.env.AGENT_SHARED_SECRET = "test-shared-secret-32-chars-min-x";
process.env.SOLANA_NETWORK = "devnet";

// Stub the wallet module so we don't need a real base58 secret key. Has to
// happen before the import of jupiter.ts below.
mock.module("./wallet.ts", () => {
  const PUB = "11111111111111111111111111111111";
  // FakeVersionedTransaction.sign() ignores the keypair entirely, so a sentinel
  // object satisfies the call site without leaking a real secret key.
  const fakeKeypair = { _fake: true } as unknown;
  return {
    getKeypair: () => fakeKeypair,
    getPublicKey: () => PUB,
    tryGetPublicKey: () => PUB,
    walletAvailable: () => true,
  };
});

// Stub the SOL→SPL helpers. getAssociatedTokenAddressSync is sync so we just
// return a deterministic PublicKey. getAccount returns a balance large enough
// to satisfy the requested sellAmountAtomic. TokenAccountNotFoundError is
// re-exported so the production code's instanceof check still works for the
// "missing ATA" test.
class FakeTokenAccountNotFoundError extends Error {
  constructor(msg = "TokenAccountNotFound") {
    super(msg);
    this.name = "TokenAccountNotFoundError";
  }
}

let getAccountBehaviour: "found" | "missing" | "low_balance" | "timeout" = "found";
let lowBalanceAmount: bigint = 0n;
let lastQuoteUrl: string | null = null;
let lastSwapBody: unknown = null;

mock.module("@solana/spl-token", () => ({
  getAssociatedTokenAddressSync: (mint: unknown, _owner: unknown) => mint,
  getAccount: async () => {
    if (getAccountBehaviour === "missing") {
      throw new FakeTokenAccountNotFoundError();
    }
    if (getAccountBehaviour === "low_balance") {
      // Phase 7 H1: ATA exists but holds less than the test's requested
      // sellAmountAtomic. Used to drive the insufficient_token_balance path.
      return { amount: lowBalanceAmount };
    }
    if (getAccountBehaviour === "timeout") {
      // Phase 14 P14-T1 (codex Phase 13 re-audit re-test of P13-C2): simulate
      // the SELL preflight getAccount hitting the withSolanaTimeout reject
      // branch. Error shape matches what withSolanaTimeout produces in
      // production ("<label> timeout after Nms"). executeTrade catches this
      // via the /timeout after \d+ms/ regex and falls through to
      // no_token_account with a timeout-flavored reason string.
      throw new Error(
        "SELL preflight getAccount(MintInputXXXXXXX...) timeout after 10000ms",
      );
    }
    return { amount: 10_000_000_000n };
  },
  TokenAccountNotFoundError: FakeTokenAccountNotFoundError,
  // getMint is included so position-monitor-math.test.ts finds its symbol
  // on the shared spl-token mock when both files run in one bun test run.
  getMint: async () => ({ decimals: 6 }),
}));

// Stub the web3.js Connection so executeTrade's `new Connection(...)` returns
// our fake. We don't care about RPC URL — just intercept the methods that
// jupiter.ts calls during the sell happy path: signAndSend(connection) calls
// sendRawTransaction + confirmTransaction + getSignatureStatus.
const fakeBlockhash = {
  blockhash: "Fake1111111111111111111111111111111111111111",
  lastValidBlockHeight: 1_000_000,
};
class FakeConnection {
  constructor(_url: string, _commitment?: string) {}
  async sendRawTransaction() {
    return "fake-txid-9999";
  }
  async getLatestBlockhash() {
    return fakeBlockhash;
  }
  async confirmTransaction() {
    return { value: { err: null } };
  }
  async getSignatureStatus() {
    return {
      value: { err: null, confirmationStatus: "confirmed", slot: 1 },
    };
  }
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
  equals(other: { _v: string }) {
    return this._v === other._v;
  }
}
class FakeVersionedTransaction {
  // signAndSend reads `tx.message.recentBlockhash` to drive
  // confirmTransaction — expose the same shape on the fake.
  message = { recentBlockhash: fakeBlockhash.blockhash };
  static deserialize(_buf: Uint8Array) {
    return new FakeVersionedTransaction();
  }
  sign(_keys: unknown[]) {}
  serialize() {
    return new Uint8Array([1, 2, 3]);
  }
}
mock.module("@solana/web3.js", () => ({
  Connection: FakeConnection,
  PublicKey: FakePublicKey,
  VersionedTransaction: FakeVersionedTransaction,
  LAMPORTS_PER_SOL: 1_000_000_000,
}));

// Mock fetch for Jupiter quote + swap.
const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/quote")) {
      lastQuoteUrl = u;
      return new Response(
        JSON.stringify({
          inputMint: "MintInputXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          outputMint: "So11111111111111111111111111111111111111112",
          inAmount: "1000",
          outAmount: "5000",
          otherAmountThreshold: "4900",
          swapMode: "ExactIn",
          slippageBps: 100,
          priceImpactPct: "0.001",
          // Phase 12 (codex Phase 11 re-audit blocker #2b): executeTrade now
          // runs checkRouteLiquidity on the /quote response before /swap.
          // Non-empty route + tiny price impact matches the gate so SELL
          // tests can still exercise the rest of the flow (ATA read,
          // submitSwap, signAndSend, etc.).
          routePlan: [{ swapInfo: { ammKey: "FakeRaydium" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/swap")) {
      lastSwapBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({
          swapTransaction: Buffer.from("fake-tx").toString("base64"),
          lastValidBlockHeight: 1_000_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as typeof fetch;
});

// Import AFTER mocks are registered.
const { executeTrade } = await import("./jupiter.ts");

const TOKEN_MINT = "MintInputXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const SOL_MINT = "So11111111111111111111111111111111111111112";

describe("executeTrade (SELL / TOKEN→SOL)", () => {
  it("no longer throws the Phase 5 BUY-only error", async () => {
    getAccountBehaviour = "found";
    const result = await executeTrade({
      inputMint: TOKEN_MINT,
      outputMint: SOL_MINT,
      sellAmountAtomic: 1000n,
      slippageBps: 100,
      decimals: 6,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.txid).toBe("fake-txid-9999");
      expect(result.quote.inAmount).toBe("1000");
    }
  });

  it("passes raw atomic amount to /quote, not a UI float", async () => {
    getAccountBehaviour = "found";
    lastQuoteUrl = null;
    await executeTrade({
      inputMint: TOKEN_MINT,
      outputMint: SOL_MINT,
      sellAmountAtomic: 123_456_789n,
      slippageBps: 50,
      decimals: 6,
    });
    expect(lastQuoteUrl).not.toBeNull();
    const params = new URL(lastQuoteUrl as unknown as string).searchParams;
    expect(params.get("amount")).toBe("123456789");
    expect(params.get("inputMint")).toBe(TOKEN_MINT);
    expect(params.get("outputMint")).toBe(SOL_MINT);
  });

  it("uses wrapAndUnwrapSol: true (Jupiter handles WSOL → native unwrap)", async () => {
    getAccountBehaviour = "found";
    lastSwapBody = null;
    await executeTrade({
      inputMint: TOKEN_MINT,
      outputMint: SOL_MINT,
      sellAmountAtomic: 1000n,
      slippageBps: 100,
      decimals: 6,
    });
    expect(lastSwapBody).not.toBeNull();
    expect((lastSwapBody as { wrapAndUnwrapSol: boolean }).wrapAndUnwrapSol).toBe(true);
  });

  it("returns no_token_account (not throw) when ATA is missing", async () => {
    getAccountBehaviour = "missing";
    const result = await executeTrade({
      inputMint: TOKEN_MINT,
      outputMint: SOL_MINT,
      sellAmountAtomic: 1000n,
      slippageBps: 100,
      decimals: 6,
    });
    expect(result.status).toBe("no_token_account");
    if (result.status === "no_token_account") {
      expect(result.reason).toMatch(/no ATA/);
    }
  });

  it("Phase 14 P14-T1 (P13-C2): SELL preflight getAccount timeout → no_token_account with timeout reason", async () => {
    // Phase 13 P13-C2 wrapped the SELL preflight getAccount with a 10s
    // timeout (withSolanaTimeout, formerly withSellPreflightTimeout). The
    // timeout falls through to the existing no_token_account variant with
    // a reason string that includes "timeout" — distinguishing "RPC
    // stalled, retry next turn" from "user has never opened a position
    // here". This test pins that contract: when getAccount rejects with a
    // timeout-shaped error, executeTrade must return no_token_account
    // (not throw), and the reason MUST include "timeout" so /phase-events
    // postmortem can tell the two failure modes apart.
    getAccountBehaviour = "timeout";

    const result = await executeTrade({
      inputMint: TOKEN_MINT,
      outputMint: SOL_MINT,
      sellAmountAtomic: 1000n,
      slippageBps: 100,
      decimals: 6,
    });

    // Reuse of the no_token_account variant minimizes churn — the handler
    // already treats it as retryable, so the agent retries on its next
    // turn when RPC recovers. The reason string differentiates timeout
    // from genuinely-missing ATA.
    expect(result.status).toBe("no_token_account");
    if (result.status === "no_token_account") {
      expect(result.reason).toMatch(/timeout/i);
      expect(result.reason).toMatch(/10000ms/);
    }
  });

  it("returns insufficient_token_balance (distinct variant) when ATA exists but holds less than requested", async () => {
    // Phase 7 H1: distinguish ATA-missing (no_token_account) from
    // ATA-exists-but-low (insufficient_token_balance). The variant carries
    // the exact bigints so the handler can narrate the failure precisely.
    getAccountBehaviour = "low_balance";
    lowBalanceAmount = 500n;
    const result = await executeTrade({
      inputMint: TOKEN_MINT,
      outputMint: SOL_MINT,
      sellAmountAtomic: 1000n,
      slippageBps: 100,
      decimals: 6,
    });
    expect(result.status).toBe("insufficient_token_balance");
    if (result.status === "insufficient_token_balance") {
      expect(result.requested).toBe(1000n);
      expect(result.available).toBe(500n);
      expect(result.reason).toMatch(/500.*1000/);
    }
  });

  it("rejects calls that mix amountSol + sellAmountAtomic", async () => {
    getAccountBehaviour = "found";
    await expect(
      executeTrade({
        inputMint: TOKEN_MINT,
        outputMint: SOL_MINT,
        sellAmountAtomic: 1000n,
        amountSol: 0.1,
        slippageBps: 100,
        decimals: 6,
      }),
    ).rejects.toThrow(/SELL rejects amountSol/);
  });

  it("rejects TOKEN→TOKEN (not SOL on either side)", async () => {
    await expect(
      executeTrade({
        inputMint: TOKEN_MINT,
        outputMint: "OtherMintYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY",
        sellAmountAtomic: 1000n,
        slippageBps: 100,
        decimals: 6,
      }),
    ).rejects.toThrow(/SOL↔TOKEN/);
  });
});

describe("executeTrade decimals precision boundary (Phase 7 H6)", () => {
  // `10 ** args.decimals` uses Number — safe up to ~2^53 ≈ 9.007e15.
  // Every real Solana mint stays ≤ decimals=9; these tests document the
  // theoretical safety margin for token-2022 mints that might use higher
  // decimals. If decimals=16 ever shows up in production, the comment in
  // jupiter.ts:tokenAtomicPerUi calls for a BigInt rewrite.

  it("decimals=15: 10^15 is still exactly representable as a Number", () => {
    // 10^15 = 1_000_000_000_000_000 < 2^53 - 1 = 9_007_199_254_740_991.
    const v = 10 ** 15;
    expect(Number.isSafeInteger(v)).toBe(true);
    expect(v).toBe(1_000_000_000_000_000);
  });

  it("decimals=16: 10^16 exceeds Number.MAX_SAFE_INTEGER (documented limit)", () => {
    // 10^16 = 10_000_000_000_000_000 > 2^53 - 1.
    const v = 10 ** 16;
    expect(Number.isSafeInteger(v)).toBe(false);
    // Number is still _representable_ (no Infinity) but math beyond this
    // accumulates rounding. The jupiter.ts comment documents this and
    // calls for BigInt fallback if a real decimals≥16 token shows up.
    expect(Number.isFinite(v)).toBe(true);
  });
});
