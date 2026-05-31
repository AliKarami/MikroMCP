# MikroMCP Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static, SEO- and LLM-optimized marketing landing page for mikromcp.com using Astro, deployable to the user's nginx/Hetzner server behind Cloudflare.

**Architecture:** A standalone Astro site in a new top-level `site/` directory, isolated from the server's `src/`. Astro emits pure static HTML/CSS to `site/dist/`. One page (`index.astro`) composed of focused section components. Visual polish is produced with the **`frontend-design` ("Claude Design") skill** during execution — this plan fixes structure, exact copy, and verification; the frontend-design pass owns the fine CSS/motion within the design tokens defined in Task 2.

**Tech Stack:** Astro 4, `@astrojs/sitemap`, self-hosted Inter + JetBrains Mono fonts, vanilla CSS (design tokens), minimal inline `<script>` for nav toggle / copy buttons / tabs / FAQ / terminal animation.

**Brand:** Teal/cyan logo gradient as primary brand color; orange `#EA580C` as the action/CTA accent. Dark-only, near-black `#0B0E11`. Reference spec: `docs/superpowers/specs/2026-05-31-landing-page-design.md`.

---

## File Structure

```
site/
  package.json                     # Task 1
  astro.config.mjs                 # Task 1
  .gitignore                       # Task 1
  public/
    robots.txt                     # Task 14
    llms.txt                       # Task 15
    llms-full.txt                  # Task 15
    favicon.png / favicon.ico      # Task 14
    og-image.png                   # Task 14
    assets/
      MikroMCP-logo-transparent.png  # Task 14
      MikroMCP-logo-square.png       # Task 14
      mikromcp-hero.png              # Task 14
      demo-1.gif                     # Task 14
      claude-review.png              # Task 14
      fonts/                         # Task 2 (woff2)
  src/
    styles/theme.css               # Task 2
    layouts/Base.astro             # Task 3
    components/
      Nav.astro                    # Task 4
      Hero.astro                   # Task 5
      Terminal.astro               # Task 5
      StatStrip.astro              # Task 6
      ProblemBlock.astro           # Task 6
      FeatureGrid.astro            # Task 7
      HowItWorks.astro             # Task 8
      ExamplesTabs.astro           # Task 9
      QuickStart.astro             # Task 10
      SafetyBlock.astro            # Task 11
      FAQ.astro                    # Task 12
      CTABand.astro                # Task 13
      Footer.astro                 # Task 13
    data/
      content.ts                   # Task 3 (shared copy: features, examples, faq)
    pages/index.astro              # assembled incrementally, Tasks 4-13
  DEPLOY.md                        # Task 16
```

**Verification model (static site, no unit-test suite):** each task is verified by (a) `npm run build` succeeding with no errors, and (b) a visual check of `npm run dev` / built output. The "failing test" for a static site is "the build fails or the section is absent / wrong"; the "passing test" is "build succeeds and the section renders with the specified content." Commit after each task.

---

## Task 1: Scaffold the Astro site

**Files:**
- Create: `site/package.json`, `site/astro.config.mjs`, `site/.gitignore`, `site/src/pages/index.astro`

- [ ] **Step 1: Create `site/package.json`**

```json
{
  "name": "mikromcp-site",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview"
  },
  "dependencies": {
    "astro": "^4.16.0",
    "@astrojs/sitemap": "^3.2.0"
  }
}
```

- [ ] **Step 2: Create `site/astro.config.mjs`**

```js
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://mikromcp.com",
  integrations: [sitemap()],
  build: { inlineStylesheets: "auto" },
});
```

- [ ] **Step 3: Create `site/.gitignore`**

```
dist/
node_modules/
.astro/
```

- [ ] **Step 4: Create a placeholder `site/src/pages/index.astro`**

```astro
---
---
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>MikroMCP</title></head>
  <body><h1>MikroMCP</h1></body>
</html>
```

- [ ] **Step 5: Install and verify the build**

Run: `cd site && npm install && npm run build`
Expected: completes with "Complete!" / pages built, `site/dist/index.html` exists containing `<h1>MikroMCP</h1>`.

- [ ] **Step 6: Commit**

```bash
git add site/package.json site/astro.config.mjs site/.gitignore site/src/pages/index.astro site/package-lock.json
git commit -m "chore(site): scaffold Astro landing page project"
```

---

## Task 2: Design tokens, global CSS, and self-hosted fonts

> **frontend-design skill applies here:** the token values below are the locked brand palette; the frontend-design pass refines spacing, shadows, and motion but must keep these color tokens and the dark-only direction.

**Files:**
- Create: `site/src/styles/theme.css`
- Create: `site/public/assets/fonts/` (Inter + JetBrains Mono `.woff2`)

- [ ] **Step 1: Add font files**

Download Inter (regular 400, medium 500, semibold 600, bold 700) and JetBrains Mono (regular 400, medium 500) `.woff2` files into `site/public/assets/fonts/`. (Source: Google Fonts / rsms.me / JetBrains. Self-hosting avoids render-blocking third-party requests.)

- [ ] **Step 2: Create `site/src/styles/theme.css` with tokens + `@font-face` + base reset**

```css
@font-face { font-family: "Inter"; src: url("/assets/fonts/Inter-Regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "Inter"; src: url("/assets/fonts/Inter-Medium.woff2") format("woff2"); font-weight: 500; font-display: swap; }
@font-face { font-family: "Inter"; src: url("/assets/fonts/Inter-SemiBold.woff2") format("woff2"); font-weight: 600; font-display: swap; }
@font-face { font-family: "Inter"; src: url("/assets/fonts/Inter-Bold.woff2") format("woff2"); font-weight: 700; font-display: swap; }
@font-face { font-family: "JetBrains Mono"; src: url("/assets/fonts/JetBrainsMono-Regular.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "JetBrains Mono"; src: url("/assets/fonts/JetBrainsMono-Medium.woff2") format("woff2"); font-weight: 500; font-display: swap; }

:root {
  --bg: #0B0E11;
  --bg-elev: #13171C;
  --border: #293239;
  --text: #E6EDF3;
  --text-dim: #9BA8B4;
  --brand: #14B8A6;          /* teal/cyan, from logo */
  --brand-deep: #0F766E;
  --brand-glow: #2DD4BF;
  --accent: #EA580C;         /* orange CTA */
  --accent-hover: #C2410C;
  --radius: 12px;
  --maxw: 1120px;
  --font-sans: "Inter", system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}

*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { animation: none !important; transition: none !important; } }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font-sans); line-height: 1.6; -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
code, pre, .mono { font-family: var(--font-mono); }
.container { max-width: var(--maxw); margin: 0 auto; padding: 0 24px; }
.section { padding: 96px 0; }
```

- [ ] **Step 3: Verify**

Run: `cd site && npm run build`
Expected: build succeeds (theme.css is imported in Base.astro in Task 3; at this point just confirm no syntax errors by importing it temporarily in index.astro, or defer build check to Task 3).

- [ ] **Step 4: Commit**

```bash
git add site/src/styles/theme.css site/public/assets/fonts/
git commit -m "feat(site): add design tokens, base CSS, and self-hosted fonts"
```

---

## Task 3: Base layout with SEO `<head>` + JSON-LD, and shared content data

**Files:**
- Create: `site/src/layouts/Base.astro`
- Create: `site/src/data/content.ts`

- [ ] **Step 1: Create `site/src/data/content.ts` (single source of copy)**

```ts
export const SITE = {
  name: "MikroMCP",
  domain: "https://mikromcp.com",
  tagline: "AI-native network automation for MikroTik RouterOS",
  github: "https://github.com/AliKarami/MikroMCP",
  docs: "https://docs.mikromcp.com",
  toolCount: 117,
};

export const features = [
  { icon: "compass", title: "Router management", body: "System status, clock, reboot, packages, files, scripts, scheduler jobs, containers." },
  { icon: "globe", title: "Network operations", body: "Interfaces, VLANs, IP addresses, DHCP leases, DNS static records, bridge ports, WiFi clients." },
  { icon: "flame", title: "Firewall & policy", body: "Filter/NAT rules, mangle rules, address lists, route tables, routing rules." },
  { icon: "route", title: "Routing visibility", body: "Static routes, routing tables, BGP peers, OSPF neighbors." },
  { icon: "lock", title: "Secure access", body: "HTTP bearer auth, bcrypt token hashes, RBAC, router/tool restrictions, confirmation tokens." },
  { icon: "activity", title: "Diagnostics", body: "Router-originated ping, traceroute, torch, log filtering, guarded SSH command execution." },
  { icon: "shield", title: "Change safety", body: "Dry-run, idempotent writes, snapshots, write journal, plan_changes, apply_plan, rollback_change." },
  { icon: "settings", title: "Production behavior", body: "Retries for read tools, per-router circuit breakers, correlation IDs, structured logs, audit logs." },
  { icon: "puzzle", title: "MCP compatibility", body: "stdio for desktop clients, Streamable HTTP and legacy SSE for remote or service-style clients." },
];

export const examples = [
  { label: "Router Inspection", prompt: "Use MikroMCP to inspect core-01. Summarize system resources, RouterOS version, running interfaces, active routes, DNS settings, and recent warning/error logs. Flag anything that looks operationally risky." },
  { label: "Firewall Management", prompt: "List firewall filter and NAT rules on edge-01. Identify disabled rules, overlapping port forwards, broad accept rules, and anything without comments. Do not change anything yet." },
  { label: "Safe Route Change", prompt: "Dry-run a route on core-01 for 10.20.0.0/16 via 192.168.88.1 in the main table. Show the exact planned diff and tell me whether an existing route conflicts." },
  { label: "WireGuard", prompt: "Show WireGuard peers on branch-02. Sort by last handshake age and flag peers that have not handshaken recently or have no transfer counters." },
  { label: "Diagnostics", prompt: "Check interface health on edge-01, then run ping and traceroute from the router to 1.1.1.1. If packet loss is present, use torch on the WAN interface for a short traffic snapshot." },
  { label: "Plan / Apply / Rollback", prompt: "Create a change plan that adds a DNS record and a firewall address-list entry on edge-01. Use dry-run first, explain the plan, then wait for approval before applying anything." },
];

export const faqs = [
  { q: "What is MikroMCP?", a: "MikroMCP is an open-source Model Context Protocol (MCP) server that exposes MikroTik RouterOS as 117 typed, auditable tools — letting AI assistants inspect, diagnose, and safely operate routers in natural language instead of improvising CLI commands." },
  { q: "How is it different from the RouterOS API?", a: "The RouterOS REST/API exposes raw endpoints. MikroMCP wraps them in schema-validated, idempotent, dry-run-able tools with RBAC, audit logging, snapshots, and rollback — the safety layer an LLM needs before it touches production gear." },
  { q: "How is it different from SSH automation?", a: "Instead of brittle SSH scripts that screen-scrape CLI output, MikroMCP returns structured, typed results with confirmation gates and per-router circuit breakers. SSH is used only where REST can't reach — ping, traceroute, torch, and guarded run_command." },
  { q: "Does it work with Claude, Cursor, and Codex?", a: "Yes. MikroMCP speaks MCP over stdio and HTTP/SSE, so Claude Desktop, Claude Code, Cursor, Codex, and any MCP-compatible client can drive RouterOS directly." },
  { q: "Is it safe to run against production routers?", a: "MikroMCP is built for it: dry-run previews, idempotent writes, snapshots, rollback, confirmation tokens, per-router circuit breakers, RBAC, and audit logging. Use least-privilege RouterOS users and verified TLS." },
  { q: "Which RouterOS versions are supported?", a: "RouterOS 7.x, which provides the REST API MikroMCP uses." },
];
```

- [ ] **Step 2: Create `site/src/layouts/Base.astro` with full SEO head + SoftwareApplication JSON-LD**

```astro
---
import "../styles/theme.css";
import { SITE } from "../data/content.ts";
interface Props { title?: string; description?: string; }
const {
  title = `${SITE.name} — ${SITE.tagline}`,
  description = "MikroMCP exposes MikroTik RouterOS as a typed, auditable MCP server so Claude, Cursor, Codex, and other AI assistants can inspect, diagnose, and safely operate routers in natural language.",
} = Astro.props;
const canonical = new URL(Astro.url.pathname, SITE.domain).href;
const softwareLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE.name,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Linux, macOS, Windows",
  description,
  url: SITE.domain,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  license: "https://opensource.org/licenses/MIT",
};
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="description" content={description} />
    <link rel="canonical" href={canonical} />
    <link rel="icon" href="/favicon.png" type="image/png" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:url" content={canonical} />
    <meta property="og:image" content={`${SITE.domain}/og-image.png`} />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={title} />
    <meta name="twitter:description" content={description} />
    <meta name="twitter:image" content={`${SITE.domain}/og-image.png`} />
    <link rel="sitemap" href="/sitemap-index.xml" />
    <script type="application/ld+json" set:html={JSON.stringify(softwareLd)} />
  </head>
  <body>
    <slot />
  </body>
</html>
```

- [ ] **Step 3: Point index.astro at the layout**

Replace `site/src/pages/index.astro` body with:

```astro
---
import Base from "../layouts/Base.astro";
---
<Base>
  <main><h1>MikroMCP</h1></main>
</Base>
```

- [ ] **Step 4: Verify**

Run: `cd site && npm run build`
Expected: build succeeds; `dist/index.html` contains the `<title>`, meta description, canonical link, and the `application/ld+json` SoftwareApplication block.

- [ ] **Step 5: Commit**

```bash
git add site/src/layouts/Base.astro site/src/data/content.ts site/src/pages/index.astro
git commit -m "feat(site): base layout with SEO head, JSON-LD, and shared content data"
```

---

## Task 4: Sticky navigation

**Files:**
- Create: `site/src/components/Nav.astro`
- Modify: `site/src/pages/index.astro`

- [ ] **Step 1: Create `site/src/components/Nav.astro`**

Transparent over hero, solid on scroll (toggle a `.scrolled` class via a small inline script). Logo uses `/assets/MikroMCP-logo-transparent.png`. Links: Features, How it works, Tools, FAQ, Docs↗ (`SITE.docs`), GitHub↗ (`SITE.github`), and a `Get Started` button linking to `#quick-start`. Include a mobile hamburger that toggles a `.open` class on the menu.

```astro
---
import { SITE } from "../data/content.ts";
---
<header class="nav" id="nav">
  <div class="container nav-inner">
    <a class="brand" href="/"><img src="/assets/MikroMCP-logo-transparent.png" alt="MikroMCP" height="32" /><span>MikroMCP</span></a>
    <button class="nav-toggle" aria-label="Toggle menu" aria-expanded="false">☰</button>
    <nav class="nav-links">
      <a href="#features">Features</a>
      <a href="#how">How it works</a>
      <a href="#examples">Tools</a>
      <a href="#faq">FAQ</a>
      <a href={SITE.docs} rel="noopener">Docs ↗</a>
      <a href={SITE.github} rel="noopener">GitHub ↗</a>
      <a class="btn btn-accent" href="#quick-start">Get Started</a>
    </nav>
  </div>
</header>
<script>
  const nav = document.getElementById("nav");
  const onScroll = () => nav?.classList.toggle("scrolled", window.scrollY > 24);
  onScroll(); window.addEventListener("scroll", onScroll, { passive: true });
  const toggle = document.querySelector(".nav-toggle");
  const links = document.querySelector(".nav-links");
  toggle?.addEventListener("click", () => {
    const open = links?.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(!!open));
  });
</script>
```

Add the component's styles in a `<style>` block (scoped) implementing the sticky/scrolled/mobile behavior and `.btn`/`.btn-accent` (orange) button styles. The frontend-design pass refines exact visuals.

- [ ] **Step 2: Mount in index.astro**

```astro
---
import Base from "../layouts/Base.astro";
import Nav from "../components/Nav.astro";
---
<Base>
  <Nav />
  <main><h1>MikroMCP</h1></main>
</Base>
```

- [ ] **Step 3: Verify**

Run: `cd site && npm run build` then visually check via `npm run dev` (http://localhost:4321): nav is sticky, gains background on scroll, mobile toggle opens/closes.
Expected: build succeeds; nav renders with all links and the Get Started button.

- [ ] **Step 4: Commit**

```bash
git add site/src/components/Nav.astro site/src/pages/index.astro
git commit -m "feat(site): sticky navigation"
```

---

## Task 5: Hero + animated terminal

**Files:**
- Create: `site/src/components/Hero.astro`, `site/src/components/Terminal.astro`
- Modify: `site/src/pages/index.astro`

- [ ] **Step 1: Create `site/src/components/Terminal.astro`**

A reusable terminal card: window chrome (three dots), a `<pre>` body. Accepts a `lines` prop (array of `{ prompt?: string, text: string }`) and an optional `animate` boolean. When `animate` and not `prefers-reduced-motion`, type the lines out with a small inline script; otherwise render statically.

```astro
---
interface Line { prompt?: boolean; text: string; }
interface Props { lines: Line[]; animate?: boolean; }
const { lines, animate = false } = Astro.props;
---
<div class="term" data-animate={animate ? "1" : "0"}>
  <div class="term-bar"><span></span><span></span><span></span></div>
  <pre class="term-body">{lines.map((l) => (
    <div class="term-line" data-prompt={l.prompt ? "1" : "0"}>{l.text}</div>
  ))}</pre>
</div>
<script>
  document.querySelectorAll('.term[data-animate="1"]').forEach((el) => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const lines = [...el.querySelectorAll(".term-line")];
    lines.forEach((l) => ((l as HTMLElement).style.visibility = "hidden"));
    let i = 0;
    const reveal = () => {
      if (i >= lines.length) return;
      (lines[i] as HTMLElement).style.visibility = "visible";
      i++; setTimeout(reveal, 600);
    };
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { reveal(); io.disconnect(); } });
    io.observe(el);
  });
</script>
```

- [ ] **Step 2: Create `site/src/components/Hero.astro`**

```astro
---
import { SITE } from "../data/content.ts";
import Terminal from "./Terminal.astro";
const heroLines = [
  { prompt: true, text: 'Show CPU, interfaces & warning logs for core-01' },
  { text: "→ get_system_status(core-01)" },
  { text: "→ list_interfaces(core-01)" },
  { text: "→ get_log(core-01, topics=warning,error)" },
  { text: "✓ 4 tool calls · validated · audited" },
];
---
<section class="hero">
  <div class="container hero-grid">
    <div class="hero-copy">
      <p class="eyebrow mono">Model Context Protocol · RouterOS 7.x</p>
      <h1>AI-native network automation for <span class="grad">MikroTik RouterOS</span></h1>
      <p class="lede">MikroMCP exposes RouterOS as {SITE.toolCount} typed, auditable tools so Claude, Cursor, Codex, and any MCP client can inspect, diagnose, and safely operate your routers in natural language.</p>
      <div class="hero-cta">
        <a class="btn btn-accent btn-lg" href="#quick-start">Get Started</a>
        <a class="btn btn-ghost btn-lg" href={SITE.github} rel="noopener">View on GitHub ↗</a>
      </div>
      <ul class="trust mono">
        <li>{SITE.toolCount} typed tools</li><li>MIT licensed</li><li>RouterOS 7.x</li><li>MCP stdio + HTTP</li>
      </ul>
    </div>
    <div class="hero-visual">
      <Terminal lines={heroLines} animate={true} />
    </div>
  </div>
</section>
```

Add a `<style>` block: near-black bg, dotted-grid/topology motif (CSS radial/linear gradients), `.grad` teal gradient text, glowing nodes. frontend-design pass owns refinement.

- [ ] **Step 3: Mount in index.astro** (replace the `<main><h1>` placeholder with `<Hero />` inside `<main>`).

- [ ] **Step 4: Verify**

Run: `cd site && npm run build`; visually check hero renders, terminal types out on view, both CTAs present, reduced-motion shows static terminal.
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add site/src/components/Hero.astro site/src/components/Terminal.astro site/src/pages/index.astro
git commit -m "feat(site): hero with animated terminal and dual CTAs"
```

---

## Task 6: Stat strip + problem block

**Files:**
- Create: `site/src/components/StatStrip.astro`, `site/src/components/ProblemBlock.astro`
- Modify: `site/src/pages/index.astro`

- [ ] **Step 1: Create `site/src/components/StatStrip.astro`**

Four stats in a row: `117 typed tools`, `idempotent writes`, `dry-run + rollback`, `RBAC + audit`. Use the brand teal for the numbers/labels.

- [ ] **Step 2: Create `site/src/components/ProblemBlock.astro`**

```astro
---
---
<section class="section problem">
  <div class="container narrow">
    <h2>Raw CLI is the wrong abstraction for AI agents</h2>
    <p>RouterOS is powerful, but asking an LLM to improvise shell commands against production network gear is risky. MikroMCP gives agents a controlled tool surface: strict schemas, idempotent writes, dry-run previews, per-router circuit breakers, retry policies, RBAC, audit logs, snapshots, and rollback-aware change workflows.</p>
    <p class="mono accent-text">MikroMCP turns MikroTik RouterOS into a production-minded MCP control plane.</p>
  </div>
</section>
```

- [ ] **Step 3: Mount both in index.astro** (after `<Hero />`).

- [ ] **Step 4: Verify** — `cd site && npm run build` succeeds; sections render.

- [ ] **Step 5: Commit**

```bash
git add site/src/components/StatStrip.astro site/src/components/ProblemBlock.astro site/src/pages/index.astro
git commit -m "feat(site): stat strip and problem statement"
```

---

## Task 7: Feature showcase grid

**Files:**
- Create: `site/src/components/FeatureGrid.astro`
- Modify: `site/src/pages/index.astro`

- [ ] **Step 1: Create `site/src/components/FeatureGrid.astro`** — render `features` from `content.ts` as a responsive 3-column (→ 1-column mobile) grid of cards. Each card: inline SVG icon (keyed by `feature.icon`; define a small inline SVG map), title, body. Section `id="features"`, heading "Everything you need to operate RouterOS with AI".

```astro
---
import { features } from "../data/content.ts";
const icons: Record<string, string> = {
  compass: '<circle cx="12" cy="12" r="9"/><polygon points="16 8 10 10 8 16 14 14 16 8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  flame: '<path d="M12 3c2 4 5 5 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5-1-8z"/>',
  route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h6a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  activity: '<polyline points="3 12 8 12 11 20 14 4 17 12 21 12"/>',
  shield: '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4 12H1M23 12h-3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  puzzle: '<path d="M10 3h4v3a2 2 0 0 0 4 0V3h3v18H4V3h3v3a2 2 0 0 0 4 0z"/>',
};
---
<section class="section" id="features">
  <div class="container">
    <h2 class="section-title">Everything you need to operate RouterOS with AI</h2>
    <div class="feature-grid">
      {features.map((f) => (
        <article class="feature-card">
          <svg class="feat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" set:html={icons[f.icon]} />
          <h3>{f.title}</h3>
          <p>{f.body}</p>
        </article>
      ))}
    </div>
  </div>
</section>
```

- [ ] **Step 2: Mount in index.astro** (after problem block).

- [ ] **Step 3: Verify** — build succeeds; 9 cards render with icons.

- [ ] **Step 4: Commit**

```bash
git add site/src/components/FeatureGrid.astro site/src/pages/index.astro
git commit -m "feat(site): feature showcase grid"
```

---

## Task 8: How it works + pipeline diagram

**Files:**
- Create: `site/src/components/HowItWorks.astro`
- Modify: `site/src/pages/index.astro`

- [ ] **Step 1: Create `site/src/components/HowItWorks.astro`** — section `id="how"`, three numbered steps:
  1. **Connect your MCP client** — "Register MikroMCP in Claude Desktop, Claude Code, Cursor, or Codex over stdio or HTTP."
  2. **Ask in natural language** — "Describe what you want — inspect a router, audit firewall rules, plan a change. No RouterOS syntax required."
  3. **MikroMCP validates, audits, and executes** — "Each call is schema-checked, authorized, logged, and run through a per-router circuit breaker against the RouterOS REST API."

  Below the steps, a horizontal pipeline diagram (inline SVG or styled flex row): `Prompt → Schema validation → RBAC → Audit log → Circuit breaker → RouterOS REST`.

- [ ] **Step 2: Mount in index.astro.**

- [ ] **Step 3: Verify** — build succeeds; steps and pipeline render, responsive.

- [ ] **Step 4: Commit**

```bash
git add site/src/components/HowItWorks.astro site/src/pages/index.astro
git commit -m "feat(site): how-it-works section with pipeline diagram"
```

---

## Task 9: Real-world examples tabs

**Files:**
- Create: `site/src/components/ExamplesTabs.astro`
- Modify: `site/src/pages/index.astro`

- [ ] **Step 1: Create `site/src/components/ExamplesTabs.astro`** — section `id="examples"`. Render `examples` from `content.ts` as a tabbed interface: a row of tab buttons (`example.label`) and a panel showing the selected prompt inside a `Terminal`-style block. Inline script toggles `.active` on button + panel by index. First tab active by default. Keyboard-accessible (buttons, `aria-selected`).

```astro
---
import { examples } from "../data/content.ts";
---
<section class="section" id="examples">
  <div class="container">
    <h2 class="section-title">Real prompts, real operations</h2>
    <p class="section-sub">Paste these straight into your AI assistant.</p>
    <div class="tabs">
      <div class="tab-row" role="tablist">
        {examples.map((e, i) => (
          <button class={`tab ${i === 0 ? "active" : ""}`} role="tab" aria-selected={i === 0} data-i={i}>{e.label}</button>
        ))}
      </div>
      {examples.map((e, i) => (
        <div class={`tab-panel ${i === 0 ? "active" : ""}`} data-i={i}>
          <pre class="prompt-block mono">{e.prompt}</pre>
        </div>
      ))}
    </div>
  </div>
</section>
<script>
  const root = document.querySelector("#examples .tabs");
  root?.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = (btn as HTMLElement).dataset.i;
      root.querySelectorAll(".tab").forEach((b) => { b.classList.toggle("active", (b as HTMLElement).dataset.i === i); b.setAttribute("aria-selected", String((b as HTMLElement).dataset.i === i)); });
      root.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", (p as HTMLElement).dataset.i === i));
    });
  });
</script>
```

- [ ] **Step 2: Mount in index.astro.**

- [ ] **Step 3: Verify** — build succeeds; clicking tabs swaps the prompt shown.

- [ ] **Step 4: Commit**

```bash
git add site/src/components/ExamplesTabs.astro site/src/pages/index.astro
git commit -m "feat(site): real-world example prompts with tabs"
```

---

## Task 10: Quick start with install tabs + copy buttons

**Files:**
- Create: `site/src/components/QuickStart.astro`
- Modify: `site/src/pages/index.astro`

- [ ] **Step 1: Create `site/src/components/QuickStart.astro`** — section `id="quick-start"`, heading "Up and running in minutes". Three install tabs (same tab pattern as Task 9): **npm**, **Binary**, **Docker**. Each shows a code block with a copy-to-clipboard button.
  - npm: `npm install -g mikromcp` then `mikromcp init`
  - Binary: `# Download from GitHub releases, then` / `chmod +x mikromcp-linux-x64` / `./mikromcp-linux-x64 init`
  - Docker: `docker pull ghcr.io/alikarami/mikromcp:latest`

  Below tabs: a final line — `mikromcp init` runs a guided wizard, then "open your AI assistant and just ask." Link to full Getting Started: `${SITE.docs}/getting-started` (Docs site) with a note it currently lives on the GitHub wiki.

  Copy button script (shared, inline):

```astro
<script>
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = (btn as HTMLElement).dataset.copy || "";
      try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; setTimeout(() => (btn.textContent = "Copy"), 1500); } catch {}
    });
  });
</script>
```

- [ ] **Step 2: Mount in index.astro** (this is the `Get Started` CTA target).

- [ ] **Step 3: Verify** — build succeeds; tabs switch install method; copy button copies and shows "Copied".

- [ ] **Step 4: Commit**

```bash
git add site/src/components/QuickStart.astro site/src/pages/index.astro
git commit -m "feat(site): quick-start with install tabs and copy buttons"
```

---

## Task 11: Safety highlight block

**Files:**
- Create: `site/src/components/SafetyBlock.astro`
- Modify: `site/src/pages/index.astro`

- [ ] **Step 1: Create `site/src/components/SafetyBlock.astro`** — heading "Built to touch production safely". Highlight cards/list: Dry-run previews · Idempotent writes · Config snapshots · One-call rollback · Confirmation tokens · Per-router circuit breakers · RBAC identities · Audit logging. Optionally include the `claude-review.png` screenshot as supporting visual.

- [ ] **Step 2: Mount in index.astro.**

- [ ] **Step 3: Verify** — build succeeds; section renders.

- [ ] **Step 4: Commit**

```bash
git add site/src/components/SafetyBlock.astro site/src/pages/index.astro
git commit -m "feat(site): change-safety highlight section"
```

---

## Task 12: FAQ accordion + FAQPage JSON-LD

**Files:**
- Create: `site/src/components/FAQ.astro`
- Modify: `site/src/pages/index.astro`

- [ ] **Step 1: Create `site/src/components/FAQ.astro`** — section `id="faq"`. Render `faqs` from `content.ts` as native `<details>/<summary>` accordions (no JS needed, accessible). Also emit a `FAQPage` JSON-LD script built from the same `faqs` array.

```astro
---
import { faqs } from "../data/content.ts";
const faqLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a },
  })),
};
---
<section class="section" id="faq">
  <div class="container narrow">
    <h2 class="section-title">Frequently asked questions</h2>
    {faqs.map((f) => (
      <details class="faq-item">
        <summary>{f.q}</summary>
        <p>{f.a}</p>
      </details>
    ))}
  </div>
  <script type="application/ld+json" set:html={JSON.stringify(faqLd)} />
</section>
```

- [ ] **Step 2: Mount in index.astro.**

- [ ] **Step 3: Verify** — build succeeds; `dist/index.html` contains a `FAQPage` JSON-LD block; accordions expand/collapse.

- [ ] **Step 4: Commit**

```bash
git add site/src/components/FAQ.astro site/src/pages/index.astro
git commit -m "feat(site): FAQ accordion with FAQPage structured data"
```

---

## Task 13: Final CTA band + footer

**Files:**
- Create: `site/src/components/CTABand.astro`, `site/src/components/Footer.astro`
- Modify: `site/src/pages/index.astro`

- [ ] **Step 1: Create `site/src/components/CTABand.astro`** — full-width band, teal-glow background: "Bring AI to your MikroTik fleet" + both buttons (`Get Started` → `#quick-start`, `View on GitHub` → `SITE.github`).

- [ ] **Step 2: Create `site/src/components/Footer.astro`** — columns: Product (Features, How it works, Tools, Quick start), Docs (Getting Started, Available Tools, Architecture, Security — all → `SITE.docs/...`), Project (GitHub, Changelog, License, Roadmap), and an external links note (MCP, RouterOS REST API). Bottom row: logo, "MIT licensed", version `v1.6.0`, copyright.

- [ ] **Step 3: Mount both in index.astro (after FAQ).**

- [ ] **Step 4: Verify** — build succeeds; CTA band + footer render with working links.

- [ ] **Step 5: Commit**

```bash
git add site/src/components/CTABand.astro site/src/components/Footer.astro site/src/pages/index.astro
git commit -m "feat(site): final CTA band and footer"
```

---

## Task 14: Static assets — logos, favicon, OG image, robots.txt

**Files:**
- Create: `site/public/assets/*`, `site/public/favicon.png`, `site/public/og-image.png`, `site/public/robots.txt`

- [ ] **Step 1: Copy brand assets into the site**

```bash
mkdir -p site/public/assets
cp docs/assets/MikroMCP-logo-transparent.png site/public/assets/
cp docs/assets/MikroMCP-logo-square.png site/public/assets/
cp docs/assets/mikromcp-hero.png site/public/assets/
cp docs/assets/demo-1.gif site/public/assets/
cp docs/assets/claude-review.png site/public/assets/
cp docs/assets/MikroMCP-logo-square.png site/public/favicon.png
```

- [ ] **Step 2: Create the OG share image**

Create `site/public/og-image.png` (1200×630). Simplest path: a small HTML/CSS card screenshotted to PNG, or compose from the square logo + tagline on near-black. (During execution, generate with the frontend-design/canvas approach; must be exactly 1200×630.)

- [ ] **Step 3: Create `site/public/robots.txt`**

```
User-agent: *
Allow: /

Sitemap: https://mikromcp.com/sitemap-index.xml
```

- [ ] **Step 4: Verify** — `cd site && npm run build`; confirm `dist/assets/`, `dist/favicon.png`, `dist/og-image.png`, `dist/robots.txt`, and `dist/sitemap-index.xml` all exist.

- [ ] **Step 5: Commit**

```bash
git add site/public/
git commit -m "feat(site): brand assets, favicon, OG image, robots.txt"
```

---

## Task 15: LLM discoverability — llms.txt and llms-full.txt

**Files:**
- Create: `site/public/llms.txt`, `site/public/llms-full.txt`

- [ ] **Step 1: Create `site/public/llms.txt`** (curated, follows the llms.txt convention: H1, blockquote summary, linked sections)

```markdown
# MikroMCP

> AI-native network automation for MikroTik RouterOS. MikroMCP is an open-source Model Context Protocol (MCP) server that exposes RouterOS as 117 typed, auditable tools, so AI assistants like Claude, Cursor, and Codex can inspect, diagnose, and safely operate MikroTik routers in natural language instead of improvising CLI commands.

## What it is

- 117 typed MCP tools covering router management, network operations, firewall and policy, routing, secure access, diagnostics, and change safety.
- Safety layer for LLMs: schema validation, idempotent writes, dry-run previews, snapshots, rollback, confirmation tokens, RBAC, audit logging, and per-router circuit breakers.
- Transports: stdio (desktop clients) and Streamable HTTP / SSE (remote clients).
- Requires MikroTik RouterOS 7.x (uses the REST API).

## Links

- [Website](https://mikromcp.com)
- [GitHub repository](https://github.com/AliKarami/MikroMCP)
- [Documentation](https://docs.mikromcp.com)
- [Getting Started](https://github.com/AliKarami/MikroMCP/wiki/Getting-Started)
- [Available Tools](https://github.com/AliKarami/MikroMCP/wiki/Available-Tools)
- [Architecture](https://github.com/AliKarami/MikroMCP/wiki/Architecture)
- [Security](https://github.com/AliKarami/MikroMCP/wiki/Security)

## Install

- npm: `npm install -g mikromcp` then `mikromcp init`
- Binary: download from GitHub releases (Linux/macOS/Windows)
- Docker: `docker pull ghcr.io/alikarami/mikromcp:latest`
```

- [ ] **Step 2: Create `site/public/llms-full.txt`** — a fuller plain-text document an LLM can answer from without crawling. Include: the description, the full 9-category feature list (from `content.ts` features), the 6 example prompts, the 6 FAQ Q&As, install steps, and the safety feature list. (Assemble verbatim from the spec/content so there is no placeholder.)

- [ ] **Step 3: Verify** — build succeeds; `dist/llms.txt` and `dist/llms-full.txt` exist and are served as `text/plain` (nginx config in Task 16 ensures the content type).

- [ ] **Step 4: Commit**

```bash
git add site/public/llms.txt site/public/llms-full.txt
git commit -m "feat(site): add llms.txt and llms-full.txt for LLM discoverability"
```

---

## Task 16: Deployment guide (nginx + Cloudflare + rsync)

**Files:**
- Create: `site/DEPLOY.md`

- [ ] **Step 1: Write `site/DEPLOY.md`** containing:
  - **Build:** `cd site && npm ci && npm run build` → output in `site/dist/`.
  - **Push to server (rsync):** `rsync -avz --delete site/dist/ user@your-hetzner-host:/var/www/mikromcp.com/`
  - **nginx server block** for `mikromcp.com` (root `/var/www/mikromcp.com`, `index index.html`, `try_files $uri $uri/ $uri.html =404`, gzip on, long cache for `/assets/`, security headers, and an explicit `location = /llms.txt { default_type text/plain; }` plus same for `/llms-full.txt`). Provide the full block verbatim:

```nginx
server {
    listen 80;
    server_name mikromcp.com www.mikromcp.com;
    root /var/www/mikromcp.com;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 256;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / { try_files $uri $uri/ $uri.html =404; }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location = /llms.txt      { default_type text/plain; }
    location = /llms-full.txt { default_type text/plain; }

    # www -> apex
    if ($host = www.mikromcp.com) { return 301 https://mikromcp.com$request_uri; }
}
```

  - **Cloudflare notes:** DNS A/AAAA record proxied (orange cloud); SSL/TLS mode **Full (strict)** with an origin certificate installed on nginx (TLS terminates at Cloudflare and again at origin); cache static assets; do not cache HTML or use a short TTL; "Always Use HTTPS" on. Note that because Cloudflare proxies, the listen-80 block is fine if using Cloudflare Origin certs on 443 — provide a short TLS variant note.
  - **Optional CI:** a brief note on adding a GitHub Action that builds and rsyncs on push to `main` (left as a follow-up; not implemented now).

- [ ] **Step 2: Verify** — `DEPLOY.md` exists and the nginx block is complete and copy-pasteable.

- [ ] **Step 3: Commit**

```bash
git add site/DEPLOY.md
git commit -m "docs(site): deployment guide for nginx + Cloudflare"
```

---

## Task 17: Full design pass, build verification, and polish

> **frontend-design skill is central here:** with all sections in place, do the cohesive visual pass — typography scale, spacing rhythm, the topology/grid hero motif, glow accents, hover states, scroll-reveal, and full responsive behavior — staying within the Task 2 tokens.

**Files:** touches component `<style>` blocks and `theme.css` as needed.

- [ ] **Step 1: Cohesive visual pass** across all sections using the frontend-design skill (spacing, hierarchy, motifs, hover/focus states, motion).

- [ ] **Step 2: Responsive check** at 360px, 768px, 1280px — nav collapses, grids reflow, terminal/tabs usable, no horizontal scroll.

- [ ] **Step 3: Accessibility check** — color contrast AA on text, focus-visible outlines on all interactive elements, `prefers-reduced-motion` disables terminal/scroll animation, all images have `alt`, tabs/accordion keyboard-operable.

- [ ] **Step 4: Final production build + spot-check output**

Run: `cd site && npm run build && npm run preview`
Expected: build succeeds; `dist/index.html` contains both `SoftwareApplication` and `FAQPage` JSON-LD, the meta/OG tags, and all 12 sections; `dist/` contains `llms.txt`, `llms-full.txt`, `robots.txt`, `sitemap-index.xml`, favicon, og-image, and assets.

- [ ] **Step 5: (Optional) Lighthouse** — run Lighthouse on the preview; aim for 90+ across Performance / Accessibility / Best Practices / SEO. Note any gaps.

- [ ] **Step 6: Commit**

```bash
git add site/
git commit -m "feat(site): cohesive design pass, responsive, and a11y polish"
```

---

## Self-Review (completed)

**Spec coverage:** All spec sections map to tasks — tech/structure (T1), design system/tokens/fonts (T2), SEO head + JSON-LD (T3, T12), 12 page sections (T4–T13), assets/favicon/OG/robots (T14), llms.txt + llms-full.txt (T15), nginx/Cloudflare/rsync deploy (T16), responsive/a11y/SEO polish (T17). Teal-primary/orange-CTA palette locked in T2. Install tabs npm/binary/Docker per approval (T10).

**Placeholder scan:** Exact copy is embedded in `content.ts` (T3) and reused everywhere; FAQ/features/examples are verbatim. The OG image (T14 Step 2) and the full `llms-full.txt` text (T15 Step 2) and the per-component `<style>` visual details are produced during execution via the frontend-design skill — this is intentional (design output), not a content placeholder; all required *content* is specified.

**Type consistency:** `SITE`, `features`, `examples`, `faqs` shapes defined once in `content.ts` (T3) and consumed with matching fields in T5/T7/T9/T12/T15. Tab toggle pattern (`data-i` + `.active`) is identical in T9 and T10. Terminal `lines` prop shape consistent between T5 definition and T5/T9 usage.
