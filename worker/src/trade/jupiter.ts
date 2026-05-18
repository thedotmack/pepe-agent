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
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
// spl-token signatures sourced from @solana/spl-token@0.4 d.ts (no skill present).
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
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

export function defaultRpcUrl(): string {
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

export type ExecuteTradeArgs = {
  inputMint: string;
  outputMint: string;
  slippageBps: number;
  /** SOL→TOKEN: amount of SOL to spend (UI units). Mutually exclusive with sellAmountAtomic. */
  amountSol?: number;
  /** TOKEN→SOL: amount of input token to sell, in raw atomic units. Mutually exclusive with amountSol. */
  sellAmountAtomic?: bigint;
};

export type ExecuteTradeResult =
  | {
      status: "ok";
      txid: string;
      executedPriceSolPerToken: number | null;
      quote: QuoteResponse;
    }
  | {
      status: "no_token_account";
      reason: string;
    };

/**
 * High-level orchestrator: quote → swap → sign → send → confirm.
 * Used by the `submit_trade` tool handler.
 *
 * Supports both BUY (SOL→TOKEN) and SELL (TOKEN→SOL). For SELL the caller
 * passes `sellAmountAtomic` (raw atomic uint64 of the input token); we verify
 * the on-chain ATA exists and holds enough before quoting. Jupiter's
 * `wrapAndUnwrapSol: true` automatically unwraps WSOL output back to native
 * SOL — we do not create a close-account instruction ourselves.
 *
 * `executedPriceSolPerToken` is reported as SOL-per-atomic-token (matching
 * the existing ledger convention). Caller can decimals-correct downstream.
 */
export async function executeTrade(
  args: ExecuteTradeArgs,
): Promise<ExecuteTradeResult> {
  const inputMint = resolveMint(args.inputMint);
  const outputMint = resolveMint(args.outputMint);
  const isSell = inputMint !== SOL_MINT && outputMint === SOL_MINT;
  const isBuy = inputMint === SOL_MINT && outputMint !== SOL_MINT;

  if (!isSell && !isBuy) {
    throw new Error(
      `executeTrade only supports SOL↔TOKEN; got inputMint=${inputMint} outputMint=${outputMint}`,
    );
  }

  let amountAtomic: string;
  if (isBuy) {
    if (args.amountSol === undefined) {
      throw new Error("BUY (SOL→TOKEN) requires amountSol");
    }
    if (args.sellAmountAtomic !== undefined) {
      throw new Error("BUY rejects sellAmountAtomic; pass amountSol only");
    }
    amountAtomic = BigInt(Math.round(args.amountSol * 1e9)).toString();
  } else {
    // isSell
    if (args.sellAmountAtomic === undefined) {
      throw new Error("SELL (TOKEN→SOL) requires sellAmountAtomic");
    }
    if (args.amountSol !== undefined) {
      throw new Error("SELL rejects amountSol; pass sellAmountAtomic only");
    }
    if (args.sellAmountAtomic <= 0n) {
      throw new Error("sellAmountAtomic must be > 0");
    }
    amountAtomic = args.sellAmountAtomic.toString();
  }

  const rpcUrl = defaultRpcUrl();
  const connection = new Connection(rpcUrl, "confirmed");
  const userPublicKey = getPublicKey();

  if (isSell) {
    const ownerPk = new PublicKey(userPublicKey);
    const mintPk = new PublicKey(inputMint);
    const ata = getAssociatedTokenAddressSync(mintPk, ownerPk);
    try {
      const acct = await getAccount(connection, ata);
      if (acct.amount < args.sellAmountAtomic!) {
        return {
          status: "no_token_account",
          reason: `ATA holds ${acct.amount.toString()} < requested ${args.sellAmountAtomic!.toString()}`,
        };
      }
    } catch (err) {
      // Token-2022 mints would throw TokenInvalidAccountOwnerError here — flag
      // up to caller rather than silently retry with wrong program id.
      if (err instanceof TokenAccountNotFoundError) {
        return {
          status: "no_token_account",
          reason: `no ATA for mint ${inputMint} under owner ${userPublicKey}`,
        };
      }
      throw err;
    }
  }

  const quote = await getQuote({
    inputMint,
    outputMint,
    amount: amountAtomic,
    slippageBps: args.slippageBps,
  });

  const { swapTransaction } = await submitSwap({ quote, userPublicKey });
  const { txid } = await signAndSend(swapTransaction, connection);

  // For BUY: inAmount = lamports spent, outAmount = atomic tokens received →
  //   SOL per atomic-token = inLamports/1e9 / outAtomic.
  // For SELL: inAmount = atomic tokens sold, outAmount = lamports received →
  //   SOL per atomic-token = outLamports/1e9 / inAtomic.
  const inAmt = Number(quote.inAmount);
  const outAmt = Number(quote.outAmount);
  let executedPriceSolPerToken: number | null = null;
  if (Number.isFinite(inAmt) && Number.isFinite(outAmt) && inAmt > 0 && outAmt > 0) {
    executedPriceSolPerToken = isBuy
      ? inAmt / 1e9 / outAmt
      : outAmt / 1e9 / inAmt;
  }

  return { status: "ok", txid, executedPriceSolPerToken, quote };
}
