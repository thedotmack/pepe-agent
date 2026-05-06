export default function Loading() {
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
        letterSpacing: "0.2em",
        fontSize: 14,
        textTransform: "uppercase",
      }}
    >
      <span aria-live="polite">Booting Pepe HQ</span>
    </main>
  );
}
