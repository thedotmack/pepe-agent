import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pepe Agent",
  description: "Talk to Pepe — an interactive AI agent with ElevenLabs voice",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
