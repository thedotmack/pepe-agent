import {
  DotMatrixKit,
  type Cell,
  type Matrix,
  type Tone,
} from "./dot-matrix-ui-kit";
import type {
  ActivityToken,
  FeedStatus,
} from "@/components/dot-board/use-activity-feed";

const {
  createMatrix,
  drawDottedField,
  drawText,
  drawPanel,
  drawBadge,
  drawLine,
  setDot,
} = DotMatrixKit;

export type PepeFrame = { x: number; y: number; w: number; h: number };

export type RenderBoardOptions = {
  status: FeedStatus;
  selectedTokenId?: string;
  pepeIsSpeaking: boolean;
  /** Animation phase 0..1 — used to pulse the beam. */
  beamPhase?: number;
};

export type RenderBoardResult = {
  matrix: Matrix;
  pepeFrame: PepeFrame;
};

const ROW_HEIGHT = 14;
const ROW_LIST_TOP = 16;
const ROW_LIST_BOTTOM = 138;
const MAX_VISIBLE = Math.floor((ROW_LIST_BOTTOM - ROW_LIST_TOP) / ROW_HEIGHT);

const HABITAT: PepeFrame = { x: 4, y: 140, w: 100, h: 48 };
// Pepe eye anchor — center top of habitat.
const PEPE_EYE = { x: HABITAT.x + Math.floor(HABITAT.w / 2), y: HABITAT.y + 2 };

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

function formatPrice(p: number): string {
  if (!isFinite(p) || p <= 0) return "0";
  if (p < 0.01) return p.toExponential(1);
  if (p < 1) return p.toFixed(4);
  if (p < 100) return p.toFixed(2);
  return Math.round(p).toString();
}

function formatGain(g: number): string {
  if (!isFinite(g)) return "0%";
  return `${g >= 0 ? "+" : ""}${(g * 100).toFixed(0)}%`;
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

    // walk toward target (Bresenham-ish stair-step)
    if (xRem > 0 && (yRem === 0 || (i % 3 === 0))) {
      x += sx;
      xRem -= 1;
    } else if (yRem > 0) {
      y += sy;
      yRem -= 1;
    } else if (xRem > 0) {
      x += sx;
      xRem -= 1;
    }

    // also step the OFF dot in between to keep cadence
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

export function renderBoard(
  rows: ActivityToken[],
  opts: RenderBoardOptions,
): RenderBoardResult {
  const m = createMatrix();

  // Faint background field for atmosphere
  drawDottedField(m, 13);

  // ── Header (rows 0-12) ───────────────────────────────────────────────────
  drawText(m, "PEPE BOARD", 6, 4, { font: "lg", tone: "cyan", level: 0.95 });
  const sTone = statusTone(opts.status);
  const statusLabel = opts.status.toUpperCase();
  drawBadge(m, 78, 4, statusLabel, {
    tone: sTone,
    active: opts.status === "live",
    width: 26,
  });

  // ── Row list (rows 16-138) ───────────────────────────────────────────────
  const visible = rows.slice(0, MAX_VISIBLE);

  if (visible.length === 0) {
    drawText(m, "WAITING FOR FEED", 18, 70, {
      font: "md",
      tone: "dim",
      level: 0.7,
    });
  } else {
    visible.forEach((t, i) => {
      const y = ROW_LIST_TOP + i * ROW_HEIGHT;
      const active = t.tokenId === opts.selectedTokenId;
      drawPanel(m, 4, y, 100, ROW_HEIGHT - 1, {
        tone: "blue",
        level: active ? 0.7 : 0.32,
        active,
      });

      const sym = (t.symbol ?? "??").toString();
      drawText(m, sym.slice(0, 6), 7, y + 3, {
        font: "md",
        tone: "white",
        level: 0.95,
        maxWidth: 30,
      });

      drawText(m, formatPrice(t.price ?? 0), 38, y + 4, {
        font: "sm",
        tone: "cyan",
        level: 0.85,
        maxWidth: 24,
      });

      const gain = t.fiveMinGain ?? 0;
      const gainTone: Tone = gain >= 0 ? "cyan" : "amber";
      drawText(m, formatGain(gain), 64, y + 4, {
        font: "sm",
        tone: gainTone,
        level: 0.9,
        maxWidth: 18,
      });

      // Buy-pressure bar (right side of row, 16 dots wide)
      const bp = Math.min(1, Math.max(0, t.buyPressure5m ?? 0));
      const barW = Math.round(bp * 16);
      drawLine(m, 84, y + 6, barW, "cyan", 0.85);
      drawLine(m, 84 + barW, y + 6, 16 - barW, "ghost", 0.3);
    });
  }

  // ── Pepe HQ habitat panel (rows 140-187) ─────────────────────────────────
  drawPanel(m, HABITAT.x, HABITAT.y, HABITAT.w, HABITAT.h, {
    tone: "blue",
    level: 0.4,
  });
  drawText(m, "PEPE HQ", HABITAT.x + 4, HABITAT.y + 3, {
    font: "sm",
    tone: "cyan",
    level: 0.85,
  });

  // Pepe status footer line
  drawText(
    m,
    opts.pepeIsSpeaking ? "PEPE: TRADING" : "PEPE: WATCHING",
    HABITAT.x + 4,
    HABITAT.y + HABITAT.h - 8,
    {
      font: "sm",
      tone: opts.pepeIsSpeaking ? "amber" : "dim",
      level: 0.8,
    },
  );

  // ── Selection beam from Pepe eye to active row ───────────────────────────
  if (opts.selectedTokenId) {
    const idx = visible.findIndex((t) => t.tokenId === opts.selectedTokenId);
    if (idx >= 0) {
      const rowY = ROW_LIST_TOP + idx * ROW_HEIGHT + Math.floor(ROW_HEIGHT / 2);
      const target = { x: 100, y: rowY };
      drawBeam(m, PEPE_EYE, target, opts.beamPhase ?? 0, opts.pepeIsSpeaking);
    }
  }

  return { matrix: m, pepeFrame: HABITAT };
}

// re-export for consumers that want the cell type
export type { Cell, Matrix };
