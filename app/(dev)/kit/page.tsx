"use client";

import { useMemo } from "react";
import {
  buildUIKitScreen,
  DotMatrixBoard,
  useDitheredPhoto,
} from "@/lib/dot-matrix/dot-matrix-ui-kit";
import { DotMatrixCanvas } from "@/components/dot-board/DotMatrixCanvas";

/**
 * Side-by-side sanity check: the same kit screen rendered as
 * the DOM-based DotMatrixBoard (left) and the canvas-based
 * DotMatrixCanvas (right). They should look identical.
 */
export default function KitDevPage() {
  const photoDots = useDitheredPhoto(null, 30, 24, 7);
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
        gap: 24,
        gridAutoFlow: "row",
      }}
    >
      <h1 style={{ fontFamily: "monospace", color: "#41ebe0" }}>
        DOT KIT — DOM vs CANVAS
      </h1>
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        <div>
          <p
            style={{
              fontFamily: "monospace",
              color: "#41ebe0",
              fontSize: 12,
              marginBottom: 8,
            }}
          >
            DOM (kit)
          </p>
          <DotMatrixBoard matrix={matrix} label="Kit DOM" />
        </div>
        <div>
          <p
            style={{
              fontFamily: "monospace",
              color: "#41ebe0",
              fontSize: 12,
              marginBottom: 8,
            }}
          >
            Canvas (live renderer)
          </p>
          <div
            style={{
              borderRadius: 30,
              background: "#010306",
              padding: 12,
              boxShadow: "0 24px 80px rgba(0,0,0,0.72)",
              width: "fit-content",
            }}
          >
            <DotMatrixCanvas matrix={matrix} scale={1} />
          </div>
        </div>
      </div>
    </main>
  );
}
