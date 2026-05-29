# Phase 3 — MikroMCP Usage Skill (design)

**Date:** 2026-05-29
**Status:** Approved (brainstorming) — pending implementation plan
**Author:** Phase 3 of the v1.5.0 hardening effort

## Goal

Create a Claude Code **skill** that teaches a model how to *drive the MikroMCP
server well* — tool selection, safe change flows, diagnosis, fleet operations,
idempotency, and error recovery. The skill references official MikroTik
documentation by **pointing to it** (curated `help.mikrotik.com` links), never by
copying it, so the model knows where to fetch authoritative RouterOS detail on
demand.

This is a playbook for operating MikroMCP — not a RouterOS textbook and not a
runtime dependency on any external doc server (e.g. `tikoci/rosetta`, which is a
separate 50 MB SQLite FTS doc-search MCP server; we deliberately do not depend on
it).

## Non-goals (v1 / YAGNI)

- Copying or bundling RouterOS documentation content.
- A runtime dependency on rosetta or any other doc-search server.
- Per-tool exhaustive playbooks for all ~117 tools.
- The MCP server `instructions`-field tweak — agreed as a **separate follow-up
  PR** after this skill lands.

## Architecture — Approach B (progressive disclosure)

A lean entry point that routes to bundled reference files loaded only on demand.

```
skills/
  mikromcp/
    SKILL.md                      # lean entry point (always loads on trigger)
    references/
      tool-map.md                 # intent → tool → REST path, by family
      safety-and-recovery.md      # dry-run/confirm/rollback, errors → action
      routeros-docs.md            # curated help.mikrotik.com pointer index
```

The repo is the **source of truth**; the skill is also documented for install into
`~/.claude/skills/` (personal) or a plugin's `skills/` directory (distribution).

### Design rules

1. **No secrets, no invented behavior.** The skill never hardcodes credentials and
   explicitly instructs the model to fetch the referenced MikroTik doc rather than
   guess RouterOS field semantics.
2. **Tool-name agnostic except in one place.** Tools are referred to by stable
   names; `references/tool-map.md` is the single file that enumerates them, so a
   catalog change touches one file.
3. **MikroMCP behavior is the source of truth for *how* to act; MikroTik docs are
   the source of truth for *what a setting means*.**

## Component: `SKILL.md` (entry point)

Target ~150–200 lines. A model that reads only this file can operate MikroMCP
safely for common tasks.

YAML frontmatter (the only always-in-context text):

```yaml
---
name: mikromcp
description: Use when managing, configuring, or troubleshooting MikroTik
  RouterOS devices through the MikroMCP server — picking the right tool,
  running safe (dry-run/confirmed/rollback-able) changes, fleet operations,
  and diagnosing network issues.
---
```

Body sections:

1. **When to use / when not** — manage/configure/diagnose a MikroTik via MikroMCP;
   not for non-RouterOS gear.
2. **First moves** — establish target router (`routerId`, or default-router
   behavior); orient with `get_system_status` / `list_interfaces` before changing
   anything.
3. **The golden rules** (safety spine, stated once):
   - Read freely; treat every write as consequential.
   - Always `dryRun: true` first, show the diff, then apply.
   - Destructive ops may require a confirmation token (two-step) — explain it.
   - Writes are idempotent — `already_exists` / `no_change` are success.
   - Rollback exists (`rollback_change` with a journal ID) — know it before bulk
     changes.
   - Prefer dedicated tools over `run_command`.
4. **Intent → tool quick index** — compact table of the ~12 most common intents;
   full enumeration linked in `references/tool-map.md`.
5. **Core workflows** — 3–5 short numbered playbooks: safe config change, diagnose
   connectivity, fleet rollout (`bulk_execute`), recover from an error. Each 4–6
   steps, pointing to references for edge cases.
6. **Pointers** — one line each to the three reference files.

## Component: `references/tool-map.md`

Complete intent→tool index, organized by RouterOS family (System, Interfaces,
IP/DNS, DHCP, Firewall/NAT, Routing, VPN, Wireless, Queues, Users, Diagnostics,
Change-management, Fleet, …). Each row:

> **intent phrase → tool name → REST path → read/write/destructive tag**

Also documents the handful of multi-tool patterns (e.g. "expose a service = NAT
rule + firewall rule + maybe address-list"). This is the single source enumerating
tools.

## Component: `references/safety-and-recovery.md`

- Dry-run → confirm → apply lifecycle in detail, incl. the confirmation-token
  two-step HTTP flow.
- Idempotency outcomes (`already_exists`, `no_change`, `CONFLICT`) and reactions.
- Snapshot/journal/rollback: finding a journal ID and using `rollback_change`.
- Circuit-breaker & retry behavior (why a router may be temporarily "open"; reads
  auto-retry).
- **Error → action table**: maps `MikroMCPError` categories/codes (VALIDATION,
  NOT_FOUND, CONFLICT, PERMISSION_DENIED, ROUTER_AUTH_FAILED,
  OUTSIDE_MAINTENANCE_WINDOW, CIRCUIT_OPEN, …) to the right next step. Sourced from
  `src/domain/errors/error-types.ts`.

## Component: `references/routeros-docs.md` (the "legitimate references")

- Leading rule: *"For RouterOS field semantics, defaults, or version differences,
  fetch the linked official doc — do not guess. These are pointers, not copies.
  MikroMCP tool behavior is the source of truth for how to act; the docs for what a
  setting means."*
- Table: **family → canonical `help.mikrotik.com` URL(s) → relevant REST
  path(s)**, plus top-level anchors (REST API guide, firewall, routing, WireGuard,
  WiFi/CAPsMAN).
- Short note on recurring RouterOS quirks (kebab-case fields, boolean-as-string
  `"true"`, `.id` ids) — MikroMCP/RouterOS facts, not doc copies.

## Accuracy & anti-staleness

- `scripts/check-skill-refs.mjs`: enforces the tool-map and `allTools` stay in
  lockstep — **fails** if a tool named in `references/tool-map.md` does not exist in
  `allTools` (stale/renamed entry), and **fails** if a tool in `allTools` is absent
  from the map (new tool not yet documented). Wired into `npm test`. **This is the
  only code authored in this phase**; the rest is markdown.
- Doc URLs are not checked in CI (network-dependent); verified once at authoring
  time. The "fetch, don't invent" rule means a stale link degrades gracefully.
- The tool-map and error table are generated/verified against live source
  (`allTools`, `error-types.ts`) during implementation so v1 ships accurate.

## Distribution & docs

- New wiki page `docs/wiki/Using-the-Skill.md`: what the skill does + install via
  copy or symlink, e.g.:
  ```bash
  ln -s "$PWD/skills/mikromcp" ~/.claude/skills/mikromcp
  ```
- Pointer from `README.md` and `docs/wiki/Connecting-to-AI-Assistants.md`.
- CLAUDE.md "Trigger → required doc updates" table gains a row: *new/renamed/removed
  tool → update `skills/mikromcp/references/tool-map.md`* (enforced by the check
  script).
- `CHANGELOG.md` `[Unreleased]` → Added.

## Testing / verification

1. `node scripts/check-skill-refs.mjs` passes (all mapped tools real).
2. `npm test` green (check included).
3. Manual smoke: trigger the skill on representative asks — "block 1.2.3.4 on the
   gateway", "why can't host X reach the internet", "add this firewall rule to all
   edge routers" — and confirm correct tool routing and the dry-run→confirm flow.

## Follow-up (separate PR, agreed)

Populate the MCP server's currently-empty `instructions` field (`src/mcp/server.ts`)
with a tiny always-on nudge (destructive ops need confirmation; prefer dedicated
tools over `run_command`; a usage skill exists) so any client benefits even without
the skill installed.
