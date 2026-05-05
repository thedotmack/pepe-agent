"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * dot-matrix-ui-kit.tsx
 *
 * Typed port of DotMatrixMobileUIKit.jsx.
 *
 * Core rules:
 * - Integer dot sizing only: no subpixel LED sizes or gaps.
 * - UI elements are drawn into one logical 108x192 LED matrix.
 * - Text, cards, icons, photos, rails, dividers, and buttons are all dots.
 */

export const DOT_BOARD = Object.freeze({
  cols: 108,
  rows: 192,
  dotSize: 2,
  gap: 1,
});

export const DOT_BOARD_DESKTOP = Object.freeze({
  cols: 240,
  rows: 144,
  dotSize: 2,
  gap: 1,
});

export type BoardDims = { cols: number; rows: number; dotSize: number; gap: number };

function matrixCols(matrix: Matrix): number {
  return matrix[0]?.length ?? DOT_BOARD.cols;
}

function matrixRows(matrix: Matrix): number {
  return matrix.length || DOT_BOARD.rows;
}

export const COLORS = Object.freeze({
  off: "rgba(8, 18, 30, 0.78)",
  ghost: "rgba(30, 57, 86, 0.42)",
  dim: "rgb(61 95 134)",
  blue: "rgb(68 163 255)",
  cyan: "rgb(65 235 224)",
  amber: "rgb(255 154 54)",
  white: "rgb(236 248 255)",
});

export type Tone = keyof typeof COLORS;
export type Cell = { tone: Tone; level: number };
export type Matrix = Cell[][];

type GlyphTable = Record<string, string[]>;

const GLYPHS_3X5: GlyphTable = {
  A: ["010", "101", "111", "101", "101"],
  B: ["110", "101", "110", "101", "110"],
  C: ["011", "100", "100", "100", "011"],
  D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"],
  F: ["111", "100", "110", "100", "100"],
  G: ["011", "100", "101", "101", "011"],
  H: ["101", "101", "111", "101", "101"],
  I: ["111", "010", "010", "010", "111"],
  J: ["001", "001", "001", "101", "010"],
  K: ["101", "101", "110", "101", "101"],
  L: ["100", "100", "100", "100", "111"],
  M: ["101", "111", "111", "101", "101"],
  N: ["101", "111", "111", "111", "101"],
  O: ["010", "101", "101", "101", "010"],
  P: ["110", "101", "110", "100", "100"],
  Q: ["010", "101", "101", "111", "011"],
  R: ["110", "101", "110", "101", "101"],
  S: ["011", "100", "010", "001", "110"],
  T: ["111", "010", "010", "010", "010"],
  U: ["101", "101", "101", "101", "111"],
  V: ["101", "101", "101", "101", "010"],
  W: ["101", "101", "111", "111", "101"],
  X: ["101", "101", "010", "101", "101"],
  Y: ["101", "101", "010", "010", "010"],
  Z: ["111", "001", "010", "100", "111"],
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["110", "001", "010", "100", "111"],
  "3": ["110", "001", "010", "001", "110"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "110", "001", "110"],
  "6": ["011", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "110"],
  " ": ["0", "0", "0", "0", "0"],
  ".": ["0", "0", "0", "0", "1"],
  ":": ["0", "1", "0", "1", "0"],
  "-": ["000", "000", "111", "000", "000"],
  "/": ["001", "001", "010", "100", "100"],
  "#": ["101", "111", "101", "111", "101"],
  "$": ["111", "110", "011", "101", "111"],
  "%": ["101", "001", "010", "100", "101"],
  "+": ["000", "010", "111", "010", "000"],
  "!": ["1", "1", "1", "0", "1"],
  "?": ["110", "001", "010", "000", "010"],
};

const GLYPHS_5X7: GlyphTable = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  " ": ["000", "000", "000", "000", "000", "000", "000"],
  ".": ["0", "0", "0", "0", "0", "1", "1"],
  ":": ["0", "1", "1", "0", "1", "1", "0"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "/": ["00001", "00001", "00010", "00100", "01000", "10000", "10000"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
  "$": ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  "%": ["11001", "11010", "00100", "01000", "10110", "00110", "00000"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "!": ["1", "1", "1", "1", "1", "0", "1"],
  "?": ["1110", "0001", "0001", "0110", "0100", "0000", "0100"],
};

export type FontName = "sm" | "md" | "lg";
type Font = {
  glyphs: GlyphTable;
  scale: number;
  letterGap: number;
  lineHeight: number;
};

export const FONTS: Record<FontName, Font> = Object.freeze({
  sm: { glyphs: GLYPHS_3X5, scale: 1, letterGap: 1, lineHeight: 7 },
  md: { glyphs: GLYPHS_5X7, scale: 1, letterGap: 1, lineHeight: 10 },
  lg: { glyphs: GLYPHS_5X7, scale: 2, letterGap: 1, lineHeight: 18 },
}) as Record<FontName, Font>;

export const ICONS: Record<string, string[]> = {
  search: ["01110", "10001", "10001", "10001", "01110", "00010", "00001"],
  home: ["00100", "01110", "11111", "10101", "10101", "11111"],
  memory: ["01110", "10001", "10101", "10001", "10101", "10001", "01110"],
  plus: ["00100", "00100", "11111", "00100", "00100"],
  chart: ["10000", "10100", "10101", "11101", "00101", "00111"],
  user: ["01110", "10001", "10001", "01110", "00100", "01110", "10001"],
  bell: ["00100", "01110", "01110", "01110", "11111", "00100"],
  photo: ["111111", "100001", "101101", "100001", "101011", "111111"],
  spark: ["00100", "10101", "01110", "11111", "01110", "10101", "00100"],
  chevron: ["100", "010", "001", "010", "100"],
};

const BAYER_4: number[][] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((value) => (value + 0.5) / 16));

export function createMatrix(cols: number = DOT_BOARD.cols, rows: number = DOT_BOARD.rows): Matrix {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ tone: "off" as Tone, level: 0 })),
  );
}

export function setDot(
  matrix: Matrix,
  x: number,
  y: number,
  tone: Tone = "blue",
  level: number = 1,
): void {
  const px = Math.round(x);
  const py = Math.round(y);
  const cols = matrixCols(matrix);
  const rows = matrixRows(matrix);

  if (px < 0 || py < 0 || px >= cols || py >= rows) return;

  const current = matrix[py][px];
  if (level >= current.level) matrix[py][px] = { tone, level };
}

export function drawLine(
  matrix: Matrix,
  x: number,
  y: number,
  width: number,
  tone: Tone = "dim",
  level: number = 0.65,
): void {
  for (let ix = x; ix < x + width; ix += 1) setDot(matrix, ix, y, tone, level);
}

export function drawVerticalLine(
  matrix: Matrix,
  x: number,
  y: number,
  height: number,
  tone: Tone = "dim",
  level: number = 0.65,
): void {
  for (let iy = y; iy < y + height; iy += 1) setDot(matrix, x, iy, tone, level);
}

export function drawDottedField(matrix: Matrix, density: number = 11): void {
  const cols = matrixCols(matrix);
  const rows = matrixRows(matrix);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if ((x * 3 + y * 5) % density === 0) setDot(matrix, x, y, "ghost", 0.13);
    }
  }
}

export type PanelOptions = { tone?: Tone; level?: number; active?: boolean };

export function drawPanel(
  matrix: Matrix,
  x: number,
  y: number,
  width: number,
  height: number,
  options: PanelOptions = {},
): void {
  const { tone = "blue", level = 0.48, active = false } = options;
  const railTone: Tone = active ? "cyan" : tone;
  const railLevel = active ? 0.86 : level;

  drawLine(matrix, x + 2, y, width - 4, railTone, railLevel);
  drawLine(matrix, x + 2, y + height - 1, width - 4, tone, level * 0.72);
  drawVerticalLine(matrix, x, y + 2, height - 4, tone, level * 0.74);
  drawVerticalLine(matrix, x + width - 1, y + 2, height - 4, tone, level * 0.74);

  setDot(matrix, x + 1, y + 1, railTone, railLevel);
  setDot(matrix, x + width - 2, y + 1, railTone, railLevel);
  setDot(matrix, x + 1, y + height - 2, tone, level * 0.74);
  setDot(matrix, x + width - 2, y + height - 2, tone, level * 0.74);
}

export function fillSparse(
  matrix: Matrix,
  x: number,
  y: number,
  width: number,
  height: number,
  tone: Tone = "ghost",
  level: number = 0.16,
  density: number = 5,
): void {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      if ((px + py) % density === 0) setDot(matrix, px, py, tone, level);
    }
  }
}

function normalizeText(input: unknown): string {
  return String(input)
    .replace(/[—–]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .toUpperCase()
    .split("")
    .map((char) => (GLYPHS_5X7[char] || GLYPHS_3X5[char] ? char : " "))
    .join("")
    .replace(/ +/g, " ");
}

function getFont(fontName: FontName = "md"): Font {
  return FONTS[fontName] || FONTS.md;
}

function glyphFor(char: string, font: Font): string[] {
  return font.glyphs[char] || font.glyphs["?"];
}

export type TextOptions = {
  font?: FontName;
  tone?: Tone;
  level?: number;
  maxWidth?: number;
  letterGap?: number;
  scale?: number;
};

export function measureText(
  text: unknown,
  fontName: FontName = "md",
  override: Partial<Font> = {},
): number {
  const font: Font = { ...getFont(fontName), ...override };
  const chars = Array.from(normalizeText(text));

  return chars.reduce((total, char, index) => {
    const glyph = glyphFor(char, font);
    const glyphWidth = glyph[0].length * font.scale;
    const gap = index === 0 ? 0 : font.letterGap * font.scale;
    return total + glyphWidth + gap;
  }, 0);
}

export function truncateText(
  text: unknown,
  maxWidth: number,
  fontName: FontName = "md",
  override: Partial<Font> = {},
): string {
  const normalized = normalizeText(text).trim();
  let result = "";

  for (const char of normalized) {
    const next = result + char;
    if (measureText(next, fontName, override) > maxWidth) break;
    result = next;
  }

  return result.trim();
}

export function drawText(
  matrix: Matrix,
  text: unknown,
  x: number,
  y: number,
  options: TextOptions = {},
): number {
  const {
    font: fontName = "md",
    tone = "white",
    level = 1,
    maxWidth,
    letterGap,
    scale,
  } = options;
  const font: Font = {
    ...getFont(fontName),
    ...(letterGap === undefined ? null : { letterGap }),
    ...(scale === undefined ? null : { scale }),
  };
  const normalized = maxWidth ? truncateText(text, maxWidth, fontName, font) : normalizeText(text);
  let cursorX = x;

  for (const char of normalized) {
    const glyph = glyphFor(char, font);

    glyph.forEach((row, gy) => {
      row.split("").forEach((active, gx) => {
        if (active !== "1") return;

        for (let sy = 0; sy < font.scale; sy += 1) {
          for (let sx = 0; sx < font.scale; sx += 1) {
            setDot(matrix, cursorX + gx * font.scale + sx, y + gy * font.scale + sy, tone, level);
          }
        }
      });
    });

    cursorX += glyph[0].length * font.scale + font.letterGap * font.scale;
  }

  return cursorX - x;
}

export type WrappedTextOptions = TextOptions & { maxLines?: number };

export function drawWrappedText(
  matrix: Matrix,
  text: unknown,
  x: number,
  y: number,
  width: number,
  options: WrappedTextOptions = {},
): void {
  const { font: fontName = "md", maxLines = 2 } = options;
  const font = getFont(fontName);
  const words = normalizeText(text).split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (measureText(next, fontName) <= width) {
      current = next;
      continue;
    }

    if (current) lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }

  if (current && lines.length < maxLines) lines.push(current);

  lines.forEach((line, index) => {
    drawText(matrix, line, x, y + index * font.lineHeight, options);
  });
}

export type IconOptions = { tone?: Tone; level?: number; scale?: number };

export function drawIcon(
  matrix: Matrix,
  name: string,
  x: number,
  y: number,
  options: IconOptions = {},
): void {
  const { tone = "cyan", level = 0.9, scale = 1 } = options;
  const icon = ICONS[name] || ICONS.spark;

  icon.forEach((row, gy) => {
    row.split("").forEach((active, gx) => {
      if (active !== "1") return;

      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          setDot(matrix, x + gx * scale + sx, y + gy * scale + sy, tone, level);
        }
      }
    });
  });
}

export type BadgeOptions = { tone?: Tone; active?: boolean; width?: number };

export function drawBadge(
  matrix: Matrix,
  x: number,
  y: number,
  label: string,
  options: BadgeOptions = {},
): void {
  const { tone = "blue", active = false, width = Math.max(18, measureText(label, "sm") + 6) } = options;
  drawPanel(matrix, x, y, width, 11, { tone, level: active ? 0.72 : 0.38, active });
  if (active) fillSparse(matrix, x + 2, y + 2, width - 4, 7, tone, 0.14, 3);
  drawText(matrix, label, x + 3, y + 3, {
    font: "sm",
    tone: active ? "white" : tone,
    level: active ? 0.94 : 0.68,
    maxWidth: width - 6,
  });
}

export type ButtonOptions = { width?: number; active?: boolean; tone?: Tone };

export function drawButton(
  matrix: Matrix,
  x: number,
  y: number,
  label: string,
  icon: string | null | undefined,
  options: ButtonOptions = {},
): void {
  const { width = 30, active = false, tone = "blue" } = options;
  drawPanel(matrix, x, y, width, 16, { tone, level: active ? 0.7 : 0.38, active });
  if (icon) drawIcon(matrix, icon, x + 4, y + 4, { tone: active ? "cyan" : tone, level: active ? 0.9 : 0.58 });
  drawText(matrix, label, x + (icon ? 13 : 4), y + 5, {
    font: "sm",
    tone: active ? "white" : "dim",
    level: active ? 0.9 : 0.62,
    maxWidth: width - (icon ? 16 : 8),
  });
}

export type PhotoDot = { tone?: Tone; level?: number } | null | undefined;
export type PhotoDots = PhotoDot[][];

export type PhotoOptions = { frame?: boolean; fallbackTone?: Tone };

export function drawPhoto(
  matrix: Matrix,
  x: number,
  y: number,
  width: number,
  height: number,
  photoDots: PhotoDots | undefined,
  options: PhotoOptions = {},
): void {
  const { frame = true, fallbackTone = "blue" } = options;

  if (frame) drawPanel(matrix, x, y, width, height, { tone: "dim", level: 0.38 });

  const innerX = frame ? x + 2 : x;
  const innerY = frame ? y + 2 : y;
  const innerW = frame ? width - 4 : width;
  const innerH = frame ? height - 4 : height;

  for (let py = 0; py < innerH; py += 1) {
    for (let px = 0; px < innerW; px += 1) {
      const dot = photoDots?.[py]?.[px];
      if (!dot) continue;
      setDot(matrix, innerX + px, innerY + py, dot.tone || fallbackTone, dot.level ?? 0.7);
    }
  }
}

export type CardOptions = {
  title?: string;
  subtitle?: string;
  meta?: string;
  icon?: string;
  photo?: PhotoDots;
  photoWidth?: number;
  photoHeight?: number;
  active?: boolean;
};

export function drawCard(
  matrix: Matrix,
  x: number,
  y: number,
  width: number,
  height: number,
  options: CardOptions = {},
): void {
  const {
    title,
    subtitle,
    meta,
    icon = "spark",
    photo,
    photoWidth = 30,
    photoHeight = 26,
    active = false,
  } = options;

  drawPanel(matrix, x, y, width, height, { tone: active ? "cyan" : "blue", level: active ? 0.64 : 0.4, active });
  fillSparse(matrix, x + 2, y + 2, width - 4, height - 4, "ghost", active ? 0.14 : 0.1, 6);

  drawIcon(matrix, icon, x + 4, y + 4, { tone: active ? "cyan" : "blue", level: active ? 0.9 : 0.7 });
  drawText(matrix, title ?? "", x + 14, y + 5, {
    font: "sm",
    tone: active ? "white" : "cyan",
    level: active ? 0.92 : 0.72,
    maxWidth: width - 20,
  });
  drawLine(matrix, x + 4, y + 14, width - 8, "ghost", 0.28);

  if (photo) {
    drawPhoto(matrix, x + 5, y + 18, photoWidth, photoHeight, photo, { frame: true });
    drawWrappedText(matrix, subtitle ?? "", x + photoWidth + 10, y + 19, width - photoWidth - 15, {
      font: "md",
      tone: active ? "white" : "cyan",
      level: active ? 0.98 : 0.82,
      maxLines: 2,
    });
    drawText(matrix, meta ?? "", x + photoWidth + 10, y + height - 12, {
      font: "sm",
      tone: "dim",
      level: 0.62,
      maxWidth: width - photoWidth - 15,
    });
    return;
  }

  drawWrappedText(matrix, subtitle ?? "", x + 5, y + 19, width - 10, {
    font: "md",
    tone: active ? "white" : "cyan",
    level: active ? 0.98 : 0.82,
    maxLines: 2,
  });
  drawText(matrix, meta ?? "", x + 5, y + height - 12, {
    font: "sm",
    tone: "dim",
    level: 0.62,
    maxWidth: width - 10,
  });
}

export function drawTopStatus(matrix: Matrix): void {
  drawText(matrix, "9:41", 6, 5, { font: "sm", tone: "white", level: 0.78 });
  drawVerticalLine(matrix, 82, 6, 5, "white", 0.68);
  drawVerticalLine(matrix, 85, 4, 7, "white", 0.68);
  drawLine(matrix, 92, 5, 10, "white", 0.68);
  drawLine(matrix, 92, 10, 10, "white", 0.68);
  drawVerticalLine(matrix, 92, 5, 6, "white", 0.68);
  drawVerticalLine(matrix, 101, 5, 6, "white", 0.68);
  drawVerticalLine(matrix, 103, 7, 2, "white", 0.68);
  drawLine(matrix, 94, 7, 5, "cyan", 0.88);
  drawLine(matrix, 94, 8, 5, "cyan", 0.88);
}

export function drawBottomNav(matrix: Matrix): void {
  drawLine(matrix, 8, 174, 92, "ghost", 0.3);
  drawIcon(matrix, "home", 11, 182, { tone: "cyan", level: 0.9 });
  drawIcon(matrix, "memory", 32, 181, { tone: "dim", level: 0.54 });
  drawIcon(matrix, "plus", 53, 182, { tone: "cyan", level: 0.9 });
  drawIcon(matrix, "chart", 73, 182, { tone: "dim", level: 0.54 });
  drawIcon(matrix, "user", 94, 181, { tone: "dim", level: 0.54 });
}

export function generatePlaceholderPhoto(width: number, height: number, seed: number = 1): PhotoDots {
  const dots: PhotoDots = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => null as PhotoDot),
  );
  const cx = width * 0.5;
  const headY = height * 0.34;
  const bodyY = height * 0.78;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (x - cx) / (width * 0.24);
      const headDy = (y - headY) / (height * 0.26);
      const bodyDx = (x - cx) / (width * 0.42);
      const bodyDy = (y - bodyY) / (height * 0.28);
      const head = dx * dx + headDy * headDy < 1;
      const shoulders = bodyDx * bodyDx + bodyDy * bodyDy < 1;
      const noise = ((x * 13 + y * 17 + seed * 19) % 23) / 23;

      if (!head && !shoulders && noise < 0.87) continue;

      const edgeFade = Math.max(0, 1 - Math.hypot((x - cx) / width, (y - height / 2) / height) * 1.8);
      const level = Math.min(0.95, 0.36 + edgeFade * 0.6 + noise * 0.2);
      const tone: Tone = head ? (level > 0.74 ? "white" : "cyan") : "blue";
      const threshold = BAYER_4[y % 4][x % 4];

      if (level > threshold * 0.85) dots[y][x] = { tone, level };
    }
  }

  return dots;
}

export function imageDataToDitheredDots(
  imageData: ImageData,
  width: number,
  height: number,
): PhotoDots {
  const dots: PhotoDots = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => null as PhotoDot),
  );
  const data = imageData.data;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const a = data[index + 3] / 255;
      const brightness = ((r * 0.299 + g * 0.587 + b * 0.114) / 255) * a;
      const threshold = BAYER_4[y % 4][x % 4];

      if (brightness <= threshold * 0.78) continue;

      dots[y][x] = {
        tone: brightness > 0.78 ? "white" : brightness > 0.5 ? "cyan" : "blue",
        level: Math.min(1, 0.28 + brightness * 0.82),
      };
    }
  }

  return dots;
}

export function useDitheredPhoto(
  src: string | null | undefined,
  width: number,
  height: number,
  seed: number = 1,
): PhotoDots {
  const fallback = useMemo(() => generatePlaceholderPhoto(width, height, seed), [width, height, seed]);
  const [photo, setPhoto] = useState<PhotoDots>(fallback);

  useEffect(() => {
    setPhoto(fallback);
    if (!src || typeof window === "undefined") return undefined;

    let cancelled = false;
    const image = new window.Image();
    image.crossOrigin = "anonymous";

    image.onload = () => {
      if (cancelled) return;

      try {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return;

        context.drawImage(image, 0, 0, width, height);
        const imageData = context.getImageData(0, 0, width, height);
        setPhoto(imageDataToDitheredDots(imageData, width, height));
      } catch {
        setPhoto(fallback);
      }
    };

    image.onerror = () => {
      if (!cancelled) setPhoto(fallback);
    };

    image.src = src;

    return () => {
      cancelled = true;
    };
  }, [src, width, height, seed, fallback]);

  return photo;
}

export function buildUIKitScreen(photoDots: PhotoDots): Matrix {
  const matrix = createMatrix();

  drawDottedField(matrix);
  drawTopStatus(matrix);

  drawIcon(matrix, "spark", 7, 20, { tone: "cyan", level: 0.92, scale: 2 });
  drawText(matrix, "DOT", 25, 19, { font: "lg", tone: "white", level: 0.98 });
  drawText(matrix, "KIT", 65, 19, { font: "lg", tone: "cyan", level: 0.92 });
  drawText(matrix, "MOBILE MATRIX COMPONENTS", 8, 43, {
    font: "sm",
    tone: "dim",
    level: 0.66,
    maxWidth: 92,
  });

  drawPanel(matrix, 6, 54, 96, 33, { tone: "blue", level: 0.42 });
  drawText(matrix, "TYPE SCALE", 10, 59, { font: "sm", tone: "cyan", level: 0.72 });
  drawText(matrix, "LG", 10, 69, { font: "lg", tone: "white", level: 0.96 });
  drawText(matrix, "MEDIUM", 40, 70, { font: "md", tone: "cyan", level: 0.82 });
  drawText(matrix, "SMALL LABEL", 40, 80, { font: "sm", tone: "dim", level: 0.7 });

  drawCard(matrix, 6, 94, 96, 50, {
    title: "PHOTO CARD",
    subtitle: "DITHERED IMAGE REGION",
    meta: "SRC OR GENERATED AVATAR",
    icon: "photo",
    photo: photoDots,
    photoWidth: 34,
    photoHeight: 28,
    active: true,
  });

  drawPanel(matrix, 6, 149, 96, 24, { tone: "blue", level: 0.36 });
  drawText(matrix, "ICONS", 10, 154, { font: "sm", tone: "dim", level: 0.68 });
  drawIcon(matrix, "search", 37, 154, { tone: "cyan", level: 0.8 });
  drawIcon(matrix, "bell", 51, 154, { tone: "blue", level: 0.72 });
  drawIcon(matrix, "memory", 65, 153, { tone: "cyan", level: 0.76 });
  drawIcon(matrix, "chart", 80, 154, { tone: "dim", level: 0.58 });
  drawBadge(matrix, 10, 162, "LIVE", { tone: "cyan", active: true, width: 22 });
  drawBadge(matrix, 36, 162, "CARD", { tone: "blue", width: 24 });
  drawBadge(matrix, 64, 162, "PHOTO", { tone: "blue", width: 29 });

  drawBottomNav(matrix);

  return matrix;
}

export function LedDot({ cell }: { cell: Cell }) {
  const color = COLORS[cell.tone] || COLORS.off;
  const lit = cell.level > 0.36;

  return (
    <span
      aria-hidden="true"
      style={{
        width: DOT_BOARD.dotSize,
        height: DOT_BOARD.dotSize,
        borderRadius: 999,
        backgroundColor: color,
        opacity: cell.tone === "off" ? 0.5 : Math.max(0.18, cell.level),
        boxShadow: lit
          ? `0 0 ${DOT_BOARD.dotSize * 2}px ${color}, 0 0 ${DOT_BOARD.dotSize * 4}px ${color}`
          : "none",
      }}
    />
  );
}

export function DotMatrixBoard({
  matrix,
  label = "Dot matrix mobile UI",
}: {
  matrix: Matrix;
  label?: string;
}) {
  return (
    <section
      aria-label={label}
      style={{
        width: "fit-content",
        overflow: "hidden",
        borderRadius: 30,
        background: "#010306",
        padding: 12,
        boxShadow: "0 24px 80px rgba(0,0,0,0.72)",
      }}
    >
      <div
        role="img"
        aria-label={label}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${DOT_BOARD.cols}, ${DOT_BOARD.dotSize}px)`,
          gridTemplateRows: `repeat(${DOT_BOARD.rows}, ${DOT_BOARD.dotSize}px)`,
          gap: DOT_BOARD.gap,
        }}
      >
        {matrix.flatMap((row, y) =>
          row.map((cell, x) => <LedDot key={`${x}-${y}`} cell={cell} />),
        )}
      </div>
    </section>
  );
}

export function DotMatrixMobileUIKit({ photoSrc }: { photoSrc?: string }) {
  const photoDots = useDitheredPhoto(photoSrc ?? null, 30, 24, 7);
  const matrix = useMemo(() => buildUIKitScreen(photoDots), [photoDots]);

  return (
    <main
      style={{
        minHeight: "100svh",
        width: "100%",
        boxSizing: "border-box",
        display: "grid",
        placeItems: "start center",
        padding: "20px 10px",
        background: "#03070d",
        color: "white",
      }}
    >
      <DotMatrixBoard matrix={matrix} label="Dot matrix mobile UI kit" />
    </main>
  );
}

export const DotMatrixKit = Object.freeze({
  board: DOT_BOARD,
  colors: COLORS,
  fonts: FONTS,
  icons: ICONS,
  createMatrix,
  setDot,
  drawLine,
  drawVerticalLine,
  drawDottedField,
  drawPanel,
  fillSparse,
  drawText,
  drawWrappedText,
  measureText,
  truncateText,
  drawIcon,
  drawBadge,
  drawButton,
  drawPhoto,
  drawCard,
  drawTopStatus,
  drawBottomNav,
  generatePlaceholderPhoto,
  imageDataToDitheredDots,
  useDitheredPhoto,
  buildUIKitScreen,
});

export default DotMatrixMobileUIKit;
