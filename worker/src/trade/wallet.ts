/**
 * Custodial agent wallet (Phase 4).
 *
 * Loads the agent's Solana keypair from `AGENT_WALLET_PRIVATE_KEY_BASE58`
 * lazily — the worker boots without this env var; only `submit_trade` calls
 * `getKeypair()`, which throws fail-loud if the key is missing.
 *
 * Keypair never touches disk in plaintext; logs only ever print the public
 * key. (See plan Phase 4 anti-pattern: "Don't store the keypair in any file
 * the worker logs / dumps to disk in plaintext".)
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.ts";

let cached: Keypair | null = null;

export function getKeypair(): Keypair {
  if (cached) return cached;
  if (!config.AGENT_WALLET_PRIVATE_KEY_BASE58) {
    throw new Error(
      "AGENT_WALLET_PRIVATE_KEY_BASE58 not set — cannot trade"
    );
  }
  cached = Keypair.fromSecretKey(
    bs58.decode(config.AGENT_WALLET_PRIVATE_KEY_BASE58)
  );
  return cached;
}

export function getPublicKey(): string {
  return getKeypair().publicKey.toBase58();
}

/**
 * Soft pubkey accessor: returns null if no key (public OR private) is
 * configured, so /state and /healthz can render either form without
 * throwing on cold boot.
 */
export function tryGetPublicKey(): string | null {
  if (config.AGENT_WALLET_PUBLIC_KEY) return config.AGENT_WALLET_PUBLIC_KEY;
  if (!config.AGENT_WALLET_PRIVATE_KEY_BASE58) return null;
  try {
    return getPublicKey();
  } catch {
    return null;
  }
}

/**
 * True iff the worker can sign a transaction.
 * (`AGENT_WALLET_PUBLIC_KEY` alone is NOT enough.)
 */
export function walletAvailable(): boolean {
  return !!config.AGENT_WALLET_PRIVATE_KEY_BASE58;
}
