# docs.mikromcp.com — Design Spec

**Date:** 2026-06-02
**Domain:** https://docs.mikromcp.com
**Scope:** Build a Starlight documentation site that renders the existing 15 `docs/wiki/*.md` pages, themed to match the landing page, deployed to nginx on the user's Hetzner box. CI auto-deploy (for both `site/` and `docs-site/`) is the explicitly-scoped **next** project, not part of this one.

## Goals

- Stand up docs.mikromcp.com as the manuals/reference home, fed by the existing wiki content.
- Zero dual maintenance: `docs/wiki/*.md` stays the single source of truth (also still feeding the GitHub wiki via the untouched `sync-wiki.yml`).
- Visually cohesive with mikromcp.com (same dark teal/orange terminal brand).
- Full cross-navigation between the landing site and docs (treat as one product across two subdomains).

## Decisions (locked)

| Decision | Choice |
|---|---|
| Tech | Astro + **Starlight** (`@astrojs/starlight`), standalone project in `docs-site/` |
| Content source | **Reuse `docs/wiki/*.md` as-is** — transformed at build time into Starlight content; the generated content dir is git-ignored |
| Theme | **Match landing page** — dark near-black, teal `#14B8A6` primary, orange `#EA580C` accent, Inter + JetBrains Mono, logo |
| Cross-linking | **Full cross-nav** — docs header links back to mikromcp.com + GitHub; landing `Docs ↗` links already point here |
| Big tools page | `Available-Tools.md` (~2000 lines) stays a **single page** (matches wiki; relies on Starlight TOC + search) |
| Hosting | Static `docs-site/dist/` served by nginx for `docs.mikromcp.com`, domain on Cloudflare behind the proxy |

## Content pipeline (the core mechanism)

The 15 `docs/wiki/*.md` files have a leading `# H1` title, no frontmatter, and wiki-style internal links (e.g. `](Architecture)`, `](Getting-Started#anchor)`, `](RouterOS-API-Setup#required-policies-by-tool-category)`). Starlight needs frontmatter (`title`) and root-relative routes.

A build-time sync script `docs-site/scripts/sync-wiki.mjs` (wired as an npm `prebuild`, and runnable standalone) does the transformation:

1. **Read** every `../docs/wiki/*.md`.
2. **Title:** take the first `# ` heading as the page title; **strip that H1 line** from the body (Starlight renders its own `<h1>` from frontmatter — keeping the markdown H1 would double it).
3. **Frontmatter:** prepend `---\ntitle: <title>\nsidebar:\n  order: <n>\n---`. For `Home.md`, also set the slug to the site root.
4. **Link rewrite:** replace wiki links using a fixed name→slug map (below). `](Foo)` → `](/foo/)`, `](Foo#bar)` → `](/foo/#bar)`. Only rewrite links whose target is one of the known wiki page names; leave external `http(s)://` links and asset links untouched.
5. **Write** to `docs-site/src/content/docs/<slug>.md` (and `index.md` for Home).

The generated `docs-site/src/content/docs/` is git-ignored; it is regenerated on every build. Source edits continue in `docs/wiki/*.md` only.

### Wiki name → route slug map

| Wiki file (and link name) | Title (from H1) | Route |
|---|---|---|
| `Home` | MikroMCP | `/` (index) |
| `Getting-Started` | Getting Started with MikroMCP | `/getting-started/` |
| `RouterOS-API-Setup` | RouterOS API Setup | `/routeros-api-setup/` |
| `Configuration` | Configuration | `/configuration/` |
| `Running` | Running | `/running/` |
| `Connecting-to-Claude-Desktop` | Connecting MikroMCP to Claude Desktop | `/connecting-to-claude-desktop/` |
| `Connecting-to-AI-Assistants` | Connecting MikroMCP to AI Assistants | `/connecting-to-ai-assistants/` |
| `Using-the-Skill` | Using the MikroMCP Skill | `/using-the-skill/` |
| `Available-Tools` | Available Tools | `/available-tools/` |
| `Architecture` | Architecture | `/architecture/` |
| `Error-Handling` | Error Handling | `/error-handling/` |
| `Security` | Security | `/security/` |
| `Development` | Development | `/development/` |
| `Contributing` | Contributing | `/contributing/` |
| `Roadmap` | Roadmap | `/roadmap/` |

Slugs are the lowercased wiki filename. The script derives them programmatically (lowercase the filename, `Home`→index) rather than hardcoding, so a new wiki page needs no script edit — only the sidebar config gets a new entry.

## Site structure & navigation

Starlight config (`astro.config.mjs`) provides:
- **Sidebar** grouped to mirror `Home.md`:
  - **Getting started** — Getting Started, RouterOS API Setup, Configuration, Running
  - **Connect an assistant** — Connecting to Claude Desktop, Connecting to AI Assistants, Using the Skill
  - **Reference** — Available Tools, Architecture, Error Handling, Security
  - **Contributing** — Development, Contributing, Roadmap
- **Header social/nav links:** GitHub repo, and a "Main site ↗" link to `https://mikromcp.com`. Logo links home.
- **Built-in:** Pagefind full-text search, prev/next, per-page TOC, mobile nav, dark/light toggle (default dark).
- `site: "https://docs.mikromcp.com"`, sitemap via Starlight's built-in support.

## Theme (match landing page)

A `docs-site/src/styles/custom.css` overriding Starlight's CSS custom properties:
- Map Starlight's accent palette to teal `#14B8A6` (and `--brand-glow #2DD4BF`, `--brand-deep #0F766E`).
- Background grays → near-black `#0B0E11` / elevated `#13171C`, borders `#293239`, text `#E6EDF3`.
- Orange `#EA580C` for call-to-action / highlight accents (e.g. primary buttons, active states where appropriate).
- Fonts: **reuse the same self-hosted Inter + JetBrains Mono woff2** files from the landing site (copied into `docs-site/public/assets/fonts/`), wired via `@font-face` + Starlight font CSS vars.
- Logo: `MikroMCP-logo-transparent.png` in the header (copied into `docs-site/public/`); `favicon` from `MikroMCP-logo-square.png`.
- Code blocks: theme Shiki/Starlight code styling to fit the dark brand.
- Dark-default; keep Starlight's light theme functional but brand-consistent.

## SEO

- Starlight emits per-page titles, meta description (from frontmatter or a site default), canonical, and sitemap automatically.
- Set a site-level description and social-card/OG image (reuse or adapt the landing OG image) in the Starlight config.
- `robots.txt` allowing all + sitemap reference.

## Deployment artifact

`docs-site/DEPLOY.md`:
- Build: `cd docs-site && npm ci && npm run build` → `docs-site/dist/`.
- rsync to `user@hetzner:/var/www/docs.mikromcp.com/`.
- nginx server block for `docs.mikromcp.com` (gzip, security headers, asset caching, `try_files`).
- Cloudflare notes: proxied, SSL Full (strict), cache static assets.
- Note: a unified CI workflow that builds + deploys BOTH subdomains is the next project; this guide covers the manual path in the meantime.

## File structure

```
docs-site/
  package.json
  astro.config.mjs            # Starlight integration, sidebar, social links, site
  .gitignore                  # dist/, node_modules/, .astro/, src/content/docs/
  scripts/
    sync-wiki.mjs             # transform docs/wiki/*.md -> src/content/docs/*.md
  public/
    favicon.png               # from MikroMCP-logo-square.png
    robots.txt
    assets/
      MikroMCP-logo-transparent.png
      fonts/                  # reused Inter + JetBrains Mono woff2
  src/
    styles/custom.css         # brand theming over Starlight CSS vars
    content/docs/             # GENERATED by sync-wiki.mjs (git-ignored)
  DEPLOY.md
```

## Out of scope (this project)

- CI auto-deploy for both subdomains (explicitly the **next** project).
- Editing/rewriting the wiki content itself (we render it as-is).
- Changing `sync-wiki.yml` or the GitHub wiki flow.
- Splitting `Available-Tools.md` into multiple pages.

## Open questions resolved
- Content pipeline: build-time transform of `docs/wiki/`, generated dir git-ignored. ✓
- Tools page stays single. ✓
- Theme matches landing; reuse fonts/logo. ✓
