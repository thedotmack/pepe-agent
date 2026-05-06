/**
 * Jupiter Swap API integration (Phase 4 — devnet first).
 *
 * Endpoints per https://dev.jup.ag/docs/swap-api/quick-start :
 *   GET  https://lite-api.jup.ag/swap/v1/quote
 *   POST https://lite-api.jup.ag/swap/v1/swap
 *
 * Lite tier is the public free tier (no API key). Pro / Ultra would swap to
 * a different base — refuse to add a switch until we need it.
 *
 * Sign + send is fully local — never on the client. The keypair only ever
 * lives in `wallet.ts:cached`.
 *
 * NOTE: We deliberately do NOT add retry logic. Single-shot, fail loud, let
 * the agent decide whether to retry (plan Phase 4 anti-pattern).
 */
import {
  Connection,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "../config.ts";
import { getKeypair, getPublicKey } from "./wallet.ts";

const JUP_BASE = "https://lite-api.jup.ag/swap/v1";
const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  // additional opaque fields preserved on the full response
  [k: string]: unknown;
}

function resolveMint(mint: string): string {
  return mint === "SOL" ? SOL_MINT : mint;
}

function defaultRpcUrl(): string {
  if (config.SOLANA_RPC_URL) return config.SOLANA_RPC_URL;
  if (config.SOLANA_NETWORK === "devnet") return "https://api.devnet.solana.com";
  if (config.SOLANA_NETWORK === "testnet") return "https://api.testnet.solana.com";
  // mainnet-beta requires an explicit RPC URL — public mainnet RPC is rate-
  // limited and unsuitable for a trading agent.
  throw new Error(
    `SOLANA_RPC_URL is required when SOLANA_NETWORK=${config.SOLANA_NETWORK}`
  );
}

export async function getQuote(args: {
  inputMint: string;
  outputMint: string;
  amount: string; // lamports for SOL, atomic units for SPL
  slippageBps: number;
}): Promise<QuoteResponse> {
  const params = new URLSearchParams({
    inputMint: resolveMint(args.inputMint),
    outputMint: resolveMint(args.outputMint),
    amount: args.amount,
    slippageBps: String(args.slippageBps),
  });
  const url = `${JUP_BASE}/quote?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "<no-body>");
    throw new Error(`Jupiter quote ${res.status}: ${text}`);
  }
  return (await res.json()) as QuoteResponse;
}

export async function submitSwap(args: {
  quote: QuoteResponse;
  userPublicKey: string;
}): Promise<{ swapTransaction: string }> {
  const url = `${JUP_BASE}/swap`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: args.quote,
      userPublicKey: args.userPublicKey,
      wrapAndUnwrapSol: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no-body>");
    throw new Error(`Jupiter swap ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { swapTransaction?: string };
  if (!json.swapTransaction) {
    throw new Error("Jupiter swap response missing swapTransaction");
  }
  return { swapTransaction: json.swapTransaction };
}

export async function signAndSend(
  swapTransactionBase64: string,
  connection: Connection
): Promise<{ txid: string }> {
  const keypair = getKeypair();
  const buf = Buffer.from(swapTransactionBase64, "base64");
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([keypair]);
  const raw = tx.serialize();
  const txid = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 0,
  });
  // confirmTransaction on web3.js@1 accepts either a sig string (deprecated)
  // or a `BlockheightBasedTransactionConfirmationStrategy`. Fetch a fresh
  // blockhash for the strategy form so we don't get the deprecated-overload
  // type error.
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    {
      signature: txid,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );
  return { txid };
}

/**
 * High-level orchestrator: quote → swap → sign → send → confirm.
 * Used by the `submit_trade` tool handler.
 *
 * `executedPriceSolPerToken` is the SOL-side ratio if the trade is
 * SOL→TOKEN; otherwise null. We do NOT fetch token decimals here — Phase 4
 * verification doesn't need it.
 */
export async function executeTrade(args: {
  inputMint: string;
  outputMint: string;
  amountSol: number;
  slippageBps: number;
}): Promise<{ txid: string; executedPriceSolPerToken: number | null; quote: QuoteResponse }> {
  const inputMint = resolveMint(args.inputMint);
  const outputMint = resolveMint(args.outputMint);

  // Convert SOL → lamports if buying with SOL. For SELL paths the caller is
  // expected to pass an already-atomic amount via a different code path —
  // Phase 4 only wires the BUY happy path. SELL gets wired in Phase 5.
  if (inputMint !== SOL_MINT) {
    throw new Error(
      "executeTrade currently only supports SOL→TOKEN; SELL path lands in Phase 5"
    );
  }
  const amountLamports = BigInt(Math.round(args.amountSol * 1e9)).toString();

  const rpcUrl = defaultRpcUrl();
  const connection = new Connection(rpcUrl, "confirmed");
  const userPublicKey = getPublicKey();

  const quote = await getQuote({
    inputMint,
    outputMint,
    amount: amountLamports,
    slippageBps: args.slippageBps,
  });

  const { swapTransaction } = await submitSwap({ quote, userPublicKey });
  const { txid } = await signAndSend(swapTransaction, connection);

  // SOL/token ratio — we know inAmount is in lamports (1e9 / SOL).
  // outAmount is in atomic units of the output token (decimals unknown).
  // The "SOL-side" ratio = SOL / atomic-token. Useful only for relative
  // comparison across same-token trades. Null if we can't parse.
  const inLamports = Number(quote.inAmount);
  const outAtomic = Number(quote.outAmount);
  const executedPriceSolPerToken =
    Number.isFinite(inLamports) && Number.isFinite(outAtomic) && outAtomic > 0
      ? inLamports / 1e9 / outAtomic
      : null;

  return { txid, executedPriceSolPerToken, quote };
}
