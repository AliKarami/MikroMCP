import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const W = 1200;
const H = 630;

// Brand tokens (mirrors theme.css)
const BG = "#0B0E11";
const BRAND = "#14B8A6";
const BRAND_GLOW = "#2DD4BF";
const BRAND_DEEP = "#0F766E";
const ACCENT = "#EA580C";
const TEXT = "#E6EDF3";
const DIM = "#9BA8B4";
const BORDER = "#293239";

const logoPath = resolve(root, "public/assets/MikroMCP-logo-square.png");
const logo = await sharp(logoPath).resize(150, 150).png().toBuffer();
const logoB64 = `data:image/png;base64,${logo.toString("base64")}`;

const svg = `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="32%" cy="30%" r="60%">
      <stop offset="0%" stop-color="${BRAND_DEEP}" stop-opacity="0.30"/>
      <stop offset="55%" stop-color="${BRAND_DEEP}" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="${BG}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="teal" x1="0" y1="0" x2="1" y2="0.4">
      <stop offset="0%" stop-color="${BRAND_GLOW}"/>
      <stop offset="55%" stop-color="${BRAND}"/>
      <stop offset="100%" stop-color="${BRAND_DEEP}"/>
    </linearGradient>
    <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse">
      <circle cx="1.5" cy="1.5" r="1.5" fill="#16323a" fill-opacity="0.5"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#dots)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- topology accent lines -->
  <g stroke="${BORDER}" stroke-width="1.5" opacity="0.7" fill="none">
    <path d="M 760 470 L 880 250 L 1040 300 L 1120 150"/>
    <path d="M 880 250 L 980 430"/>
  </g>
  <g fill="${BRAND}">
    <circle cx="760" cy="470" r="5"/>
    <circle cx="880" cy="250" r="6"/>
    <circle cx="1040" cy="300" r="5"/>
    <circle cx="1120" cy="150" r="6"/>
    <circle cx="980" cy="430" r="5"/>
  </g>

  <!-- logo + wordmark -->
  <image href="${logoB64}" x="80" y="78" width="86" height="86"/>
  <text x="184" y="138" font-family="Inter, Arial, sans-serif" font-size="40" font-weight="700" fill="${TEXT}">MikroMCP</text>

  <!-- eyebrow -->
  <text x="82" y="250" font-family="'JetBrains Mono', monospace" font-size="22" letter-spacing="2" fill="${BRAND_GLOW}">MODEL CONTEXT PROTOCOL · ROUTEROS 7.X</text>

  <!-- headline -->
  <text x="80" y="330" font-family="Inter, Arial, sans-serif" font-size="66" font-weight="700" fill="${TEXT}">AI-native network</text>
  <text x="80" y="404" font-family="Inter, Arial, sans-serif" font-size="66" font-weight="700" fill="${TEXT}">automation for</text>
  <text x="80" y="478" font-family="Inter, Arial, sans-serif" font-size="66" font-weight="700" fill="url(#teal)">MikroTik RouterOS</text>

  <!-- subline -->
  <text x="82" y="540" font-family="Inter, Arial, sans-serif" font-size="26" fill="${DIM}">Expose RouterOS as 117 typed, auditable MCP tools.</text>

  <!-- trust chips -->
  <text x="82" y="585" font-family="'JetBrains Mono', monospace" font-size="19" fill="${DIM}">117 tools  ·  MIT  ·  dry-run + rollback  ·  RBAC + audit</text>

  <!-- accent underline bar -->
  <rect x="82" y="497" width="430" height="4" rx="2" fill="${ACCENT}"/>
</svg>
`;

await sharp(Buffer.from(svg)).png().toFile(resolve(root, "public/og-image.png"));
console.log("Wrote public/og-image.png (1200x630)");
