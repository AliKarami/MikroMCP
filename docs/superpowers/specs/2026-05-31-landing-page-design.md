# MikroMCP Landing Page — Design Spec

**Date:** 2026-05-31
**Domain:** https://mikromcp.com
**Scope:** Marketing landing page only. The `docs.mikromcp.com` docs site (Starlight migration of the wiki) is a separate, later project — but this site is structured so it can be added as a sibling without rework.

## Goals

- Market MikroMCP, improve SEO, and grow the user base.
- Communicate what MikroMCP is (AI-native network automation for MikroTik RouterOS — an MCP server exposing RouterOS as 117 typed, auditable tools) and its features.
- Maximize discoverability for both search engines (SEO) and LLMs (`llms.txt`).
- Produce a static artifact deployable to the user's own nginx server.

## Decisions (locked)

| Decision | Choice |
|---|---|
| First-pass scope | Landing page only |
| Tech stack | **Astro** (static output), structured so a Starlight `docs.mikromcp.com` can be added later as a sibling |
| Hosting | Static `dist/` served by **nginx** on the user's Ubuntu/Hetzner server; domain on **Cloudflare** behind the proxy |
| Visual direction | **Technical / terminal** — dark, near-black, monospace accents, network-topology motifs |
| Primary CTA | **Both equal weight** — `Get Started` + `View on GitHub` side by side in the hero |
| Implementation skill | **Claude Design** (`frontend-design` skill) used during build |
| Logo / favicon | `docs/assets/MikroMCP-logo-square.png` (dark, → favicon + OG fallback); `docs/assets/MikroMCP-logo-transparent.png` (→ nav/footer/hero) |
| LLM discoverability | Ship `/llms.txt` (curated) **and** `/llms-full.txt` (fuller content) at site root |

## Tech & project structure

Standalone Astro site in a new top-level `site/` directory (own `package.json`, isolated from the server's `src/`). Astro emits pure static HTML/CSS to `site/dist/`. Client JS kept minimal: mobile menu toggle, copy-to-clipboard, FAQ accordion, lightweight terminal animation. `prefers-reduced-motion` respected.

```
site/
  astro.config.mjs
  package.json
  public/
    favicon.ico / favicon.png   # from MikroMCP-logo-square.png
    og-image.png                # social share card
    robots.txt
    llms.txt
    llms-full.txt
    assets/                     # logo (transparent), hero, demo gif, screenshots
  src/
    components/                 # Nav, Hero, Terminal, StatStrip, ProblemBlock,
                                # FeatureGrid, HowItWorks, ExamplesTabs,
                                # QuickStart, SafetyBlock, FAQ, CTABand, Footer
    layouts/Base.astro          # <head>, meta, OG, JSON-LD, global styles
    pages/index.astro
    styles/theme.css            # design tokens
```

Build: `npm run build` → `site/dist/`. `@astrojs/sitemap` generates `sitemap.xml`.

## Page sections (top → bottom)

1. **Sticky nav** — transparent over hero, solid on scroll. Logo (transparent PNG), links: Features · How it works · Tools · FAQ · Docs↗ · GitHub↗, plus a `Get Started` button.
2. **Hero** — near-black bg with subtle dotted-grid / topology motif and glowing teal nodes. Headline "AI-native network automation for MikroTik RouterOS", one-line subhead, two equal CTAs (`Get Started` + `View on GitHub`), trust-badge row (117 tools · MIT · RouterOS 7.x · MCP). Animated terminal: a natural-language prompt resolving into tool calls.
3. **Stat strip** — 117 typed tools · idempotent writes · dry-run + rollback · RBAC + audit.
4. **The problem** — "raw router CLI is the wrong abstraction for AI agents" framing (from README).
5. **Feature showcase** — 9-category icon-card grid: Router management, Network operations, Firewall & policy, Routing visibility, Secure access, Diagnostics, Change safety, Production behavior, MCP compatibility.
6. **How it works** — 3 steps (connect MCP client → ask in natural language → MikroMCP validates/audits/executes over RouterOS REST) with a pipeline diagram (validation → audit → circuit breaker → REST).
7. **Real-world examples** — tabbed terminal blocks cycling the 6 README example prompts (inspection, firewall, route change, WireGuard, diagnostics, plan/apply/rollback).
8. **Quick start** — copy-paste install for single-router stdio; tabs for npm / binary / Docker; link to full Getting Started on docs.
9. **Why it's safe** — change-safety highlights: dry-run, idempotent writes, snapshots, rollback, confirmation tokens, per-router circuit breakers.
10. **FAQ** — accordion built from the README FAQ (drives SEO featured snippets; backs the FAQPage JSON-LD).
11. **Final CTA band** — "Bring AI to your MikroTik fleet" + both buttons.
12. **Footer** — docs links, GitHub, license, MCP/RouterOS external links, version.

## Design system (technical / terminal)

- **Palette:** near-black bg `#0B0E11`; elevated cards `#13171C`; **teal/cyan logo gradient as primary brand** (`#0F766E` → brighter cyan); **orange `#EA580C` as the action/CTA accent**; borders `#293239`; off-white text. Dark-only (the terminal aesthetic *is* the brand).
- **Type:** Inter (body/headings) + JetBrains Mono (code, terminal, accent labels). Self-hosted under `public/assets/fonts/` for performance and offline build (no render-blocking third-party requests).
- **Motifs:** faint dotted-grid / topology lines, glowing teal nodes, animated terminal typing, subtle scroll-reveal. Restrained and fast.
- **Reused assets:** transparent logo, `mikromcp-hero.png`, `demo-1.gif`, `claude-review.png` where they fit.
- Fully responsive; accessible contrast (WCAG AA); `prefers-reduced-motion` disables animation.

## SEO

- Per-page `<title>` + meta description; canonical `https://mikromcp.com`.
- Open Graph + Twitter card (`og-image.png`).
- **JSON-LD:** `SoftwareApplication` + `FAQPage` (eligible for Google rich results).
- Semantic HTML, `sitemap.xml`, `robots.txt`.
- Static output → near-100 Lighthouse.
- Target keywords: "MikroTik RouterOS AI automation", "MCP server for network engineers", "RouterOS MCP", "MikroTik MCP server".

## LLM discoverability

- **`/llms.txt`** — curated, concise: one-line description, what it is, key links (GitHub, docs, getting started, available tools), feature summary. Follows the llms.txt convention (H1 + blockquote summary + linked sections).
- **`/llms-full.txt`** — fuller plain-text dump: expanded feature list, the 6 example prompts, FAQ content, install steps — so an LLM can answer questions about MikroMCP without crawling.

## Deployment artifact

`site/DEPLOY.md` containing:
- Build command (`npm run build`).
- rsync/scp one-liner to push `dist/` to the Hetzner box.
- nginx `server` block for `mikromcp.com`: root at the deploy path, gzip, long-cache headers for `/assets/`, security headers, `try_files`, correct `text/plain` for `llms*.txt`.
- Cloudflare notes: proxied (orange cloud), SSL **Full (strict)**, cache static assets, no caching of HTML or tune as desired.
- Optional (noted, not built unless requested): GitHub Action to build + rsync on push to `main`.

## Out of scope (this pass)

- `docs.mikromcp.com` / Starlight wiki migration.
- Backend, forms, analytics integration (can add Cloudflare Web Analytics later — noted).
- CI auto-deploy (optional follow-up).

## Open questions for spec review

- Confirm the teal-primary / orange-CTA palette split feels right (vs. orange-primary as in current README badges).
- Confirm npm + binary + Docker are the three install tabs to feature.
