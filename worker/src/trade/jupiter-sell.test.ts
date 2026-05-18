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

let getAccountBehaviour: "found" | "missing" = "found";
let lastQuoteUrl: string | null = null;
let lastSwapBody: unknown = null;

mock.module("@solana/spl-token", () => ({
  getAssociatedTokenAddressSync: (mint: unknown, _owner: unknown) => mint,
  getAccount: async () => {
    if (getAccountBehaviour === "missing") {
      throw new FakeTokenAccountNotFoundError();
    }
    return { amount: 10_000_000_000n };
  },
  TokenAccountNotFoundError: FakeTokenAccountNotFoundError,
}));

// Stub the web3.js Connection so executeTrade's `new Connection(...)` returns
// our fake. We don't care about RPC URL — just intercept the methods that
// jupiter.ts calls during the sell happy path: signAndSend(connection) calls
// sendRawTransaction + getLatestBlockhash + confirmTransaction.
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
          routePlan: [],
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
    });
    expect(result.status).toBe("no_token_account");
    if (result.status === "no_token_account") {
      expect(result.reason).toMatch(/no ATA/);
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
      }),
    ).rejects.toThrow(/SOL↔TOKEN/);
  });
});
