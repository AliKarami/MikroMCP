import sharp from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const W = 1200;
const H = 630;

// Brand tokens (mirrors src/styles/theme.css)
const BG = "#07090F";
const C1 = "#2DD4BF";
const C2 = "#22A7E0";
const C3 = "#4F6BF6";
const C4 = "#8B5CF6";
const TEXT = "#EDF1F7";
const DIM = "#C4CEE4";
const MUTE = "#8E9AB4";
const BORDER = "#212940";
const BORDER_STRONG = "#333D5E";

// The hero fan: rounded squares pivoting from one corner, sampled across the ramp.
const FAN = [
  { a: 0, from: C1, to: C2, o: 1 },
  { a: -13, from: C2, to: "#3D8AEE", o: 0.95 },
  { a: -26, from: "#3D8AEE", to: C3, o: 0.9 },
  { a: -39, from: C3, to: "#6E5DF8", o: 0.85 },
  { a: -52, from: "#6E5DF8", to: C4, o: 0.8 },
];

// Read the tool count from the single source of truth rather than restating it here.
const content = readFileSync(resolve(root, "src/data/content.ts"), "utf-8");
const toolCount = content.match(/toolCount:\s*(\d+)/)?.[1];
if (!toolCount) throw new Error("could not read toolCount from src/data/content.ts");

const logoPath = resolve(root, "public/assets/MikroMCP-logo-square.png");
const logo = await sharp(logoPath).resize(150, 150).png().toBuffer();
const logoB64 = `data:image/png;base64,${logo.toString("base64")}`;

const svg = `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="head" x1="0" y1="0" x2="1" y2="0.3">
      <stop offset="0%" stop-color="${C1}"/>
      <stop offset="38%" stop-color="${C2}"/>
      <stop offset="70%" stop-color="${C3}"/>
      <stop offset="100%" stop-color="${C4}"/>
    </linearGradient>
    <radialGradient id="wash" cx="78%" cy="6%" r="72%">
      <stop offset="0%" stop-color="${C4}" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="${BG}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="wash2" cx="16%" cy="0%" r="60%">
      <stop offset="0%" stop-color="${C1}" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="${BG}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0%" stop-color="#10225C"/>
      <stop offset="55%" stop-color="#0B1338"/>
      <stop offset="100%" stop-color="${BG}"/>
    </linearGradient>
    ${FAN.map(
      (c, i) => `<linearGradient id="f${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${c.from}"/><stop offset="100%" stop-color="${c.to}"/></linearGradient>`,
    ).join("")}
  </defs>

  <rect width="${W}" height="${H}" fill="url(#ground)"/>
  <rect width="${W}" height="${H}" fill="url(#wash)"/>
  <rect width="${W}" height="${H}" fill="url(#wash2)"/>

  <!-- node/edge mesh -->
  <g stroke="url(#head)" fill="none" stroke-width="1.1" opacity=".33">
    <path d="M700 470 L820 250 L980 300 L1120 150 M820 250 L940 430 M980 300 L1120 470"/>
  </g>
  <g fill="url(#head)" opacity=".8">
    <circle cx="700" cy="470" r="5"/><circle cx="820" cy="250" r="6"/>
    <circle cx="980" cy="300" r="5"/><circle cx="1120" cy="150" r="6"/>
    <circle cx="940" cy="430" r="5"/>
  </g>

  <!-- fan -->
  <g transform="translate(760 40) scale(0.86)">
    ${[...FAN]
      .reverse()
      .map((c, ri) => {
        const i = FAN.length - 1 - ri;
        return `<rect x="150" y="150" width="200" height="200" rx="46" fill="url(#f${i})" opacity="${c.o}" transform="rotate(${c.a} 160 350)"/>`;
      })
      .join("")}
  </g>

  <!-- logo + wordmark -->
  <image href="${logoB64}" x="80" y="70" width="66" height="66"/>
  <text x="164" y="116" font-family="Inter, Arial, sans-serif" font-size="32" font-weight="700" fill="${TEXT}">MikroMCP</text>

  <!-- eyebrow -->
  <rect x="82" y="212" width="26" height="4" rx="2" fill="url(#head)"/>
  <text x="120" y="220" font-family="'JetBrains Mono', monospace" font-size="17" letter-spacing="2.6" fill="${DIM}">MODEL CONTEXT PROTOCOL · ROUTEROS 7.X</text>

  <!-- headline -->
  <text x="80" y="298" font-family="Inter, Arial, sans-serif" font-size="56" font-weight="700" fill="${TEXT}">Open Source</text>
  <text x="80" y="366" font-family="Inter, Arial, sans-serif" font-size="56" font-weight="700" fill="url(#head)">MikroTik MCP Server</text>
  <text x="80" y="434" font-family="Inter, Arial, sans-serif" font-size="56" font-weight="700" fill="${TEXT}">for RouterOS</text>

  <!-- subline -->
  <text x="82" y="490" font-family="Inter, Arial, sans-serif" font-size="23" fill="${DIM}">Expose RouterOS as ${toolCount} typed, auditable MCP tools.</text>

  <!-- footer rule + facts -->
  <line x1="80" y1="534" x2="1120" y2="534" stroke="${BORDER_STRONG}"/>
  <text x="82" y="570" font-family="'JetBrains Mono', monospace" font-size="16" fill="${MUTE}">${toolCount} tools  ·  MIT  ·  dry-run + rollback  ·  RBAC + audit</text>
  <text x="1118" y="570" text-anchor="end" font-family="'JetBrains Mono', monospace" font-size="16" fill="${MUTE}">mikromcp.com</text>
</svg>
`;

await sharp(Buffer.from(svg)).png().toFile(resolve(root, "public/og-image.png"));
console.log(`Wrote public/og-image.png (${W}x${H}, ${toolCount} tools)`);
