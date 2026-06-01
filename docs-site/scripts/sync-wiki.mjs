import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIKI_DIR = resolve(__dirname, "../../docs/wiki");
const OUT_DIR = resolve(__dirname, "../src/content/docs");

export const WIKI_ORDER = [
  "Home",
  "Getting-Started",
  "RouterOS-API-Setup",
  "Configuration",
  "Running",
  "Connecting-to-Claude-Desktop",
  "Connecting-to-AI-Assistants",
  "Using-the-Skill",
  "Available-Tools",
  "Architecture",
  "Error-Handling",
  "Security",
  "Development",
  "Contributing",
  "Roadmap",
];

export function slugForWikiName(name) {
  if (name === "Home") return "";
  return name.toLowerCase();
}

export function extractTitle(body, fallbackName = "") {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  if (m) return m[1].trim();
  return fallbackName.replace(/-/g, " ").trim();
}

function yamlTitle(title) {
  return /[:#]/.test(title) ? `"${title.replace(/"/g, '\\"')}"` : title;
}

export function transform(body, title, order, rewriteLinks = (s) => s) {
  const withoutH1 = body.replace(/^#\s+.+?\s*$/m, "").replace(/^\n+/, "");
  const rewritten = rewriteLinks(withoutH1);
  const fm = `---\ntitle: ${yamlTitle(title)}\nsidebar:\n  order: ${order}\n---\n\n`;
  return fm + rewritten;
}

const WIKI_NAMES = new Set(WIKI_ORDER);

function routeForWikiName(name) {
  if (name === "Home") return "/";
  return `/${name.toLowerCase()}/`;
}

export function rewriteWikiLinks(text) {
  return text.replace(/\]\(([A-Za-z][A-Za-z0-9-]*)(#[^)]+)?\)/g, (full, name, anchor) => {
    if (!WIKI_NAMES.has(name)) return full;
    const route = routeForWikiName(name);
    if (name === "Home") {
      return anchor ? `](/${anchor})` : `](/)`;
    }
    return anchor ? `](${route}${anchor})` : `](${route})`;
  });
}

function sync() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const files = readdirSync(WIKI_DIR).filter((f) => f.endsWith(".md"));
  let count = 0;
  for (const file of files) {
    const name = basename(file, ".md");
    const order = WIKI_ORDER.indexOf(name);
    const safeOrder = order === -1 ? 99 : order;
    const raw = readFileSync(resolve(WIKI_DIR, file), "utf8");
    const title = extractTitle(raw, name);
    const out = transform(raw, title, safeOrder, rewriteWikiLinks);
    const slug = slugForWikiName(name);
    const outName = slug === "" ? "index.md" : `${slug}.md`;
    writeFileSync(resolve(OUT_DIR, outName), out, "utf8");
    count++;
  }
  console.log(`[sync-wiki] wrote ${count} pages to src/content/docs/`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  sync();
}
