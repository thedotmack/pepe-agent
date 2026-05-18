/**
 * Phase 2 verification: signAndSend uses the Jupiter canonical
 * confirm-with-rebroadcast pattern instead of fetching a fresh blockhash
 * after send.
 *
 * Coverage:
 *   - success → status "ok"
 *   - confirmTransaction resolves with value.err set → "failed_onchain"
 *   - confirmTransaction stays unresolved past timeout and signature has
 *     never landed → "not_landed"
 *   - confirmTransaction rejects (BlockheightExceededError-like) but
 *     getSignatureStatus shows the tx landed → "landed_after_timeout"
 *   - rebroadcast loop fires at least once while confirmation is slow
 *
 * No real RPC, no real Jupiter, no real timers wall-clocked: we shrink
 * REBROADCAST_INTERVAL_MS and CONFIRM_TIMEOUT_MS by overriding via the
 * module's exported constants — but since they're module-internal `const`,
 * we instead drive timing by making the fake operations resolve fast and
 * relying on the loop body's `await sleep(REBROADCAST_INTERVAL_MS)` to
 * yield at least once.
 *
 * Run: `bun test src/trade/jupiter-confirm.test.ts` from `worker/`.
 */
import { describe, it, expect, beforeAll, mock } from "bun:test";

process.env.AGENT_SHARED_SECRET = "test-shared-secret-32-chars-min-x";
process.env.SOLANA_NETWORK = "devnet";

mock.module("./wallet.ts", () => {
  const PUB = "11111111111111111111111111111111";
  return {
    getKeypair: () => ({ _fake: true }),
    getPublicKey: () => PUB,
    tryGetPublicKey: () => PUB,
    walletAvailable: () => true,
  };
});

// Buy path doesn't need spl-token; stub it to keep the import graph happy.
// getMint is included so position-monitor-math.test.ts (which runs in the
// same `bun test` invocation) finds its symbol on the shared spl-token mock.
mock.module("@solana/spl-token", () => ({
  getAssociatedTokenAddressSync: (mint: unknown) => mint,
  getAccount: async () => ({ amount: 10_000_000_000n }),
  TokenAccountNotFoundError: class extends Error {},
  getMint: async () => ({ decimals: 6 }),
}));

const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_MINT = "BuyMintZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

const fakeBlockhash = "Fake1111111111111111111111111111111111111111";

class FakeVersionedTransaction {
  // signAndSend reads tx.message.recentBlockhash for the confirmation
  // strategy — must be the blockhash signed into the tx.
  message = { recentBlockhash: fakeBlockhash };
  static deserialize(_buf: Uint8Array) {
    return new FakeVersionedTransaction();
  }
  sign(_keys: unknown[]) {}
  serialize() {
    return new Uint8Array([1, 2, 3]);
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

// Per-test overridable RPC behaviour. The Connection class is recreated for
// each executeTrade call, so we route everything through this shared
// behaviour object.
interface FakeRpcBehaviour {
  sendRawTransactionCalls: number;
  confirmResult: () => Promise<{ value: { err: unknown } }>;
  signatureStatusResult: () => Promise<{
    value: {
      err: unknown;
      confirmationStatus?: string;
      slot?: number;
    } | null;
  }>;
}

const rpc: FakeRpcBehaviour = {
  sendRawTransactionCalls: 0,
  confirmResult: async () => ({ value: { err: null } }),
  signatureStatusResult: async () => ({
    value: { err: null, confirmationStatus: "confirmed", slot: 1 },
  }),
};

class FakeConnection {
  constructor(_url: string, _commitment?: string) {}
  async sendRawTransaction() {
    rpc.sendRawTransactionCalls += 1;
    return "fake-txid-confirm";
  }
  async confirmTransaction() {
    return rpc.confirmResult();
  }
  async getSignatureStatus() {
    return rpc.signatureStatusResult();
  }
  async getAccount() {
    return { amount: 10_000_000_000n };
  }
  async getLatestBlockhash() {
    // Phase 2 guard: signAndSend MUST NOT call this. We throw loudly so the
    // test fails red if anyone re-introduces a post-send blockhash fetch.
    throw new Error(
      "Phase 2 invariant violated: getLatestBlockhash() called after send",
    );
  }
}

mock.module("@solana/web3.js", () => ({
  Connection: FakeConnection,
  PublicKey: FakePublicKey,
  VersionedTransaction: FakeVersionedTransaction,
  LAMPORTS_PER_SOL: 1_000_000_000,
}));

// Phase 12 (codex Phase 11 re-audit blocker #2b): quote fixture is now
// overridable so the new route-liquidity tests can drive empty-route /
// high-impact responses through executeTrade without touching the others.
interface QuoteFixture {
  routePlan: unknown[];
  priceImpactPct: string;
}
const quoteFixture: QuoteFixture = {
  routePlan: [{ swapInfo: { ammKey: "FakeRaydium" } }],
  priceImpactPct: "0.001",
};

beforeAll(() => {
  globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/quote")) {
      return new Response(
        JSON.stringify({
          inputMint: SOL_MINT,
          outputMint: TOKEN_MINT,
          inAmount: "100000000",
          outAmount: "500000000",
          otherAmountThreshold: "490000000",
          swapMode: "ExactIn",
          slippageBps: 100,
          // Phase 12 (codex Phase 11 re-audit blocker #2b): executeTrade now
          // runs checkRouteLiquidity on the authoritative /quote response
          // before /swap. Non-empty route + tiny price impact matches the
          // gate so the rest of the test exercises signAndSend. Tests that
          // need to drive the route_liquidity_denied path override the
          // fixture inline.
          priceImpactPct: quoteFixture.priceImpactPct,
          routePlan: quoteFixture.routePlan,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/swap")) {
      return new Response(
        JSON.stringify({
          swapTransaction: Buffer.from("fake-tx").toString("base64"),
          // Phase 2: this is the blockheight the strategy uses for expiry —
          // signAndSend must take it from /swap, NOT a fresh
          // getLatestBlockhash() call.
          lastValidBlockHeight: 1_000_000,
          prioritizationFeeLamports: 5000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as typeof fetch;
});

function resetQuoteFixture() {
  quoteFixture.routePlan = [{ swapInfo: { ammKey: "FakeRaydium" } }];
  quoteFixture.priceImpactPct = "0.001";
}

// Import AFTER mocks register. Phase 7 H2: pull the rebroadcast/timeout
// constants in too so the rebroadcast-fires test drives timing off the
// canonical values rather than a hard-coded 2_100ms sleep.
const { executeTrade, REBROADCAST_INTERVAL_MS, CONFIRM_TIMEOUT_MS } = await import("./jupiter.ts");

function resetRpc() {
  rpc.sendRawTransactionCalls = 0;
  rpc.confirmResult = async () => ({ value: { err: null } });
  rpc.signatureStatusResult = async () => ({
    value: { err: null, confirmationStatus: "confirmed", slot: 1 },
  });
  // Phase 12: also reset the /quote fixture so the new route-liquidity tests
  // can mutate it without leaking state across `it()` blocks.
  resetQuoteFixture();
}

describe("signAndSend confirmation paths (Phase 2)", () => {
  it("returns status=ok when confirmTransaction succeeds and never calls getLatestBlockhash after send", async () => {
    resetRpc();
    const result = await executeTrade({
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      amountSol: 0.1,
      slippageBps: 100,
      decimals: 6,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.txid).toBe("fake-txid-confirm");
    }
    // If anyone reintroduces getLatestBlockhash after send the FakeConnection
    // would have thrown — the assertion above wouldn't be reached. This
    // expectation is documentary.
    expect(rpc.sendRawTransactionCalls).toBeGreaterThanOrEqual(1);
  });

  it("returns failed_onchain when confirmTransaction resolves with value.err set", async () => {
    resetRpc();
    const slippageErr = { SlippageToleranceExceeded: "0x1771" };
    rpc.confirmResult = async () => ({ value: { err: slippageErr } });
    // Make status reconciliation also match the on-chain failure for realism.
    rpc.signatureStatusResult = async () => ({
      value: { err: slippageErr, confirmationStatus: "confirmed", slot: 2 },
    });

    const result = await executeTrade({
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      amountSol: 0.1,
      slippageBps: 100,
      decimals: 6,
    });
    expect(result.status).toBe("failed_onchain");
    if (result.status === "failed_onchain") {
      expect(result.txid).toBe("fake-txid-confirm");
      expect(result.err).toEqual(slippageErr);
    }
  });

  it("returns not_landed when confirmTransaction times out and signature was never seen", async () => {
    resetRpc();
    // confirmTransaction never resolves — promise hangs. Timeout will fire
    // after CONFIRM_TIMEOUT_MS in real code; in test we accept the ~90s
    // wall-clock cost is too high, so we instead reject quickly with a
    // BlockheightExceeded-like error to take the rejection branch. The
    // not_landed path is then driven by getSignatureStatus returning null.
    rpc.confirmResult = async () => {
      throw new Error("BlockheightExceededError: tx expired");
    };
    rpc.signatureStatusResult = async () => ({ value: null });

    const result = await executeTrade({
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      amountSol: 0.1,
      slippageBps: 100,
      decimals: 6,
    });
    expect(result.status).toBe("not_landed");
    if (result.status === "not_landed") {
      expect(result.txid).toBe("fake-txid-confirm");
    }
  });

  it("returns landed_after_timeout when confirm rejects but the signature is on-chain with err=null", async () => {
    resetRpc();
    rpc.confirmResult = async () => {
      throw new Error("BlockheightExceededError: tx expired");
    };
    rpc.signatureStatusResult = async () => ({
      value: { err: null, confirmationStatus: "finalized", slot: 42 },
    });

    const result = await executeTrade({
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      amountSol: 0.1,
      slippageBps: 100,
      decimals: 6,
    });
    expect(result.status).toBe("landed_after_timeout");
    if (result.status === "landed_after_timeout") {
      expect(result.txid).toBe("fake-txid-confirm");
      expect(result.value.err).toBeNull();
      expect(result.value.confirmationStatus).toBe("finalized");
    }
  });

  it("Phase 11 P11-L1.C3: pre-send aborted externalSignal returns not_landed with no broadcast", async () => {
    // Phase 10 (codex re-audit #5) added a pre-send guard that short-circuits
    // signAndSend if externalSignal aborted BEFORE the initial
    // sendRawTransaction. Without this guard, a /kill that tripped between
    // policy approval and signAndSend entry would still leak one final tx
    // onto the network. Pre-send abort returns txid=null with reason set.
    //
    // This test pins that behavior: pass an already-aborted AbortSignal as
    // externalSignal to executeTrade. Expect:
    //   - result.status === "not_landed"
    //   - result.txid === null (never broadcast)
    //   - sendRawTransactionCalls === 0 (the FakeConnection counter never
    //     incremented — proves we didn't even reach the send path)
    resetRpc();
    const controller = new AbortController();
    controller.abort(); // pre-abort before executeTrade fires

    const result = await executeTrade({
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      amountSol: 0.1,
      slippageBps: 100,
      decimals: 6,
      externalSignal: controller.signal,
    });

    expect(result.status).toBe("not_landed");
    if (result.status === "not_landed") {
      // The CRITICAL assertion: txid must be null on the pre-send abort
      // path. A real txid here would mean we broadcast even though /kill
      // had tripped — the exact scenario the Phase 10 guard prevents.
      expect(result.txid).toBeNull();
      // Reason is "aborted before send" per Phase 10 design.
      expect(result.reason).toMatch(/aborted before send/i);
    }
    // No tx ever broadcast — the counter is the load-bearing assertion.
    expect(rpc.sendRawTransactionCalls).toBe(0);
  });

  it("fires the rebroadcast loop at least once while confirmation is slow", async () => {
    resetRpc();
    // Phase 7 H2: hold confirmation just past one rebroadcast interval (so
    // the loop body's `await sleep(REBROADCAST_INTERVAL_MS)` yields once),
    // then resolve. Driving timing off the exported constant means the
    // test self-adjusts if the production interval ever changes — no
    // dangling 2_100 magic number to drift.
    const holdMs = REBROADCAST_INTERVAL_MS + 100;
    rpc.confirmResult = async () => {
      await new Promise((r) => setTimeout(r, holdMs));
      return { value: { err: null } };
    };

    const result = await executeTrade({
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      amountSol: 0.1,
      slippageBps: 100,
      decimals: 6,
    });
    expect(result.status).toBe("ok");
    // Initial send + at least one rebroadcast.
    expect(rpc.sendRawTransactionCalls).toBeGreaterThanOrEqual(2);
    // The constants are exported (not test-mocked), so the loop genuinely
    // waited ~REBROADCAST_INTERVAL_MS before its first re-send. Document
    // that here so the wall-clock cost isn't a mystery to future readers.
    expect(REBROADCAST_INTERVAL_MS).toBeGreaterThan(0);
    expect(CONFIRM_TIMEOUT_MS).toBeGreaterThan(REBROADCAST_INTERVAL_MS);
  }, 10_000);
});
