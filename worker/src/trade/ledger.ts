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
   * Telemetry-only since Phase 5. Currently identical to dailyBuySolToday()
   * because totalTodayStmt filters BUY rows (see SCHEMA / totalTodayStmt
   * below). Kept as a named method for log lines that say "today's BUY
   * total"; policy must read dailyBuySolToday() so the intent is explicit.
   */
  totalSolToday(): number;
  /**
   * BUY-only daily SOL deployed. Policy's daily cap reads this so SELL
   * proceeds don't artificially shrink the deployed-capital number; see
   * policy.ts daily-cap section.
   */
  dailyBuySolToday(): number;
  openPositions(): Array<{
    tokenId: string;
    symbol: string | null;
    entryPriceSolPerToken: number;
    sizeSol: number;
    openedAt: number;
    decimals: number;
  }>;
  openPosition(input: {
    tokenId: string;
    symbol?: string;
    entryPriceSolPerToken: number;
    sizeSol: number;
    decimals: number;
  }): void;
  /**
   * Backfill decimals for a legacy position row that was opened before the
   * column existed (or stored a bootstrap default). Phase 3 calls this from
   * position-monitor when it has to lazy-fetch getMint for the first tick.
   */
  setPositionDecimals(tokenId: string, decimals: number): void;
  closePosition(tokenId: string): void;
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
  decimals INTEGER NOT NULL DEFAULT 9
);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_txid_unique ON trades(txid) WHERE txid IS NOT NULL;
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

export function openLedger(): TradeLedger {
  const dir = pickDbDir();
  const dbPath = path.join(dir, "trades.db");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
  migratePositionsDecimals(db);

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
    `SELECT tokenId, symbol, entryPriceSolPerToken, sizeSol, openedAt, decimals
       FROM positions
      WHERE closedAt IS NULL
      ORDER BY openedAt ASC`
  );
  const upsertPositionStmt = db.prepare(
    `INSERT INTO positions (tokenId, symbol, entryPriceSolPerToken, sizeSol, openedAt, closedAt, decimals)
     VALUES ($tokenId, $symbol, $entryPriceSolPerToken, $sizeSol, $openedAt, NULL, $decimals)
     ON CONFLICT(tokenId) DO UPDATE SET
       symbol = excluded.symbol,
       entryPriceSolPerToken = excluded.entryPriceSolPerToken,
       sizeSol = excluded.sizeSol,
       openedAt = excluded.openedAt,
       decimals = excluded.decimals,
       closedAt = NULL`
  );
  const setDecimalsStmt = db.prepare(
    `UPDATE positions SET decimals = $decimals WHERE tokenId = $tokenId`
  );
  const closePositionStmt = db.prepare(
    `UPDATE positions SET closedAt = $closedAt WHERE tokenId = $tokenId AND closedAt IS NULL`
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
    totalSolToday() {
      const since = utcMidnightMs(Date.now());
      const row = totalTodayStmt.get({ $since: since }) as { total: number } | undefined;
      return row?.total ?? 0;
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
      });
    },
    setPositionDecimals(tokenId, decimals) {
      setDecimalsStmt.run({ $tokenId: tokenId, $decimals: decimals });
    },
    closePosition(tokenId) {
      closePositionStmt.run({
        $tokenId: tokenId,
        $closedAt: Date.now(),
      });
    },
    close() {
      db.close();
    },
  };
}
