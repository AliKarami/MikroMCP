import sharp from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const W = 1200;
const H = 630;

// Brand tokens (mirrors src/styles/theme.css)
const BG = "#0A0C0F";
const BRAND_INK = "#4FC3B4";
const TEXT = "#E7ECF1";
const DIM = "#939FAC";
const MUTE = "#7A8794";
const BORDER = "#1B222A";
const BORDER_STRONG = "#2A333D";

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
    <radialGradient id="wash" cx="24%" cy="8%" r="70%">
      <stop offset="0%" stop-color="#14B8A6" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="${BG}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#wash)"/>

  <!-- terminal card -->
  <rect x="700" y="196" width="440" height="238" rx="10" fill="#070910" stroke="${BORDER_STRONG}"/>
  <line x1="700" y1="238" x2="1140" y2="238" stroke="${BORDER}"/>
  <circle cx="722" cy="217" r="4.5" fill="#d9584f"/>
  <circle cx="738" cy="217" r="4.5" fill="#d8a530"/>
  <circle cx="754" cy="217" r="4.5" fill="#3f9e50"/>
  <text x="776" y="222" font-family="'JetBrains Mono', monospace" font-size="14" fill="${MUTE}">claude · core-01</text>
  <text x="722" y="278" font-family="'JetBrains Mono', monospace" font-size="15" fill="${TEXT}">› Show CPU &amp; warning logs for core-01</text>
  <text x="722" y="312" font-family="'JetBrains Mono', monospace" font-size="15" fill="${BRAND_INK}">→ get_system_status(core-01)</text>
  <text x="722" y="342" font-family="'JetBrains Mono', monospace" font-size="15" fill="${BRAND_INK}">→ list_interfaces(core-01)</text>
  <text x="722" y="372" font-family="'JetBrains Mono', monospace" font-size="15" fill="${BRAND_INK}">→ get_log(core-01, topics=warning)</text>
  <text x="722" y="404" font-family="'JetBrains Mono', monospace" font-size="15" fill="#6FB98A">✓ 3 tool calls · validated · audited</text>

  <!-- logo + wordmark -->
  <image href="${logoB64}" x="80" y="72" width="72" height="72"/>
  <text x="170" y="122" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="700" fill="${TEXT}">MikroMCP</text>

  <!-- eyebrow -->
  <text x="82" y="236" font-family="'JetBrains Mono', monospace" font-size="18" letter-spacing="2.4" fill="${DIM}">MODEL CONTEXT PROTOCOL · ROUTEROS 7.X</text>

  <!-- headline -->
  <text x="80" y="312" font-family="Inter, Arial, sans-serif" font-size="58" font-weight="700" fill="${TEXT}">Open Source</text>
  <text x="80" y="378" font-family="Inter, Arial, sans-serif" font-size="58" font-weight="700" fill="${BRAND_INK}">MikroTik MCP Server</text>
  <text x="80" y="444" font-family="Inter, Arial, sans-serif" font-size="58" font-weight="700" fill="${TEXT}">for RouterOS</text>

  <!-- subline -->
  <text x="82" y="500" font-family="Inter, Arial, sans-serif" font-size="24" fill="${DIM}">Expose RouterOS as ${toolCount} typed, auditable MCP tools.</text>

  <!-- footer rule + facts -->
  <line x1="80" y1="540" x2="1120" y2="540" stroke="${BORDER}"/>
  <text x="82" y="576" font-family="'JetBrains Mono', monospace" font-size="17" fill="${MUTE}">${toolCount} tools  ·  MIT  ·  dry-run + rollback  ·  RBAC + audit</text>
  <text x="1118" y="576" text-anchor="end" font-family="'JetBrains Mono', monospace" font-size="17" fill="${MUTE}">mikromcp.com</text>
</svg>
`;

await sharp(Buffer.from(svg)).png().toFile(resolve(root, "public/og-image.png"));
console.log(`Wrote public/og-image.png (${W}x${H}, ${toolCount} tools)`);
