import path from "node:path";
import { z } from "zod";

// Treat "" as undefined so docker-compose's `KEY: ${VAR:-}` pattern (which
// always sets the env, possibly empty) doesn't turn optional URL/min-length
// fields into validation failures.
const blankToUndef = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

// Boot-required: worker refuses to start without these.
// Other vars are validated lazily where they're used (e.g. trade subsystem
// requires AGENT_WALLET_PRIVATE_KEY_BASE58 only when actually trading).
const optStr = z.preprocess(blankToUndef, z.string().optional());
const optUrl = z.preprocess(blankToUndef, z.string().url().optional());
const optPubkey = z.preprocess(blankToUndef, z.string().min(32).optional());
const optPort = z.preprocess(blankToUndef, z.coerce.number().int().positive().optional());

const BootSchema = z.object({
  // Phase 6 / audit finding #10: bumped from min(8) to min(32). 8 chars of
  // entropy is brute-forceable for an HMAC-shared secret guarding a trading
  // surface. 32 chars is the canonical floor for shared-secret authn (e.g.
  // `openssl rand -hex 32`). Test fixtures already use 32+ char secrets.
  AGENT_SHARED_SECRET: z
    .string()
    .min(32, "AGENT_SHARED_SECRET must be >=32 chars"),
  AGENT_WALLET_PUBLIC_KEY: optPubkey,
  WORKER_PORT: z.coerce.number().int().positive().default(7011),
  WORKER_BIND: z.string().default("127.0.0.1"),
  SOLANA_NETWORK: z.enum(["devnet", "mainnet-beta", "testnet"]).default("devnet"),
  SOLANA_RPC_URL: optUrl,
  ANTHROPIC_API_KEY: optStr,
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_BASE_URL: optUrl,
  AGENT_MAX_BUDGET_USD: z.coerce.number().positive().default(5),
  CLAUDE_PLUGIN_ROOT: z.string().default("/opt/claude-mem"),
  CLAUDE_CODE_PATH: optStr,
  MEMEDECK_JUPITER_PROXY_URL: optUrl,
  CLAUDE_MEM_PLUGIN_ROOT: optStr,
  CLAUDE_MEM_WORKER_PORT: optPort,
  CLAUDE_MEM_WORKER_URL: optUrl,
  AGENT_WALLET_PRIVATE_KEY_BASE58: optStr,
  MEMORY_TICK_MS: z.coerce.number().int().positive().default(5000),
  WORKING_DIR: z.string().default(path.resolve(process.cwd(), "..")),
});

export type BootConfig = z.infer<typeof BootSchema>;

function parseBoot(): BootConfig {
  const result = BootSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Worker config invalid:\n${missing}`);
  }
  return result.data;
}

export const config: BootConfig = parseBoot();
