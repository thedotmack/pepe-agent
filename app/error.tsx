"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Pepe HQ error]", error);
  }, [error]);

  return (
    <main
      style={{
        minHeight: "100svh",
        width: "100%",
        background: "#03070d",
        color: "#41ebe0",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        display: "grid",
        placeItems: "center",
        gap: 16,
      }}
    >
      <div
        style={{
          display: "grid",
          placeItems: "center",
          gap: 16,
          textAlign: "center",
          padding: 24,
        }}
      >
        <p
          style={{
            letterSpacing: "0.2em",
            fontSize: 14,
            textTransform: "uppercase",
            color: "#ff9a36",
          }}
        >
          Pepe HQ offline
        </p>
        <button
          onClick={() => reset()}
          style={{
            padding: "10px 18px",
            border: "1px solid #41ebe0",
            background: "transparent",
            color: "#ecf8ff",
            fontFamily: "inherit",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            fontSize: 12,
            cursor: "pointer",
            borderRadius: 999,
          }}
        >
          Tap to retry
        </button>
      </div>
    </main>
  );
}
