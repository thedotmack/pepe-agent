const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#03070d"/>
  <circle cx="32" cy="33" r="22" fill="#41ebe0"/>
  <circle cx="24" cy="27" r="7" fill="#ecf8ff"/>
  <circle cx="40" cy="27" r="7" fill="#ecf8ff"/>
  <circle cx="26" cy="28" r="3" fill="#08121e"/>
  <circle cx="42" cy="28" r="3" fill="#08121e"/>
  <path d="M18 43c9 7 20 7 28 0" fill="none" stroke="#ff9a36" stroke-width="5" stroke-linecap="round"/>
</svg>`;

export function GET() {
  return new Response(icon, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
