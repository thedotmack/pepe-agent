/**
 * SQLite trade + position ledger (Phase 4).
 *
 * Uses `bun:sqlite` (built into the Bun runtime — no native build, no
 * better-sqlite3 dep). Docs: https://bun.com/docs/api/sqlite
 *
 * DB lives at `${WORKING_DIR}/.data/trades.db` if writable, else
 * `${cwd}/.data/trades.db`. In the dockerized worker, cwd is `/app/worker`
 * and `.data/` is a mounted volume (Dockerfile line 49).
 *
 * Tables:
 *   trades(id, ts, tokenIn, tokenOut, side, amountSol, txid?, executedPriceSolPerToken?, reason)
 *   positions(tokenId PK, symbol?, entryPriceSolPerToken, sizeSol, openedAt, closedAt?, decimals)
 *
 * No migration framework — just `CREATE IF NOT EXISTS` + PRAGMA-gated
 * `ALTER TABLE`. Add a new column? Write the ALTER yourself in this file.
 * Phase 4 keeps it ruthless.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, accessSync, constants } from "node:fs";
import path from "node:path";
import { config } from "../config.ts";

export interface TradeLedger {
  readonly dbPath: string;
  recordTrade(input: {
    tokenIn: string;
    tokenOut: string;
    side: "BUY" | "SELL";
    amountSol: number;
    txid: string | null;
    executedPriceSolPerToken: number | null;
    reason: string;
  }): { id: number };
  hasTradeTxid(txid: string): boolean;
  lastTradeMs(): number | null;
  /**
   * BUY-only daily SOL deployed. Policy's daily cap reads this so SELL
   * proceeds don't artificially shrink the deployed-capital number; see
   * policy.ts daily-cap section.
   *
   * Phase 8 (O5): the redundant `totalBuySolToday()` method was deleted —
   * zero production callers and the SQL behind both methods was identical.
   * The remaining test fixtures kept the legacy stub for hand-built
   * FakeLedger objects; those are scrubbed in this phase too.
   */
  dailyBuySolToday(): number;
  openPositions(): Array<{
    tokenId: string;
    symbol: string | null;
    entryPriceSolPerToken: number;
    sizeSol: number;
    openedAt: number;
    decimals: number;
    /**
     * Phase 10 (codex re-audit #1): exact atomic uint64 of the non-SOL token
     * received at entry (quote.outAmount on the BUY). Stored as a base-10
     * string because SQLite REAL can't represent every u64 losslessly and a
     * future Token-2022 mint might emit values past 2^53. The agent reads
     * this verbatim to size SELLs, instead of approximating from sizeSol /
     * entryPriceSolPerToken (which drifts with entry slippage).
     *
     * Legacy positions opened before this column gets a string "0" via
     * SQLite's ALTER … DEFAULT; position-monitor backfills on first read by
     * querying the ATA, similar to the Phase 3 decimals backfill.
     */
    tokensReceivedAtomic: string;
  }>;
  openPosition(input: {
    tokenId: string;
    symbol?: string;
    entryPriceSolPerToken: number;
    sizeSol: number;
    decimals: number;
    /**
     * Phase 10 (#1): caller passes the exact uint64 of tokens received from
     * the BUY's quote.outAmount. Optional only because mark_position has no
     * way to know the on-chain amount up front; that path stores "0" and
     * lets the lazy ATA backfill fill it in.
     */
    tokensReceivedAtomic?: bigint;
  }): void;
  /**
   * Backfill decimals for a legacy position row that was opened before the
   * column existed (or stored a bootstrap default). Phase 3 calls this from
   * position-monitor when it has to lazy-fetch getMint for the first tick.
   */
  setPositionDecimals(tokenId: string, decimals: number): void;
  /**
   * Phase 10 (#1) backfill for tokensReceivedAtomic on a legacy row. Mirrors
   * setPositionDecimals; position-monitor calls this on first read when the
   * row stores "0" but the ATA holds a real balance. bigint→TEXT to avoid
   * SQLite REAL losing precision on large u64 values.
   */
  setPositionTokensReceived(tokenId: string, atomic: bigint): void;
  closePosition(tokenId: string): void;
  /**
   * Phase 7 H4: persist a structured trade-result event. Until this method
   * existed, state.ts:recordTradeResult silently dropped the meta param
   * its 13 call-sites already populate with (side, txid, outcome, reason).
   * Now those fire-and-forget events get a row in `phase_events` so a
   * human can reconcile against trades.txid + decision-log narration.
   */
  recordPhaseEvent(input: {
    side?: "BUY" | "SELL";
    txid?: string;
    outcome?: string;
    reason: string;
  }): void;
  /** Phase 7 H4 helper for tests + offline audit: list events newest-first. */
  recentPhaseEvents(limit?: number): Array<{
    id: number;
    ts: number;
    side: string | null;
    txid: string | null;
    outcome: string | null;
    reason: string;
  }>;
  close(): void;
}

function pickDbDir(): string {
  const candidates = [
    path.join(config.WORKING_DIR, ".data"),
    path.resolve(process.cwd(), ".data"),
  ];
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
      return dir;
    } catch {
      // try next candidate
    }
  }
  // Last resort: cwd/.data even if access check failed (let SQLite throw
  // with a useful error rather than silently picking a wrong path).
  const fallback = path.resolve(process.cwd(), ".data");
  if (!existsSync(fallback)) mkdirSync(fallback, { recursive: true });
  return fallback;
}

function utcMidnightMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  tokenIn TEXT NOT NULL,
  tokenOut TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  amountSol REAL NOT NULL,
  txid TEXT,
  executedPriceSolPerToken REAL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  tokenId TEXT PRIMARY KEY,
  symbol TEXT,
  entryPriceSolPerToken REAL NOT NULL,
  sizeSol REAL NOT NULL,
  openedAt INTEGER NOT NULL,
  closedAt INTEGER,
  decimals INTEGER NOT NULL DEFAULT 9,
  -- Phase 10 (#1): exact uint64 of non-SOL token received at BUY entry,
  -- stored as TEXT so we never lose precision through SQLite's REAL. Legacy
  -- rows backfill on first position-monitor tick via getAccount(ata).
  tokensReceivedAtomic TEXT NOT NULL DEFAULT '0'
);
-- Phase 7 H4: structured trade-result audit log. Each row is one
-- recordTradeResult() event from state.ts (denied_policy, ok, failed_onchain,
-- not_landed, landed_after_timeout, no_token_account). Trade rows in trades
-- table capture only successful on-chain effects; this table captures every
-- attempt, including pre-send denials.
CREATE TABLE IF NOT EXISTS phase_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  side TEXT,
  txid TEXT,
  outcome TEXT,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_txid_unique ON trades(txid) WHERE txid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_phase_events_ts ON phase_events(ts);
`;

// citation: SQLite ADD COLUMN with DEFAULT backfills existing rows; PRAGMA
// table_info gates the ALTER so we never get "duplicate column" on second boot.
// https://www.sqlite.org/lang_altertable.html#altertabaddcol
function migratePositionsDecimals(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(positions)`).all() as Array<{
    name: string;
  }>;
  const hasDecimals = cols.some((c) => c.name === "decimals");
  if (!hasDecimals) {
    db.exec(
      `ALTER TABLE positions ADD COLUMN decimals INTEGER NOT NULL DEFAULT 9`,
    );
  }
}

// Phase 10 (#1): same PRAGMA pattern as decimals — gate the ALTER so a
// second boot doesn't duplicate-column-error. Default '0' marks legacy rows;
// position-monitor's first tick backfills via getAccount(ata).
function migratePositionsTokensReceived(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(positions)`).all() as Array<{
    name: string;
  }>;
  const hasCol = cols.some((c) => c.name === "tokensReceivedAtomic");
  if (!hasCol) {
    db.exec(
      `ALTER TABLE positions ADD COLUMN tokensReceivedAtomic TEXT NOT NULL DEFAULT '0'`,
    );
  }
}

export function openLedger(): TradeLedger {
  const dir = pickDbDir();
  const dbPath = path.join(dir, "trades.db");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
  migratePositionsDecimals(db);
  migratePositionsTokensReceived(db);

  const insertTrade = db.prepare(
    `INSERT INTO trades (ts, tokenIn, tokenOut, side, amountSol, txid, executedPriceSolPerToken, reason)
     VALUES ($ts, $tokenIn, $tokenOut, $side, $amountSol, $txid, $executedPriceSolPerToken, $reason)`
  );
  const lastTradeStmt = db.prepare(
    `SELECT MAX(ts) AS lastTs FROM trades`
  );
  const tradeByTxidStmt = db.prepare(
    `SELECT 1 AS found FROM trades WHERE txid = $txid LIMIT 1`
  );
  const totalTodayStmt = db.prepare(
    `SELECT COALESCE(SUM(amountSol), 0) AS total
       FROM trades
      WHERE side = 'BUY' AND ts >= $since`
  );
  const openPositionsStmt = db.prepare(
    `SELECT tokenId, symbol, entryPriceSolPerToken, sizeSol, openedAt, decimals, tokensReceivedAtomic
       FROM positions
      WHERE closedAt IS NULL
      ORDER BY openedAt ASC`
  );
  // Phase 10 (#1): tokensReceivedAtomic is stored as TEXT (uint64-safe).
  // Caller's bigint is stringified before binding; legacy '0' default
  // means "backfill on first read".
  const upsertPositionStmt = db.prepare(
    `INSERT INTO positions (tokenId, symbol, entryPriceSolPerToken, sizeSol, openedAt, closedAt, decimals, tokensReceivedAtomic)
     VALUES ($tokenId, $symbol, $entryPriceSolPerToken, $sizeSol, $openedAt, NULL, $decimals, $tokensReceivedAtomic)
     ON CONFLICT(tokenId) DO UPDATE SET
       symbol = excluded.symbol,
       entryPriceSolPerToken = excluded.entryPriceSolPerToken,
       sizeSol = excluded.sizeSol,
       openedAt = excluded.openedAt,
       decimals = excluded.decimals,
       tokensReceivedAtomic = excluded.tokensReceivedAtomic,
       closedAt = NULL`
  );
  const setDecimalsStmt = db.prepare(
    `UPDATE positions SET decimals = $decimals WHERE tokenId = $tokenId`
  );
  const setTokensReceivedStmt = db.prepare(
    `UPDATE positions SET tokensReceivedAtomic = $tokensReceivedAtomic WHERE tokenId = $tokenId`
  );
  const closePositionStmt = db.prepare(
    `UPDATE positions SET closedAt = $closedAt WHERE tokenId = $tokenId AND closedAt IS NULL`
  );
  const insertPhaseEventStmt = db.prepare(
    `INSERT INTO phase_events (ts, side, txid, outcome, reason)
     VALUES ($ts, $side, $txid, $outcome, $reason)`,
  );
  const recentPhaseEventsStmt = db.prepare(
    `SELECT id, ts, side, txid, outcome, reason
       FROM phase_events
      ORDER BY id DESC
      LIMIT $limit`,
  );

  return {
    dbPath,
    recordTrade(input) {
      const result = insertTrade.run({
        $ts: Date.now(),
        $tokenIn: input.tokenIn,
        $tokenOut: input.tokenOut,
        $side: input.side,
        $amountSol: input.amountSol,
        $txid: input.txid,
        $executedPriceSolPerToken: input.executedPriceSolPerToken,
        $reason: input.reason,
      });
      return { id: Number(result.lastInsertRowid) };
    },
    hasTradeTxid(txid) {
      const row = tradeByTxidStmt.get({ $txid: txid }) as { found: number } | undefined;
      return row?.found === 1;
    },
    lastTradeMs() {
      const row = lastTradeStmt.get() as { lastTs: number | null } | undefined;
      return row?.lastTs ?? null;
    },
    dailyBuySolToday() {
      // Re-uses totalTodayStmt because the statement already filters
      // side='BUY' (see SCHEMA_SQL above). Same window, same source —
      // keeping the methods distinct documents intent at the policy layer.
      const since = utcMidnightMs(Date.now());
      const row = totalTodayStmt.get({ $since: since }) as { total: number } | undefined;
      return row?.total ?? 0;
    },
    openPositions() {
      return openPositionsStmt.all() as Array<{
        tokenId: string;
        symbol: string | null;
        entryPriceSolPerToken: number;
        sizeSol: number;
        openedAt: number;
        decimals: number;
        tokensReceivedAtomic: string;
      }>;
    },
    openPosition(input) {
      upsertPositionStmt.run({
        $tokenId: input.tokenId,
        $symbol: input.symbol ?? null,
        $entryPriceSolPerToken: input.entryPriceSolPerToken,
        $sizeSol: input.sizeSol,
        $openedAt: Date.now(),
        $decimals: input.decimals,
        // Phase 10 (#1): bigint→TEXT for u64 safety. Absent on manual
        // mark_position path → store '0' so position-monitor's first tick
        // triggers the ATA backfill via setPositionTokensReceived.
        $tokensReceivedAtomic: (input.tokensReceivedAtomic ?? 0n).toString(),
      });
    },
    setPositionDecimals(tokenId, decimals) {
      setDecimalsStmt.run({ $tokenId: tokenId, $decimals: decimals });
    },
    setPositionTokensReceived(tokenId, atomic) {
      setTokensReceivedStmt.run({
        $tokenId: tokenId,
        $tokensReceivedAtomic: atomic.toString(),
      });
    },
    closePosition(tokenId) {
      closePositionStmt.run({
        $tokenId: tokenId,
        $closedAt: Date.now(),
      });
    },
    recordPhaseEvent(input) {
      insertPhaseEventStmt.run({
        $ts: Date.now(),
        $side: input.side ?? null,
        $txid: input.txid ?? null,
        $outcome: input.outcome ?? null,
        $reason: input.reason,
      });
    },
    recentPhaseEvents(limit = 50) {
      return recentPhaseEventsStmt.all({ $limit: limit }) as Array<{
        id: number;
        ts: number;
        side: string | null;
        txid: string | null;
        outcome: string | null;
        reason: string;
      }>;
    },
    close() {
      db.close();
    },
  };
}
