"use client";

import { useEffect, useRef } from "react";
import { DOT_BOARD, COLORS } from "@/lib/dot-matrix/dot-matrix-ui-kit";
import type { Cell } from "@/lib/dot-matrix/dot-matrix-ui-kit";

const PIXEL = DOT_BOARD.dotSize + DOT_BOARD.gap;

export function DotMatrixCanvas({
  matrix,
  scale = 1,
}: {
  matrix: Cell[][];
  scale?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const rows = matrix.length;
    const cols = matrix[0]?.length ?? 0;
    if (cols === 0 || rows === 0) return;

    const W = cols * PIXEL * scale;
    const H = rows * PIXEL * scale;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const cell = matrix[y][x];
        if (cell.tone === "off" && cell.level === 0) continue;
        const color = COLORS[cell.tone] ?? COLORS.off;
        ctx.globalAlpha = Math.max(0.18, cell.level);
        ctx.fillStyle = color;
        const px = x * PIXEL * scale;
        const py = y * PIXEL * scale;
        const size = DOT_BOARD.dotSize * scale;
        ctx.fillRect(px, py, size, size);
      }
    }
    ctx.globalAlpha = 1;
  }, [matrix, scale]);

  return <canvas ref={ref} aria-label="Live trading dot-matrix board" />;
}
