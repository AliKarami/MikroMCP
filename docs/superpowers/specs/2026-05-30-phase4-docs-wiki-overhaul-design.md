# Phase 4 — Docs & Wiki Accuracy/Consistency Overhaul (design)

**Date:** 2026-05-30
**Status:** Approved (brainstorming) — pending implementation plan
**Author:** Phase 4 of the v1.5.0 hardening effort

## Goal

Bring all documentation into accurate, consistent, current shape after phases 1–3.
This is an **accuracy + consistency overhaul** (Approach A), not a from-scratch
rewrite: keep the existing structure, fix all staleness, reflect every phase 1–3
change, enforce consistent terminology/structure/cross-links, and rewrite weak or
thin sections. Add automated guards so the docs cannot silently drift again.

## Scope

**In scope:** all 14 wiki pages (`docs/wiki/*.md`), `README.md`, `ROADMAP.md`.
**Out of scope (YAGNI):** CHANGELOG rewrite (append-only, already current); a
permanent link-checker test; auto-generating `Available-Tools.md` from source;
doc site generators or tooling.

## Known staleness (worklist seed)

- `Home.md`, `Development.md`, `RouterOS-API-Setup.md` say **77 tools**; the real
  count is **117** (`allTools.length`). README and Available-Tools already say 117.
- Phase 1–3 features are not reflected outside the files we directly touched:
  optional `routerId` + default-router resolution, `MIKROMCP_DEFAULT_ROUTER`, the
  usage skill (`skills/mikromcp/` + Using-the-Skill page), the MCP `instructions`
  field, the slimmer tool catalog + concise list `content`, and `init`/`doctor`
  updates.

## Section 1 — Consistency contract

Every page must conform to these. Facts are verified against source before writing.

**Canonical facts:**
- Tool count: **117** (`allTools.length`) — one number, identical everywhere.
- Version: **v1.5.0** (`package.json`).
- Node **≥ 22**; RouterOS **7.x** (REST API).
- Transports: **stdio** (default) and **HTTP/SSE** (`MIKROMCP_TRANSPORT=http`).
- Env vars: the full `MIKROMCP_*` + `ROUTER_<PREFIX>_*` set, including
  **`MIKROMCP_DEFAULT_ROUTER`** — documented canonically in `Configuration.md`;
  other pages link to it rather than re-listing.
- Phase 1–3 features that must appear somewhere appropriate: optional `routerId` +
  default-router resolution; usage skill; MCP `instructions` field; slimmer catalog
  + concise list `content`; `init`/`doctor` updates.

**Terminology (one spelling each):** "MikroMCP"; "tool" (not "command"); "router
registry" / `routers.yaml`; "identity" for auth principals; "dry-run" (hyphenated);
tool classes "read / write / destructive".

**Structure conventions:** one-line purpose under the H1; H1 = page title; relative
wiki links (`[Text](Page)`); language-tagged code fences; env vars and REST paths in
backticks; no duplicated canonical tables — link to the single source.

## Section 2 — Anti-staleness tests

Two vitest files under `test/unit/docs/` (they import `allTools`, so `npm test`
runs them). They land FIRST and initially fail; the failures are the worklist.

1. **`available-tools-sync.test.ts`** — two-way lockstep between
   `docs/wiki/Available-Tools.md` and `allTools`:
   - every `allTools` tool has an entry in the doc (no missing tools);
   - every tool-name token in the doc resolves to a real tool (no stale/renamed
     entries).
   Parses tool names from section headers / inline-code spans (same technique as
   `test/unit/skill/tool-map-sync.test.ts`).

2. **`tool-count-sync.test.ts`** — the stated tool count equals `allTools.length`
   everywhere it appears: `README.md` (the `MCP%20tools-<N>` badge AND the
   "registers **N** MCP tools" prose), `Home.md`, `Architecture.md`. Each failure
   names the offending file.

**Doc-sync rule:** add a row to `CLAUDE.md`'s "Trigger → required doc updates" table
— *new/renamed/removed tool → update `docs/wiki/Available-Tools.md` (lockstep test
enforces)* — beside the existing skill tool-map row.

## Section 3 — Per-page audit plan (dependency order)

Each page: fix staleness → reflect phase 1–3 features → apply the consistency
contract → verify commands/paths/examples against source.

**Tier 1 — Entry/index**
- `README.md` — confirm badges (v1.5.0, 117); reflect default-router, skill, MCP
  instructions in the feature overview; verify tool table + quick-start; reconcile
  the roadmap section.
- `Home.md` — `77 → 117` (×2); ensure all 14 pages (incl. Using-the-Skill) indexed.

**Tier 2 — Setup/config**
- `Getting-Started.md` — verify install/`init`/connect flow; add default-router
  behavior; add skill-install pointer.
- `RouterOS-API-Setup.md` — `all 77 tools → 117`; verify API/TLS/firewall/user steps.
- `Configuration.md` — canonical env-var table (ensure `MIKROMCP_DEFAULT_ROUTER`
  documented + explained); verify every var against `src/config/app-config.ts`.
- `Running.md` — verify dev/prod run commands and transports.

**Tier 3 — Connecting**
- `Connecting-to-Claude-Desktop.md` / `Connecting-to-AI-Assistants.md` — verify
  registration per client; keep the Usage-skill pointer.
- `Using-the-Skill.md` — verify accuracy; light consistency polish.

**Tier 4 — Reference/internals**
- `Architecture.md` — fix count; add default-router resolution + MCP instructions to
  the pipeline description; verify layers/auth model.
- `Error-Handling.md` — reconcile the 12 `ErrorCategory` values + retry/circuit
  breaker behavior with `src/domain/errors/error-types.ts` and the skill safety ref.

**Tier 5 — Contributor**
- `Development.md` — `77 → 117`; verify scripts + MCP Inspector; mention the
  doc-accuracy / tool-map tests.
- `Contributing.md` — adding-a-tool workflow; point at doc-sync requirements
  (Available-Tools + skill tool-map lockstep).

**Tier 6 — Roadmap (mirror the pair)**
- `ROADMAP.md` + `docs/wiki/Roadmap.md` — reconcile v1.5 shipped + phase 1–3
  hardening; keep the two mirrored.

**Tier 7 — Largest, last**
- `Available-Tools.md` — drive the lockstep test to green: add missing tools, fix
  renamed/stale entries, confirm the intro's `routerId`-optional note, spot-check
  parameter tables against the Zod schemas.

## Section 4 — Sequencing, chunking & verification

**Commits (reviewable):**
1. Tests + CLAUDE.md doc-sync row (fail initially — worklist).
2–7. One commit per tier (Tiers 1→6).
8. `Available-Tools.md` (lockstep-green), its own commit.
9. Final verification fixes if needed.

**Verification:**
- `npm test` green — both new doc tests pass alongside the full suite; typecheck +
  lint clean.
- One-time internal-link check during the sweep: grep every relative wiki link and
  confirm the target page exists (not a permanent test).
- Source-of-truth spot checks: env vars vs `app-config.ts`, error categories vs
  `error-types.ts`, run commands vs `package.json`, tool params vs Zod schemas.

## Risks

- `Available-Tools.md` is ~2,000 lines; the lockstep test guarantees tool-name
  completeness but not parameter-level accuracy — spot-checks against Zod schemas
  mitigate, full per-parameter re-verification is not guaranteed.
- The tool-count regex must avoid false positives (e.g. "2 transports"); it anchors
  on the word "tools" and the badge pattern, and is unit-tested against the real
  files during implementation.
