"use client";

import { useEffect, useRef } from "react";
import { DOT_BOARD, COLORS } from "@/lib/dot-matrix/dot-matrix-ui-kit";
import type { Cell } from "@/lib/dot-matrix/dot-matrix-ui-kit";

export function DotMatrixCanvas({
  matrix,
  scale = 1,
  dotSize = DOT_BOARD.dotSize,
  gap = DOT_BOARD.gap,
}: {
  matrix: Cell[][];
  scale?: number;
  dotSize?: number;
  gap?: number;
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

    const pixel = dotSize + gap;
    const W = cols * pixel * scale;
    const H = rows * pixel * scale;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    for (let y = 0; y < rows; y++) {
      const row = matrix[y];
      if (!row) continue;
      for (let x = 0; x < cols; x++) {
        const cell = row[x];
        if (!cell) continue;
        if (cell.tone === "off" && cell.level === 0) continue;
        const color = COLORS[cell.tone] ?? COLORS.off;
        ctx.globalAlpha = Math.max(0.18, cell.level);
        ctx.fillStyle = color;
        const px = x * pixel * scale;
        const py = y * pixel * scale;
        const size = dotSize * scale;
        ctx.fillRect(px, py, size, size);
      }
    }
    ctx.globalAlpha = 1;
  }, [matrix, scale, dotSize, gap]);

  return <canvas ref={ref} aria-label="Live trading dot-matrix board" />;
}
