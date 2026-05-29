# Docs & Wiki Accuracy/Consistency Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all documentation accurate, consistent, and current after phases 1–3, and add automated guards (vitest) so tool-count and tool-list drift cannot recur.

**Architecture:** Approach A — land two anti-staleness tests + a CLAUDE.md doc-sync row first (they fail initially; the failures are the worklist), then sweep all 14 wiki pages + README + ROADMAP in dependency tiers, with `Available-Tools.md` last (the lockstep test backstops it).

**Tech Stack:** Markdown (docs), TypeScript/Vitest (two doc-accuracy tests), existing repo tooling (`npm test`).

**Canonical facts (verified against source; use identically everywhere):**
- Tool count **117** (`allTools.length`, verified).
- Version **v1.5.0** (`package.json`). Node **≥ 22**. RouterOS **7.x**.
- Transports: **stdio** (default), **HTTP/SSE** (`MIKROMCP_TRANSPORT=http`).
- New since these docs were last updated: `MIKROMCP_DEFAULT_ROUTER` + optional `routerId`; usage skill (`skills/mikromcp/`, `Using-the-Skill` page); MCP `instructions` field; slimmer catalog + concise list `content`; `init`/`doctor` updates.

**Known stale strings (found via grep):**
- `docs/wiki/Home.md:3` — "77 typed tools" → 117
- `docs/wiki/Home.md:27` — "All 77 tools" → 117
- `docs/wiki/Architecture.md:19` — diagram "88 typed tools" → 117
- `docs/wiki/Development.md` — "all 77 tools" → 117
- `docs/wiki/RouterOS-API-Setup.md` — "all 77 tools" → 117

---

## File structure

- Create: `test/unit/docs/available-tools-sync.test.ts`
- Create: `test/unit/docs/tool-count-sync.test.ts`
- Modify: `CLAUDE.md` (one doc-sync table row)
- Modify (sweep): `README.md`, `ROADMAP.md`, and all of `docs/wiki/*.md`

---

## Task 1: Anti-staleness tests + doc-sync rule

These tests pin the canonical facts. They are EXPECTED TO FAIL after this task (stale counts in Home/Architecture/Development/RouterOS-API-Setup; possibly missing tool entries in Available-Tools). That failure set is the worklist for Tasks 2–8.

**Files:**
- Create: `test/unit/docs/available-tools-sync.test.ts`
- Create: `test/unit/docs/tool-count-sync.test.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write `test/unit/docs/available-tools-sync.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "../../../src/domain/tools/index.js";

const DOC = join(process.cwd(), "docs/wiki/Available-Tools.md");

/** Tool names are documented as headers: `### `tool_name` — Class`. */
function documentedTools(markdown: string): Set<string> {
  const names = new Set<string>();
  const header = /^#{2,4}\s+`([a-z0-9_]+)`/gm;
  let m: RegExpExecArray | null;
  while ((m = header.exec(markdown)) !== null) names.add(m[1]);
  return names;
}

describe("Available-Tools.md stays in lockstep with allTools", () => {
  const markdown = readFileSync(DOC, "utf-8");
  const documented = documentedTools(markdown);
  const real = new Set(allTools.map((t) => t.name));

  it("documents every tool in allTools", () => {
    const missing = [...real].filter((n) => !documented.has(n)).sort();
    expect(missing, `tools missing from Available-Tools.md: ${missing.join(", ")}`).toEqual([]);
  });

  it("documents no tool that does not exist", () => {
    const unknown = [...documented].filter((n) => !real.has(n)).sort();
    expect(unknown, `unknown tools in Available-Tools.md: ${unknown.join(", ")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Write `test/unit/docs/tool-count-sync.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "../../../src/domain/tools/index.js";

const COUNT = allTools.length;
const FILES = ["README.md", "docs/wiki/Home.md", "docs/wiki/Architecture.md"];

/** Collect stated tool counts: prose ("N tools", "N typed tools", "N MCP tools") and the README badge ("tools-N"). */
function statedCounts(markdown: string): number[] {
  const counts: number[] = [];
  const prose = /\b(\d+)\s+(?:typed\s+|MCP\s+)?tools\b/gi;
  const badge = /tools-(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = prose.exec(markdown)) !== null) counts.push(Number(m[1]));
  while ((m = badge.exec(markdown)) !== null) counts.push(Number(m[1]));
  return counts;
}

describe("stated tool count matches allTools.length", () => {
  for (const file of FILES) {
    it(`${file} states ${COUNT} consistently`, () => {
      const markdown = readFileSync(join(process.cwd(), file), "utf-8");
      const counts = statedCounts(markdown);
      expect(counts.length, `no tool count found in ${file}`).toBeGreaterThan(0);
      const wrong = counts.filter((c) => c !== COUNT);
      expect(wrong, `${file} states tool counts != ${COUNT}: ${wrong.join(", ")}`).toEqual([]);
    });
  }
});
```

- [ ] **Step 3: Run the tests; confirm they FAIL on the known stale data**

Run: `npx vitest run test/unit/docs/`
Expected: FAIL. `tool-count-sync` fails for `docs/wiki/Home.md` (states 77) and `docs/wiki/Architecture.md` (states 88). `available-tools-sync` may pass or fail depending on whether every one of the 117 tools currently has a `### `name`` header — note any "tools missing from Available-Tools.md: ..." list; that is the Task 8 worklist. Do NOT fix anything yet.

- [ ] **Step 4: Add the doc-sync row to `CLAUDE.md`**

In `CLAUDE.md`, in the "### Trigger → required doc updates" table, find the existing row that begins `| Tool added/renamed/removed (skill sync) |`. Add this new row immediately AFTER it:

```markdown
| Tool added/renamed/removed (Available-Tools sync) | `docs/wiki/Available-Tools.md` (the lockstep test `test/unit/docs/available-tools-sync.test.ts` will fail until updated) |
```

Verify: `grep -n "available-tools-sync.test.ts" CLAUDE.md` shows the row.

- [ ] **Step 5: Commit (tests intentionally failing at this point)**

```bash
git add test/unit/docs/available-tools-sync.test.ts test/unit/docs/tool-count-sync.test.ts CLAUDE.md
git commit -m "test(docs): add tool-count and Available-Tools lockstep guards"
```

---

## Task 2: Tier 1 — README.md & Home.md

**Files:** Modify `README.md`, `docs/wiki/Home.md`

- [ ] **Step 1: Fix `Home.md` stale counts**

In `docs/wiki/Home.md`:
- Line ~3: change "77 typed tools" → "117 typed tools".
- Line ~27 (Available Tools row): change "All 77 tools" → "All 117 tools".

- [ ] **Step 2: Update `Home.md` index completeness**

Confirm the page index links every wiki page including `Using-the-Skill` (add a row under "Connecting to an AI assistant" or "Reference": `| [Using the Skill](Using-the-Skill) | Install the usage skill so your assistant drives MikroMCP safely |`). Confirm all relative links use the `[Text](Page)` form (no `.md`, no absolute URLs).

- [ ] **Step 3: Update `README.md`**

- Confirm badges read `version-v1.5.0` and `MCP%20tools-117` (already correct — do not change unless wrong).
- In the feature overview/intro, ensure these phase 1–3 capabilities are mentioned (add concise bullets/sentences where missing; do not duplicate): optional `routerId` with `MIKROMCP_DEFAULT_ROUTER` default-router resolution; the **usage skill** (link to `docs/wiki/Using-the-Skill.md`); the MCP `instructions` field; `mikromcp init`/`doctor`.
- Verify the Available Tools count line (~288 "registers **117 MCP tools**") and the docs link table (~427) are correct.
- Reconcile the roadmap section near the bottom with `ROADMAP.md` (v1.5 shipped; note the phase 1–3 hardening — token/UX optimization, usage skill — as post-1.5 work).
- Apply the consistency contract (terminology: "MikroMCP", "tool", "dry-run").

- [ ] **Step 4: Verify counts test passes for these two files**

Run: `npx vitest run test/unit/docs/tool-count-sync.test.ts`
Expected: `README.md` and `docs/wiki/Home.md` cases PASS (Architecture still fails — fixed in Task 5).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/wiki/Home.md
git commit -m "docs: refresh README and Home — counts, phase 1-3 features, links"
```

---

## Task 3: Tier 2 — Getting-Started, RouterOS-API-Setup, Configuration, Running

**Files:** Modify `docs/wiki/Getting-Started.md`, `docs/wiki/RouterOS-API-Setup.md`, `docs/wiki/Configuration.md`, `docs/wiki/Running.md`

- [ ] **Step 1: `Configuration.md` — canonical env-var table**

This page is the single source for env vars. Read `src/config/app-config.ts` and confirm EVERY `MIKROMCP_*` variable it reads is in the table with correct default, plus `ROUTER_<PREFIX>_USER`/`_PASS`. Confirm `MIKROMCP_DEFAULT_ROUTER` is present (added in phase 2) with a one-line explanation: "Router id used when a tool call omits `routerId`; falls back to the sole configured router when only one exists." Add a short prose paragraph on default-router resolution if not already present.

- [ ] **Step 2: `Getting-Started.md`**

- Verify Step 1–N (enable API, install, `mikromcp init`, connect) against current CLI behavior in `src/cli/init.ts` (the wizard now writes `MIKROMCP_DEFAULT_ROUTER` and prints a skill pointer in next-steps).
- Add a short note that `routerId` is optional once a default router is set.
- Add a brief "Install the usage skill" pointer near the end linking to `Using-the-Skill`.

- [ ] **Step 3: `RouterOS-API-Setup.md`**

- Change "all 77 tools" → "all 117 tools".
- Verify the API-enable, TLS, firewall, and user-policy (full vs read) steps are still accurate for RouterOS 7.x.

- [ ] **Step 4: `Running.md`**

Verify dev/prod run commands against `package.json` scripts and the two transports (stdio default; `MIKROMCP_TRANSPORT=http`).

- [ ] **Step 5: Verify & commit**

Run: `grep -rn "77\|88 typed" docs/wiki/Getting-Started.md docs/wiki/RouterOS-API-Setup.md docs/wiki/Configuration.md docs/wiki/Running.md` → expect no stale tool counts.

```bash
git add docs/wiki/Getting-Started.md docs/wiki/RouterOS-API-Setup.md docs/wiki/Configuration.md docs/wiki/Running.md
git commit -m "docs: refresh setup/config pages — env vars, default router, counts"
```

---

## Task 4: Tier 3 — Connecting pages & Using-the-Skill

**Files:** Modify `docs/wiki/Connecting-to-Claude-Desktop.md`, `docs/wiki/Connecting-to-AI-Assistants.md`, `docs/wiki/Using-the-Skill.md`

- [ ] **Step 1: `Connecting-to-Claude-Desktop.md`**

Verify the registration JSON/snippet (`command: "mikromcp"`, `args: ["serve"]`) and config-file locations match `src/cli/init.ts` (`findClaudeDesktopConfig`). Apply consistency contract.

- [ ] **Step 2: `Connecting-to-AI-Assistants.md`**

Verify Claude Code / Cursor / Codex / HTTP / Docker / systemd instructions. Confirm the "Usage skill" section (added in phase 3) is present and points to `Using-the-Skill`.

- [ ] **Step 3: `Using-the-Skill.md`**

Verify the install paths and the "what's inside" list match the actual `skills/mikromcp/` contents (`SKILL.md` + `references/tool-map.md`, `references/safety-and-recovery.md`, `references/routeros-docs.md`). Light consistency polish only.

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/Connecting-to-Claude-Desktop.md docs/wiki/Connecting-to-AI-Assistants.md docs/wiki/Using-the-Skill.md
git commit -m "docs: verify connecting pages and usage-skill page"
```

---

## Task 5: Tier 4 — Architecture & Error-Handling

**Files:** Modify `docs/wiki/Architecture.md`, `docs/wiki/Error-Handling.md`

- [ ] **Step 1: `Architecture.md` — fix count + reflect features**

- Line ~19 diagram: change "88 typed tools" → "117 typed tools".
- In the request-pipeline description, add: default-router resolution in the executor (optional `routerId` → `MIKROMCP_DEFAULT_ROUTER` → sole router → `MISSING_ROUTER_ID`), and that the server advertises an `instructions` string on initialize.
- Verify the layer/transport/auth descriptions against `src/mcp/` and `src/config/`.

- [ ] **Step 2: `Error-Handling.md` — reconcile with the enum**

Read `src/domain/errors/error-types.ts`. Confirm the page documents exactly the 12 `ErrorCategory` values (VALIDATION, NOT_FOUND, CONFLICT, PERMISSION_DENIED, APPROVAL_REQUIRED, ROUTER_UNREACHABLE, ROUTER_AUTH_FAILED, ROUTER_TIMEOUT, ROUTER_ERROR, ROUTER_BUSY, INTERNAL, CONFIGURATION) with accurate retry/circuit-breaker behavior. Add any missing category; fix any renamed one. Keep it consistent with `skills/mikromcp/references/safety-and-recovery.md`.

- [ ] **Step 3: Verify count test now fully green**

Run: `npx vitest run test/unit/docs/tool-count-sync.test.ts`
Expected: all three files (README, Home, Architecture) PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/Architecture.md docs/wiki/Error-Handling.md
git commit -m "docs: refresh Architecture (count, pipeline) and Error-Handling (enum)"
```

---

## Task 6: Tier 5 — Development & Contributing

**Files:** Modify `docs/wiki/Development.md`, `docs/wiki/Contributing.md`

- [ ] **Step 1: `Development.md`**

- Change "all 77 tools" → "all 117 tools".
- Verify scripts against `package.json` and the MCP Inspector workflow.
- Add a short mention of the doc-accuracy tests (`test/unit/docs/`) and the skill tool-map lockstep (`test/unit/skill/`) alongside the existing test guidance.

- [ ] **Step 2: `Contributing.md`**

In the "adding a tool" workflow, ensure contributors are told to update BOTH `docs/wiki/Available-Tools.md` and `skills/mikromcp/references/tool-map.md` (both enforced by lockstep tests), mirroring `CLAUDE.md`'s doc-sync table. Apply consistency contract.

- [ ] **Step 3: Verify & commit**

Run: `grep -rn "\b77\b\|88 typed" docs/wiki/Development.md docs/wiki/Contributing.md` → expect no stale counts.

```bash
git add docs/wiki/Development.md docs/wiki/Contributing.md
git commit -m "docs: refresh Development and Contributing — counts, test/doc-sync guidance"
```

---

## Task 7: Tier 6 — ROADMAP.md & wiki/Roadmap.md (mirror)

**Files:** Modify `ROADMAP.md`, `docs/wiki/Roadmap.md`

- [ ] **Step 1: Reconcile both roadmap files**

Read both. Ensure v1.5 is marked shipped and the post-1.5 hardening (phase 1 bug-fixes/refactors, phase 2 token/UX optimization, phase 3 usage skill, MCP instructions) is reflected as completed work. Keep `ROADMAP.md` and `docs/wiki/Roadmap.md` mirrored (same milestone statuses and wording where they overlap).

- [ ] **Step 2: Commit**

```bash
git add ROADMAP.md docs/wiki/Roadmap.md
git commit -m "docs: reconcile roadmap (v1.5 shipped, phase 1-3 hardening)"
```

---

## Task 8: Tier 7 — Available-Tools.md (drive lockstep green)

**Files:** Modify `docs/wiki/Available-Tools.md`

- [ ] **Step 1: Get the exact gap list**

Run: `npx vitest run test/unit/docs/available-tools-sync.test.ts`
Read the failure messages:
- "tools missing from Available-Tools.md: ..." → tools that need a new `### `name` — Class` entry.
- "unknown tools in Available-Tools.md: ..." → renamed/removed entries to fix or delete.

Cross-reference with the authoritative dump:
```bash
cat > /tmp/dump.ts <<'EOF'
import { allTools } from "/Users/alikarami/Projects/MikroMCP/src/domain/tools/index.js";
for (const t of allTools) {
  const a = t.annotations;
  const cls = a.destructiveHint ? "Write · Destructive" : a.readOnlyHint ? "Read" : "Write";
  console.log(`${t.name}\t${cls}\t${t.title}`);
}
EOF
cp /tmp/dump.ts ./_dump.ts && npx tsx _dump.ts | sort; rm -f ./_dump.ts
```

- [ ] **Step 2: Add/fix entries**

For each missing tool, add an entry in the correct family section following the existing format exactly:
- Header: `### `tool_name` — <Read|Write|Write · Idempotent|Write · Destructive>`
- One-line description.
- A parameter table (Type / Default / Description columns) — derive parameters and defaults from the tool's Zod `inputSchema` in `src/domain/tools/<file>.ts`.
- An **Example prompt** line a user could paste.
Fix or remove any "unknown tools" entries (renamed/removed). Confirm the intro paragraph states the `routerId`-optional / default-router behavior (already updated in phase 2 — verify).

- [ ] **Step 3: Drive the lockstep test green**

Run: `npx vitest run test/unit/docs/available-tools-sync.test.ts`
Expected: BOTH assertions PASS (no missing, no unknown).

- [ ] **Step 4: Spot-check parameter accuracy**

For 5 representative tools across different families, open the tool source and confirm the documented parameter table matches the Zod schema (names, defaults, required vs optional). Fix mismatches found.

- [ ] **Step 5: Commit**

```bash
git add docs/wiki/Available-Tools.md
git commit -m "docs: sync Available-Tools with all 117 tools (lockstep green)"
```

---

## Task 9: Final verification

- [ ] **Step 1: Full suite green**

Run: `npm test`
Expected: all tests pass, including `test/unit/docs/available-tools-sync.test.ts` and `test/unit/docs/tool-count-sync.test.ts`. Typecheck + lint clean.

- [ ] **Step 2: Internal wiki link check (one-time)**

Run this to list every relative wiki link target and flag any that do not resolve to an existing page:
```bash
cd docs/wiki
for f in *.md; do
  grep -oE "\]\(([A-Za-z0-9-]+)\)" "$f" | sed -E 's/\]\(|\)//g' | while read -r tgt; do
    [ -f "${tgt}.md" ] || echo "$f -> missing: $tgt"
  done
done
cd - >/dev/null
```
Expected: no "missing" lines. Fix any broken links (wrong page name / stray `.md`).

- [ ] **Step 3: Residual staleness sweep**

Run: `grep -rnoiE "\b(77|88) (typed |MCP )?tools" README.md ROADMAP.md docs/wiki/` → expect zero matches.

- [ ] **Step 4: Final commit if fixes were needed**

```bash
git add -A
git commit -m "docs: final verification fixes"
```
