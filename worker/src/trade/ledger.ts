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
 *   positions(tokenId PK, symbol?, entryPriceSolPerToken, sizeSol, openedAt, closedAt?)
 *
 * No migration framework — just `CREATE IF NOT EXISTS`. Add a new column?
 * Write the ALTER yourself in this file. Phase 4 keeps it ruthless.
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
  lastTradeMs(): number | null;
  totalSolToday(): number;
  openPositions(): Array<{
    tokenId: string;
    symbol: string | null;
    entryPriceSolPerToken: number;
    sizeSol: number;
    openedAt: number;
  }>;
  openPosition(input: {
    tokenId: string;
    symbol?: string;
    entryPriceSolPerToken: number;
    sizeSol: number;
  }): void;
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
  closedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
`;

export function openLedger(): TradeLedger {
  const dir = pickDbDir();
  const dbPath = path.join(dir, "trades.db");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);

  const insertTrade = db.prepare(
    `INSERT INTO trades (ts, tokenIn, tokenOut, side, amountSol, txid, executedPriceSolPerToken, reason)
     VALUES ($ts, $tokenIn, $tokenOut, $side, $amountSol, $txid, $executedPriceSolPerToken, $reason)`
  );
  const lastTradeStmt = db.prepare(
    `SELECT MAX(ts) AS lastTs FROM trades`
  );
  const totalTodayStmt = db.prepare(
    `SELECT COALESCE(SUM(amountSol), 0) AS total
       FROM trades
      WHERE side = 'BUY' AND ts >= $since`
  );
  const openPositionsStmt = db.prepare(
    `SELECT tokenId, symbol, entryPriceSolPerToken, sizeSol, openedAt
       FROM positions
      WHERE closedAt IS NULL
      ORDER BY openedAt ASC`
  );
  const upsertPositionStmt = db.prepare(
    `INSERT INTO positions (tokenId, symbol, entryPriceSolPerToken, sizeSol, openedAt, closedAt)
     VALUES ($tokenId, $symbol, $entryPriceSolPerToken, $sizeSol, $openedAt, NULL)
     ON CONFLICT(tokenId) DO UPDATE SET
       symbol = excluded.symbol,
       entryPriceSolPerToken = excluded.entryPriceSolPerToken,
       sizeSol = excluded.sizeSol,
       openedAt = excluded.openedAt,
       closedAt = NULL`
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
    lastTradeMs() {
      const row = lastTradeStmt.get() as { lastTs: number | null } | undefined;
      return row?.lastTs ?? null;
    },
    totalSolToday() {
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
      }>;
    },
    openPosition(input) {
      upsertPositionStmt.run({
        $tokenId: input.tokenId,
        $symbol: input.symbol ?? null,
        $entryPriceSolPerToken: input.entryPriceSolPerToken,
        $sizeSol: input.sizeSol,
        $openedAt: Date.now(),
      });
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
