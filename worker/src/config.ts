import { z } from "zod";

// Boot-required: worker refuses to start without these.
// Other vars are validated lazily where they're used (e.g. trade subsystem
// requires AGENT_WALLET_PRIVATE_KEY_BASE58 only when actually trading).
const BootSchema = z.object({
  AGENT_SHARED_SECRET: z.string().min(8, "AGENT_SHARED_SECRET must be set (>=8 chars)"),
  AGENT_WALLET_PUBLIC_KEY: z.string().min(32).optional(),
  WORKER_PORT: z.coerce.number().int().positive().default(7011),
  WORKER_BIND: z.string().default("127.0.0.1"),
  SOLANA_NETWORK: z.enum(["devnet", "mainnet-beta", "testnet"]).default("devnet"),
  SOLANA_RPC_URL: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  MEMEDECK_JUPITER_PROXY_URL: z.string().url().optional(),
  CLAUDE_MEM_PLUGIN_ROOT: z.string().optional(),
  CLAUDE_MEM_WORKER_PORT: z.coerce.number().int().positive().optional(),
  AGENT_WALLET_PRIVATE_KEY_BASE58: z.string().optional(),
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
