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
  type SignatureStatus,
} from "@solana/web3.js";
// spl-token signatures sourced from @solana/spl-token@0.4 d.ts (no skill present).
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import { getKeypair, getPublicKey } from "./wallet.ts";

const log = createLogger("trade.jupiter");

/** How long to race confirmTransaction before giving up and polling status. */
const CONFIRM_TIMEOUT_MS = 90_000;
/** Interval between rebroadcasts of the signed tx while waiting for confirm. */
const REBROADCAST_INTERVAL_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

export interface SubmitSwapResult {
  swapTransaction: string;
  /** Block height at which the tx Jupiter signed becomes invalid. Used as
   * the expiry signal for the post-send confirmation loop — DO NOT replace
   * with a fresh getLatestBlockhash() call. */
  lastValidBlockHeight: number;
  /** Telemetry only — Jupiter's selected priority fee in lamports. */
  prioritizationFeeLamports?: number;
}

export async function submitSwap(args: {
  quote: QuoteResponse;
  userPublicKey: string;
}): Promise<SubmitSwapResult> {
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
  const json = (await res.json()) as {
    swapTransaction?: string;
    lastValidBlockHeight?: number;
    prioritizationFeeLamports?: number;
  };
  if (!json.swapTransaction) {
    throw new Error("Jupiter swap response missing swapTransaction");
  }
  if (typeof json.lastValidBlockHeight !== "number") {
    throw new Error("Jupiter swap response missing lastValidBlockHeight");
  }
  return {
    swapTransaction: json.swapTransaction,
    lastValidBlockHeight: json.lastValidBlockHeight,
    prioritizationFeeLamports: json.prioritizationFeeLamports,
  };
}

/** Outcome of a sign-and-send attempt, after the rebroadcast/confirm dance. */
export type SignAndSendResult =
  | { status: "ok"; txid: string }
  | { status: "failed_onchain"; txid: string; err: unknown }
  | { status: "not_landed"; txid: string }
  | { status: "landed_after_timeout"; txid: string; value: SignatureStatus };

// citation: pattern adapted from Jupiter station-app reference
// `transactionSender.ts` — confirm against the blockhash that was signed
// into the tx (recoverable from tx.message.recentBlockhash), and use
// `lastValidBlockHeight` from the /swap response. Rebroadcast in a loop
// instead of relying on RPC maxRetries.
export async function signAndSend(
  swapTransactionBase64: string,
  connection: Connection,
  lastValidBlockHeight: number,
): Promise<SignAndSendResult> {
  const keypair = getKeypair();
  const buf = Buffer.from(swapTransactionBase64, "base64");
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([keypair]);
  const raw = tx.serialize();
  // The blockhash the tx was signed against — required by the confirmation
  // strategy. NEVER fetch a fresh one here, that defeats the expiry mechanism.
  const blockhash = tx.message.recentBlockhash;

  const txid = await connection.sendRawTransaction(raw, {
    skipPreflight: true,
    maxRetries: 0,
  });

  const abortController = new AbortController();
  const confirmPromise = connection.confirmTransaction(
    {
      signature: txid,
      blockhash,
      lastValidBlockHeight,
      abortSignal: abortController.signal,
    },
    "confirmed",
  );

  // Background rebroadcast loop — keeps the tx in the leader's mempool while
  // we wait for confirmation. Errors are swallowed; confirmation drives the
  // outcome. Returns when the abort signal fires.
  const rebroadcastPromise = (async () => {
    while (!abortController.signal.aborted) {
      await sleep(REBROADCAST_INTERVAL_MS);
      if (abortController.signal.aborted) return;
      try {
        await connection.sendRawTransaction(raw, {
          skipPreflight: true,
          maxRetries: 0,
        });
      } catch {
        // swallow — confirmation drives outcome
      }
    }
  })();

  // Race confirm against a hard timeout so a stuck blockhash-expiry RPC
  // never wedges the agent. The timeout case falls through to a final
  // getSignatureStatus poll.
  const TIMEOUT_SENTINEL = Symbol("confirm-timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), CONFIRM_TIMEOUT_MS);
  });

  let confirmOutcome:
    | { kind: "resolved"; value: Awaited<typeof confirmPromise> }
    | { kind: "rejected"; err: unknown }
    | { kind: "timeout" };
  try {
    const winner = await Promise.race([
      confirmPromise.then(
        (value) => ({ kind: "resolved" as const, value }),
        (err) => ({ kind: "rejected" as const, err }),
      ),
      timeoutPromise,
    ]);
    confirmOutcome =
      winner === TIMEOUT_SENTINEL ? { kind: "timeout" } : winner;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    abortController.abort();
    // Surface unexpected errors from the rebroadcast loop but don't block.
    rebroadcastPromise.catch((err) => {
      log.warn(`rebroadcast loop errored: ${String(err)}`);
    });
  }

  if (confirmOutcome.kind === "resolved") {
    const value = confirmOutcome.value?.value;
    if (value?.err) {
      log.warn(`tx ${txid} failed on-chain: ${JSON.stringify(value.err)}`);
      return { status: "failed_onchain", txid, err: value.err };
    }
    // Sanity reconciliation — confirmTransaction said success, double-check
    // via getSignatureStatus. A null status here is surprising but not
    // fatal; log and accept the confirm verdict.
    try {
      const status = await connection.getSignatureStatus(txid, {
        searchTransactionHistory: true,
      });
      if (!status.value || !status.value.confirmationStatus) {
        log.warn(
          `tx ${txid} confirmed but getSignatureStatus returned ${JSON.stringify(status.value)}`,
        );
      }
    } catch (err) {
      log.warn(`getSignatureStatus reconciliation failed for ${txid}: ${String(err)}`);
    }
    return { status: "ok", txid };
  }

  // Either confirmTransaction rejected (commonly BlockheightExceededError)
  // or our hard timeout fired. In both cases we poll on-chain reality once
  // more before declaring the trade lost.
  if (confirmOutcome.kind === "rejected") {
    log.warn(
      `confirmTransaction rejected for ${txid}: ${String(confirmOutcome.err)}; polling status`,
    );
  } else {
    log.warn(`confirmTransaction timeout for ${txid} after ${CONFIRM_TIMEOUT_MS}ms; polling status`);
  }
  let finalStatus: Awaited<ReturnType<Connection["getSignatureStatus"]>>;
  try {
    finalStatus = await connection.getSignatureStatus(txid, {
      searchTransactionHistory: true,
    });
  } catch (err) {
    log.error(`getSignatureStatus poll failed for ${txid}: ${String(err)}`);
    return { status: "not_landed", txid };
  }
  const value = finalStatus.value;
  if (!value) {
    return { status: "not_landed", txid };
  }
  if (value.err) {
    return { status: "failed_onchain", txid, err: value.err };
  }
  // Landed late — caller decides whether to record. Keep the full
  // SignatureStatus on the result so downstream can read confirmationStatus.
  return { status: "landed_after_timeout", txid, value };
}

export type ExecuteTradeArgs = {
  inputMint: string;
  outputMint: string;
  slippageBps: number;
  /** SOL→TOKEN: amount of SOL to spend (UI units). Mutually exclusive with sellAmountAtomic. */
  amountSol?: number;
  /** TOKEN→SOL: amount of input token to sell, in raw atomic units. Mutually exclusive with amountSol. */
  sellAmountAtomic?: bigint;
  /** Decimals of the non-SOL token in the pair. Required so executedPriceSolPerToken
   *  is reported in SOL-per-UI-token (matching position-monitor's price units). */
  decimals: number;
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
    }
  | {
      status: "failed_onchain";
      txid: string;
      err: unknown;
    }
  | {
      status: "not_landed";
      txid: string;
    }
  | {
      status: "landed_after_timeout";
      txid: string;
      value: SignatureStatus;
      executedPriceSolPerToken: number | null;
      quote: QuoteResponse;
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
 * `executedPriceSolPerToken` is reported as SOL-per-UI-token (Phase 3): the
 * caller passes the non-SOL mint's decimals so we can divide atomic amounts
 * down to full-token units before computing the price ratio. This matches
 * the units used by position-monitor's `entryPriceSolPerToken` so PnL math
 * is consistent across the ledger.
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

  const { swapTransaction, lastValidBlockHeight } = await submitSwap({
    quote,
    userPublicKey,
  });
  const sendResult = await signAndSend(swapTransaction, connection, lastValidBlockHeight);

  // SOL per UI-token (Phase 3): divide lamports → SOL (÷ 1e9) and divide
  // atomic-token amounts → UI tokens (÷ 10^decimals) before taking the ratio.
  // This matches position-monitor's `entryPriceSolPerToken` units so PnL
  // math is unit-consistent across the ledger.
  //   BUY:  inAmount = lamports spent,    outAmount = atomic tokens received
  //   SELL: inAmount = atomic tokens sold, outAmount = lamports received
  const inAmt = Number(quote.inAmount);
  const outAmt = Number(quote.outAmount);
  const tokenAtomicPerUi = 10 ** args.decimals;
  let executedPriceSolPerToken: number | null = null;
  if (Number.isFinite(inAmt) && Number.isFinite(outAmt) && inAmt > 0 && outAmt > 0) {
    executedPriceSolPerToken = isBuy
      ? (inAmt / 1e9) / (outAmt / tokenAtomicPerUi)
      : (outAmt / 1e9) / (inAmt / tokenAtomicPerUi);
  }

  switch (sendResult.status) {
    case "ok":
      return {
        status: "ok",
        txid: sendResult.txid,
        executedPriceSolPerToken,
        quote,
      };
    case "failed_onchain":
      return {
        status: "failed_onchain",
        txid: sendResult.txid,
        err: sendResult.err,
      };
    case "not_landed":
      return { status: "not_landed", txid: sendResult.txid };
    case "landed_after_timeout":
      return {
        status: "landed_after_timeout",
        txid: sendResult.txid,
        value: sendResult.value,
        executedPriceSolPerToken,
        quote,
      };
  }
}
