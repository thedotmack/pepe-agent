import {
  DotMatrixKit,
  DOT_BOARD,
  DOT_BOARD_DESKTOP,
  type Cell,
  type Matrix,
  type Tone,
} from "./dot-matrix-ui-kit";
import type { ActivityToken } from "@/lib/activity/activity-websocket";

export type FeedStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "rest-fallback"
  | "stale";

const {
  createMatrix,
  drawDottedField,
  drawText,
  drawWrappedText,
  drawPanel,
  drawBadge,
  drawLine,
  setDot,
} = DotMatrixKit;

export type PepeFrame = { x: number; y: number; w: number; h: number };

export type ChatLogEntry = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
};

export type RenderBoardOptions = {
  status: FeedStatus;
  selectedTokenId?: string;
  pepeIsSpeaking: boolean;
  transcript?: string | null;
  /** Animation phase 0..1 — used to pulse the beam. */
  beamPhase?: number;
  walletSol?: number;
  pnlUsd?: number;
  layout?: "mobile" | "desktop";
  chat?: ChatLogEntry[];
  draft?: string;
  /** True when chat input has focus / cursor blink */
  cursorOn?: boolean;
};

export type RenderBoardResult = {
  matrix: Matrix;
  pepeFrame: PepeFrame;
  /** Pixel rect for the chat input strip — used to position HTML <input> overlay */
  chatInputFrame: PepeFrame;
  /** Board dimensions in dots */
  cols: number;
  rows: number;
};

// ────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────────────

function statusTone(status: FeedStatus): Tone {
  switch (status) {
    case "live":
      return "cyan";
    case "rest-fallback":
      return "amber";
    case "reconnecting":
    case "connecting":
      return "blue";
    case "stale":
    default:
      return "dim";
  }
}

function statusLabel(status: FeedStatus): string {
  switch (status) {
    case "live":
      return "LIVE";
    case "rest-fallback":
      return "REST";
    case "reconnecting":
      return "RECON";
    case "stale":
      return "STALE";
    case "connecting":
    default:
      return "SYNC";
  }
}

function formatPrice(p: number): string {
  if (!isFinite(p) || p <= 0) return "0";
  if (p < 0.01) return p.toExponential(1);
  if (p < 1) return p.toFixed(4);
  if (p < 100) return p.toFixed(2);
  return Math.round(p).toString();
}

function formatGain(g: number): string {
  if (!isFinite(g)) return "0%";
  const percent = Math.abs(g) <= 2 ? g * 100 : g;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(0)}%`;
}

function formatPressure(p: number): string {
  if (!isFinite(p)) return "0.0";
  return Math.max(0, Math.min(1, p)).toFixed(1);
}

function formatBuyP(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "--";
  if (value <= 1) return value.toFixed(2);
  if (value >= 1_000) return `$${(value / 1000).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

function formatLiq(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "--";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return `${Math.round(value)}`;
}

function formatTime(value: number | string | undefined, isAge = false): string {
  if (!value) return "--";
  const ts = typeof value === "string" ? new Date(value).getTime() : value;
  if (!Number.isFinite(ts)) return "--";
  const total = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (total >= 86400) return `${Math.floor(total / 86400)}D`;
  if (total >= 3600) return `${Math.floor(total / 3600)}H`;
  if (total >= 60) return `${Math.floor(total / 60)}M`;
  return isAge ? `${total}S` : `${total}S`;
}

function formatSol(value: number): string {
  if (!isFinite(value)) return "0.00";
  return value.toFixed(2);
}

function formatUsd(value: number): string {
  if (!isFinite(value)) return "$0";
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(0)}`;
}

function rowToneForGain(gain: number): Tone {
  return gain >= 0 ? "cyan" : "amber";
}

function drawDivider(m: Matrix, x: number, y: number, w: number, phase: number): void {
  drawLine(m, x, y, w, "ghost", 0.26);
  for (let i = w - 30; i < w; i += 3) {
    const wave = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2 + i * 0.35);
    setDot(m, x + i, y - Math.round(wave * 2), "cyan", 0.34 + wave * 0.38);
  }
}

function drawPressureBar(m: Matrix, x: number, y: number, value: number, length = 12): void {
  const clamped = Math.max(0, Math.min(1, value));
  const active = Math.round(clamped * length);
  for (let i = 0; i < length; i += 1) {
    setDot(m, x + i, y, i < active ? "cyan" : "ghost", i < active ? 0.82 : 0.26);
    if (i < active && i % 3 === 0) setDot(m, x + i, y + 1, "cyan", 0.48);
  }
}

function decisionMessage(token: ActivityToken | undefined, opts: RenderBoardOptions): string {
  if (opts.transcript) return opts.transcript;
  if (opts.status === "stale") return "WAITING ON THE TAPE";
  if (!token) return "SCANNING THE MEME TAPE";

  const sym = token.symbol?.slice(0, 6) || "TOKEN";
  const gain = token.fiveMinGain ?? 0;
  const pressure = token.buyPressure5m ?? 0;
  if (gain < 0) return `${sym} LEAKING - PASS`;
  if (pressure >= 0.7) return `${sym} COILED - IM IN 0.21 SOL`;
  return `${sym} HEATING UP - WATCH`;
}

function signalLabel(token: ActivityToken): string {
  const raw = token.signal;
  if (raw && typeof raw === "string") return raw.slice(0, 6).toUpperCase();
  const gain = token.fiveMinGain ?? 0;
  const pressure = token.buyPressure5m ?? 0;
  if (gain >= 0.2 && pressure >= 0.7) return "STRONG";
  if (gain >= 0.1 && pressure >= 0.55) return "RISING";
  if (gain >= 0) return "WATCH";
  return "FLAT";
}

function signalTone(label: string): Tone {
  if (label === "STRONG") return "cyan";
  if (label === "RISING") return "cyan";
  if (label === "WATCH") return "blue";
  return "dim";
}

function drawBeam(
  m: Matrix,
  from: { x: number; y: number },
  to: { x: number; y: number },
  phase: number,
  bright: boolean,
): void {
  const dxAbs = Math.abs(to.x - from.x);
  const dyAbs = Math.abs(to.y - from.y);
  const steps = Math.max(dxAbs, dyAbs);
  if (steps <= 0) return;

  const sx = Math.sign(to.x - from.x) || 1;
  const sy = Math.sign(to.y - from.y) || 1;

  let x = from.x;
  let y = from.y;
  let xRem = dxAbs;
  let yRem = dyAbs;

  for (let i = 0; i < steps; i += 2) {
    const wave = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2 + i * 0.3);
    const base = bright ? 0.55 : 0.35;
    const level = Math.min(1, base + 0.45 * wave);
    setDot(m, x, y, "cyan", level);

    if (xRem > 0 && (yRem === 0 || i % 3 === 0)) {
      x += sx;
      xRem -= 1;
    } else if (yRem > 0) {
      y += sy;
      yRem -= 1;
    } else if (xRem > 0) {
      x += sx;
      xRem -= 1;
    }

    if (xRem > 0 && (yRem === 0 || (i + 1) % 3 === 0)) {
      x += sx;
      xRem -= 1;
    } else if (yRem > 0) {
      y += sy;
      yRem -= 1;
    } else if (xRem > 0) {
      x += sx;
      xRem -= 1;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Mobile (108×192 portrait)
// ────────────────────────────────────────────────────────────────────────────

const MOBILE_ROW_HEIGHT = 14;
const MOBILE_ROW_LIST_TOP = 22;
const MOBILE_ROW_LIST_BOTTOM = 134;
const MOBILE_MAX_VISIBLE = Math.floor(
  (MOBILE_ROW_LIST_BOTTOM - MOBILE_ROW_LIST_TOP) / MOBILE_ROW_HEIGHT,
);

const MOBILE_HABITAT: PepeFrame = { x: 4, y: 138, w: 100, h: 36 };
const MOBILE_PEPE_FRAME: PepeFrame = { x: 8, y: 140, w: 38, h: 32 };
const MOBILE_PEPE_EYE = { x: 27, y: 152 };
const MOBILE_CHAT_INPUT_FRAME: PepeFrame = { x: 4, y: 178, w: 100, h: 12 };

function renderMobile(rows: ActivityToken[], opts: RenderBoardOptions): RenderBoardResult {
  const m = createMatrix(DOT_BOARD.cols, DOT_BOARD.rows);
  const phase = opts.beamPhase ?? 0;
  drawDottedField(m, 13);

  // Header
  drawText(m, "PEPE HQ", 2, 0, { font: "lg", tone: "cyan", level: 0.96 });
  drawBadge(m, 84, 2, statusLabel(opts.status), {
    tone: statusTone(opts.status),
    active: opts.status === "live",
    width: 21,
  });
  drawText(m, `${formatSol(opts.walletSol ?? 4.21)} SOL`, 5, 16, {
    font: "sm",
    tone: "white",
    level: 0.78,
    maxWidth: 32,
  });
  drawText(m, formatUsd(opts.pnlUsd ?? 24.18), 43, 16, {
    font: "sm",
    tone: (opts.pnlUsd ?? 24.18) >= 0 ? "cyan" : "amber",
    level: 0.76,
    maxWidth: 28,
  });
  drawDivider(m, 4, 20, 100, phase);

  // Token rows
  const visible = rows.slice(0, MOBILE_MAX_VISIBLE);
  if (visible.length === 0) {
    drawText(m, "SCANNING TAPE", 22, 66, { font: "md", tone: "dim", level: 0.7 });
  } else {
    visible.forEach((t, i) => {
      const y = MOBILE_ROW_LIST_TOP + i * MOBILE_ROW_HEIGHT;
      const active = t.tokenId === opts.selectedTokenId;
      drawPanel(m, 4, y, 100, MOBILE_ROW_HEIGHT - 1, {
        tone: "blue",
        level: active ? 0.7 : 0.32,
        active,
      });
      const sym = (t.symbol ?? "??").toString();
      drawText(m, `$${sym.slice(0, 6)}`, 7, y + 3, {
        font: "md",
        tone: "white",
        level: 0.95,
        maxWidth: 27,
      });
      drawText(m, formatPrice(t.price ?? 0), 35, y + 4, {
        font: "sm",
        tone: "cyan",
        level: 0.85,
        maxWidth: 21,
      });
      const gain = t.fiveMinGain ?? 0;
      drawText(m, formatGain(gain), 58, y + 4, {
        font: "sm",
        tone: rowToneForGain(gain),
        level: 0.9,
        maxWidth: 18,
      });
      const bp = Math.max(0, Math.min(1, t.buyPressure5m ?? 0));
      drawPressureBar(m, 79, y + 5, bp, 12);
      drawText(m, formatPressure(bp), 93, y + 4, {
        font: "sm",
        tone: active ? "white" : "dim",
        level: active ? 0.86 : 0.64,
        maxWidth: 12,
      });
    });
  }
  drawDivider(m, 4, 135, 100, phase + 0.2);

  // Pepe habitat + decision bubble
  drawPanel(m, MOBILE_HABITAT.x, MOBILE_HABITAT.y, MOBILE_HABITAT.w, MOBILE_HABITAT.h, {
    tone: "blue",
    level: 0.4,
  });
  const activeToken = visible.find((t) => t.tokenId === opts.selectedTokenId);
  const bubbleLevel = opts.status === "stale" ? 0.76 : 0.58 + 0.22 * Math.sin(phase * Math.PI);
  drawPanel(m, 50, 140, 52, 22, {
    tone: opts.status === "stale" ? "amber" : "cyan",
    level: bubbleLevel,
    active: phase > 0.6,
  });
  drawWrappedText(m, decisionMessage(activeToken, opts), 53, 144, 46, {
    font: "sm",
    tone: "white",
    level: 0.9,
    maxLines: 3,
  });

  // Chat log mini
  const chatY = 164;
  const recent = (opts.chat ?? []).slice(-2);
  recent.forEach((msg, i) => {
    const tone: Tone = msg.role === "user" ? "amber" : "cyan";
    const prefix = msg.role === "user" ? ">" : "P";
    drawText(m, `${prefix} ${msg.text}`, 6, chatY + i * 7, {
      font: "sm",
      tone,
      level: 0.78,
      maxWidth: 96,
    });
  });

  // Chat input strip (rows 178-189)
  drawPanel(
    m,
    MOBILE_CHAT_INPUT_FRAME.x,
    MOBILE_CHAT_INPUT_FRAME.y,
    MOBILE_CHAT_INPUT_FRAME.w,
    MOBILE_CHAT_INPUT_FRAME.h,
    { tone: "blue", level: 0.5 },
  );
  drawText(m, "PEPE>", MOBILE_CHAT_INPUT_FRAME.x + 4, MOBILE_CHAT_INPUT_FRAME.y + 3, {
    font: "sm",
    tone: "cyan",
    level: 0.9,
  });

  // Beam from Pepe to selected row
  if (opts.selectedTokenId) {
    const idx = visible.findIndex((t) => t.tokenId === opts.selectedTokenId);
    if (idx >= 0) {
      const rowY = MOBILE_ROW_LIST_TOP + idx * MOBILE_ROW_HEIGHT + Math.floor(MOBILE_ROW_HEIGHT / 2);
      drawBeam(
        m,
        MOBILE_PEPE_EYE,
        { x: 100, y: rowY },
        phase,
        opts.pepeIsSpeaking || phase > 0.62,
      );
    }
  }

  return {
    matrix: m,
    pepeFrame: MOBILE_PEPE_FRAME,
    chatInputFrame: MOBILE_CHAT_INPUT_FRAME,
    cols: DOT_BOARD.cols,
    rows: DOT_BOARD.rows,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Desktop (240×144 landscape) — full activity monitor + Pepe HQ + chat
// ────────────────────────────────────────────────────────────────────────────

const DESK_COLS = DOT_BOARD_DESKTOP.cols;
const DESK_ROWS = DOT_BOARD_DESKTOP.rows;

// Pepe HQ habitat: top-left under the wallet line
const DESK_PEPE_FRAME: PepeFrame = { x: 12, y: 26, w: 64, h: 52 };
const DESK_PEPE_EYE = { x: 76, y: 44 };

// Chat input strip across the bottom
const DESK_CHAT_INPUT_FRAME: PepeFrame = { x: 4, y: 128, w: 232, h: 12 };

// Activity table on right
const DESK_TABLE_X = 92;
const DESK_TABLE_Y = 16;
const DESK_TABLE_W = DESK_COLS - DESK_TABLE_X - 4; // 144
const DESK_ROW_HEIGHT = 12;
const DESK_TABLE_HEADER_Y = DESK_TABLE_Y;
const DESK_TABLE_FIRST_ROW = DESK_TABLE_Y + 8;
const DESK_TABLE_BOTTOM = 124;
const DESK_MAX_ROWS = Math.floor((DESK_TABLE_BOTTOM - DESK_TABLE_FIRST_ROW) / DESK_ROW_HEIGHT);

// Column anchors relative to DESK_TABLE_X. Total width budget ≈ 144 cols.
const COL_NUM = 0; // "#"
const COL_SYM = 6; // SYMBOL
const COL_PRICE = 36; // price
const COL_GAIN5 = 60; // 5m%
const COL_BUYP = 80; // buy pressure
const COL_POOL = 102; // liquidity
const COL_UPM = 120; // updates/min
const COL_SIG = 132; // signal label

function renderDesktop(rows: ActivityToken[], opts: RenderBoardOptions): RenderBoardResult {
  const m = createMatrix(DESK_COLS, DESK_ROWS);
  const phase = opts.beamPhase ?? 0;
  drawDottedField(m, 13);

  // ── Header band (rows 0-12) ───────────────────────────────────────────────
  drawText(m, "PEPE HQ", 4, 1, { font: "md", tone: "cyan", level: 0.96 });
  drawText(m, "LIVE ACTIVITY MONITOR", DESK_TABLE_X, 1, {
    font: "md",
    tone: "cyan",
    level: 0.86,
  });
  // Status badge top-right
  drawBadge(m, DESK_COLS - 30, 0, statusLabel(opts.status), {
    tone: statusTone(opts.status),
    active: opts.status === "live",
    width: 26,
  });

  // ── Activity table ────────────────────────────────────────────────────────
  // Table border panel
  drawPanel(
    m,
    DESK_TABLE_X - 2,
    DESK_TABLE_Y - 2,
    DESK_TABLE_W + 4,
    DESK_TABLE_BOTTOM - DESK_TABLE_Y + 4,
    { tone: "blue", level: 0.32 },
  );

  // Column headers
  const tx = DESK_TABLE_X;
  const hy = DESK_TABLE_HEADER_Y;
  const headerOpts = { font: "sm" as const, tone: "dim" as const, level: 0.7 };
  drawText(m, "#", tx + COL_NUM, hy, headerOpts);
  drawText(m, "SYM", tx + COL_SYM, hy, headerOpts);
  drawText(m, "PRICE", tx + COL_PRICE, hy, headerOpts);
  drawText(m, "5M%", tx + COL_GAIN5, hy, headerOpts);
  drawText(m, "BUYP", tx + COL_BUYP, hy, headerOpts);
  drawText(m, "POOL", tx + COL_POOL, hy, headerOpts);
  drawText(m, "U/M", tx + COL_UPM, hy, headerOpts);
  drawText(m, "SIG", tx + COL_SIG, hy, headerOpts);
  drawLine(m, tx, hy + 6, DESK_TABLE_W - 4, "ghost", 0.32);

  // Token rows
  const visible = rows.slice(0, DESK_MAX_ROWS);
  if (visible.length === 0) {
    drawText(m, "SCANNING THE TAPE", tx + 20, DESK_TABLE_FIRST_ROW + 30, {
      font: "md",
      tone: "dim",
      level: 0.66,
    });
  } else {
    visible.forEach((t, i) => {
      const y = DESK_TABLE_FIRST_ROW + i * DESK_ROW_HEIGHT;
      const active = t.tokenId === opts.selectedTokenId;
      if (active) {
        // Row highlight bar
        for (let bx = tx - 1; bx < tx + DESK_TABLE_W - 2; bx += 1) {
          setDot(m, bx, y - 1, "cyan", 0.18);
          setDot(m, bx, y + DESK_ROW_HEIGHT - 3, "cyan", 0.12);
        }
      }

      const sym = (t.symbol ?? "??").toString().toUpperCase();
      const gain = t.fiveMinGain ?? 0;
      const sig = signalLabel(t);

      drawText(m, String(i + 1), tx + COL_NUM, y, {
        font: "sm",
        tone: active ? "white" : "dim",
        level: active ? 0.9 : 0.6,
      });
      drawText(m, sym.slice(0, 6), tx + COL_SYM, y, {
        font: "sm",
        tone: active ? "cyan" : "white",
        level: active ? 1 : 0.92,
        maxWidth: 28,
      });
      drawText(m, `$${formatPrice(t.price ?? 0)}`, tx + COL_PRICE, y, {
        font: "sm",
        tone: "white",
        level: 0.78,
        maxWidth: 22,
      });
      drawText(m, formatGain(gain), tx + COL_GAIN5, y, {
        font: "sm",
        tone: rowToneForGain(gain),
        level: 0.9,
        maxWidth: 18,
      });
      drawText(m, formatBuyP(t.buyPressure5m), tx + COL_BUYP, y, {
        font: "sm",
        tone: (t.buyPressure5m ?? 0) > 0.5 ? "cyan" : "dim",
        level: 0.86,
        maxWidth: 20,
      });
      drawText(m, formatLiq(t.liquidity), tx + COL_POOL, y, {
        font: "sm",
        tone: "white",
        level: 0.78,
        maxWidth: 16,
      });
      drawText(m, String(Math.round(t.updatesPerMinute ?? 0)), tx + COL_UPM, y, {
        font: "sm",
        tone: "cyan",
        level: 0.78,
        maxWidth: 10,
      });
      drawText(m, sig, tx + COL_SIG, y, {
        font: "sm",
        tone: signalTone(sig),
        level: 0.84,
        maxWidth: DESK_TABLE_W - COL_SIG - 6,
      });
    });
  }

  // ── Pepe HQ panel (cols 0-88, rows 14-122) ────────────────────────────────
  drawPanel(m, 2, 14, 86, 108, { tone: "blue", level: 0.4 });

  // Wallet + PnL header inside the panel
  drawText(m, `${formatSol(opts.walletSol ?? 4.21)} SOL`, 6, 16, {
    font: "sm",
    tone: "white",
    level: 0.86,
  });
  drawText(m, formatUsd(opts.pnlUsd ?? 24.18), 50, 16, {
    font: "sm",
    tone: (opts.pnlUsd ?? 24.18) >= 0 ? "cyan" : "amber",
    level: 0.86,
  });
  drawLine(m, 5, 22, 80, "ghost", 0.32);

  // Decision bubble below Pepe (Pepe sprite overlay sits at DESK_PEPE_FRAME)
  const activeToken = visible.find((t) => t.tokenId === opts.selectedTokenId);
  const bubbleLevel = opts.status === "stale" ? 0.76 : 0.58 + 0.22 * Math.sin(phase * Math.PI);
  drawPanel(m, 4, 80, 82, 22, {
    tone: opts.status === "stale" ? "amber" : "cyan",
    level: bubbleLevel,
    active: phase > 0.6,
  });
  drawWrappedText(m, decisionMessage(activeToken, opts), 7, 84, 76, {
    font: "sm",
    tone: "white",
    level: 0.9,
    maxLines: 3,
  });

  // Chat log (last 2 messages)
  const recent = (opts.chat ?? []).slice(-2);
  if (recent.length === 0) {
    drawText(m, "TYPE BELOW TO TALK TO PEPE", 6, 108, {
      font: "sm",
      tone: "dim",
      level: 0.5,
      maxWidth: 80,
    });
  } else {
    recent.forEach((msg, i) => {
      const y = 108 + i * 7;
      const tone: Tone = msg.role === "user" ? "amber" : "cyan";
      const prefix = msg.role === "user" ? "YOU" : msg.role === "assistant" ? "PEP" : "SYS";
      drawText(m, `${prefix} ${msg.text}`, 6, y, {
        font: "sm",
        tone,
        level: 0.78,
        maxWidth: 80,
      });
    });
  }

  // ── Chat input strip across bottom (rows 128-140) ────────────────────────
  drawPanel(
    m,
    DESK_CHAT_INPUT_FRAME.x,
    DESK_CHAT_INPUT_FRAME.y,
    DESK_CHAT_INPUT_FRAME.w,
    DESK_CHAT_INPUT_FRAME.h,
    { tone: "blue", level: 0.5, active: opts.cursorOn ?? false },
  );
  drawText(m, "PEPE>", DESK_CHAT_INPUT_FRAME.x + 4, DESK_CHAT_INPUT_FRAME.y + 3, {
    font: "sm",
    tone: "cyan",
    level: 0.95,
  });
  drawText(m, "ASK PEPE OR TYPE A COMMAND", DESK_CHAT_INPUT_FRAME.x + 28, DESK_CHAT_INPUT_FRAME.y + 3, {
    font: "sm",
    tone: "dim",
    level: opts.draft && opts.draft.length > 0 ? 0.0 : 0.55,
    maxWidth: 150,
  });
  // Send hint badge on the right of the input strip
  drawBadge(m, DESK_CHAT_INPUT_FRAME.x + DESK_CHAT_INPUT_FRAME.w - 22, DESK_CHAT_INPUT_FRAME.y + 1, "SEND", {
    tone: "cyan",
    active: (opts.draft?.trim().length ?? 0) > 0,
    width: 20,
  });

  // ── Selection beam from Pepe eye to active row ───────────────────────────
  if (opts.selectedTokenId) {
    const idx = visible.findIndex((t) => t.tokenId === opts.selectedTokenId);
    if (idx >= 0) {
      const rowY = DESK_TABLE_FIRST_ROW + idx * DESK_ROW_HEIGHT + 3;
      drawBeam(
        m,
        DESK_PEPE_EYE,
        { x: DESK_TABLE_X - 2, y: rowY },
        phase,
        opts.pepeIsSpeaking || phase > 0.62,
      );
    }
  }

  return {
    matrix: m,
    pepeFrame: DESK_PEPE_FRAME,
    chatInputFrame: DESK_CHAT_INPUT_FRAME,
    cols: DESK_COLS,
    rows: DESK_ROWS,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry — picks layout
// ────────────────────────────────────────────────────────────────────────────

export function renderBoard(
  rows: ActivityToken[],
  opts: RenderBoardOptions,
): RenderBoardResult {
  const layout = opts.layout ?? "mobile";
  return layout === "desktop" ? renderDesktop(rows, opts) : renderMobile(rows, opts);
}

export type { Cell, Matrix };
