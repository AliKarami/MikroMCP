# MikroMCP Usage Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a progressive-disclosure Claude Code skill that teaches a model to drive the MikroMCP server safely (tool selection, dry-run/confirm/rollback flows, diagnosis, fleet ops, error recovery), referencing official MikroTik docs by curated pointer links rather than copying them.

**Architecture:** A lean `skills/mikromcp/SKILL.md` entry point plus three on-demand reference files (`tool-map.md`, `safety-and-recovery.md`, `routeros-docs.md`). A vitest test keeps the tool-map in lockstep with `allTools`. All content is authored markdown; the only code is the lockstep test.

**Tech Stack:** Markdown (skill + references), TypeScript/Vitest (lockstep test), existing repo tooling (`npm test`).

---

## File structure

- Create: `skills/mikromcp/SKILL.md` — lean entry point (frontmatter + golden rules + quick index + core workflows + pointers)
- Create: `skills/mikromcp/references/tool-map.md` — complete intent→tool→REST-path index, grouped by family
- Create: `skills/mikromcp/references/safety-and-recovery.md` — change lifecycle, idempotency outcomes, rollback, error→action table
- Create: `skills/mikromcp/references/routeros-docs.md` — curated help.mikrotik.com pointer index + RouterOS quirks
- Create: `test/unit/skill/tool-map-sync.test.ts` — asserts tool-map names ↔ `allTools` lockstep
- Create: `docs/wiki/Using-the-Skill.md` — what the skill does + install instructions
- Modify: `README.md` — add a one-line pointer to the skill
- Modify: `docs/wiki/Connecting-to-AI-Assistants.md` — add a pointer to the skill
- Modify: `CLAUDE.md` — add a doc-sync trigger row for the tool-map
- Modify: `CHANGELOG.md` — `[Unreleased]` → Added

> **Note on the lockstep check:** the spec described `scripts/check-skill-refs.mjs`. We implement it as a **vitest test** instead, because the repo already runs `allTools`-importing tests under vitest and `npm test` runs vitest — a standalone `.mjs` would need a separate tsx invocation and CI wiring. Same outcome ("wired into `npm test`"), better fit. The test also enforces the reverse direction (every `allTools` tool appears in the map).

---

## Task 1: Scaffold the skill directory and write `SKILL.md`

**Files:**
- Create: `skills/mikromcp/SKILL.md`

- [ ] **Step 1: Create the directory and write `SKILL.md` with this exact content**

````markdown
---
name: mikromcp
description: Use when managing, configuring, or troubleshooting MikroTik RouterOS devices through the MikroMCP server — picking the right tool, running safe (dry-run, confirmed, rollback-able) changes, fleet operations, and diagnosing network issues.
---

# Driving MikroMCP

MikroMCP exposes MikroTik RouterOS management as MCP tools (over stdio or HTTP).
This skill is about operating those tools well and safely. It does not reproduce
RouterOS documentation — when you need to know what a RouterOS field means, see
`references/routeros-docs.md` and fetch the linked official page.

## When to use

- Configuring, inspecting, or troubleshooting a MikroTik router via MikroMCP tools.
- Rolling a change across many routers.

## When not to use

- Devices that are not MikroTik/RouterOS.
- Tasks with no MikroMCP server connected.

## First moves

1. Establish the target router. Tools take an optional `routerId`. If omitted,
   MikroMCP uses `MIKROMCP_DEFAULT_ROUTER`, or the sole configured router. If
   several routers exist and none is defaulted, ask which one.
2. Orient before changing anything: `get_system_status`, then `list_interfaces`
   (and the relevant `list_*` for the area you're touching).

## Golden rules (the safety spine)

1. **Reads are safe; treat every write as consequential.**
2. **Dry-run first.** Call a write tool with `dryRun: true`, show the diff, then
   apply for real. Never skip this for a non-trivial change.
3. **Confirmation tokens.** Destructive tools may require a two-step confirm: the
   first call returns an approval requirement + token; repeat the call with
   `confirmationToken`. This is a guardrail — explain it, don't try to bypass it.
4. **Writes are idempotent.** `already_exists` and `no_change` are SUCCESS, not
   errors. A `CONFLICT` means the resource exists with different config — resolve
   it deliberately (see `references/safety-and-recovery.md`).
5. **Rollback exists.** Write tools snapshot+journal first. To undo, use
   `rollback_change` with the journal ID. Know this before bulk changes.
6. **Prefer dedicated tools over `run_command`.** Use `run_command` only when no
   dedicated tool covers the need.

## Intent → tool quick index

| I want to… | Tool |
|---|---|
| See device health/uptime/version | `get_system_status` |
| List interfaces | `list_interfaces` |
| Add/serve an IP on an interface | `manage_ip_address` |
| Block/allow traffic | `manage_firewall_rule` |
| Port-forward / NAT | `manage_firewall_rule` (table `nat`) |
| Add a static route | `manage_route` |
| Add a DNS record | `manage_dns_entry` |
| See/assign DHCP leases | `list_dhcp_leases`, `manage_dhcp_lease` |
| See who's connected (WiFi) | `list_wifi_clients` |
| Test connectivity | `ping`, `traceroute` |
| Run a change across many routers | `bulk_execute` |
| Undo a change | `rollback_change` |

Full enumeration of every tool by family: `references/tool-map.md`.

## Core workflows

### Make a safe config change
1. `list_*` the area to capture current state.
2. Call the `manage_*` tool with `dryRun: true`; read the returned diff.
3. If a confirmation token is required, re-issue with `confirmationToken`.
4. Apply for real; confirm the `action` in the result (`created`/`updated`).
5. Note the journal ID in case you need `rollback_change`.

### Diagnose connectivity
1. `get_system_status` and `list_interfaces` to confirm links are up.
2. `ping` the target from the router; `traceroute` if it fails partway.
3. Check `list_routes`, `list_firewall_rules`, `list_dns_entries` as the symptom
   suggests. Cross-check field meanings via `references/routeros-docs.md`.

### Fleet rollout
1. Validate the change on ONE router first (dry-run → apply).
2. `bulk_execute` with the tool + params, targeting routerIds or a tag.
3. For destructive tools, complete the fleet confirmation-token step.
4. Review per-router succeeded/failed counts; `rollback_change` per-router if needed.

### Recover from an error
1. Read the error `code`/`category` and `suggestedAction`.
2. Map it to a next step via the error→action table in
   `references/safety-and-recovery.md`.

## Pointers

- Need a tool not in the quick index → `references/tool-map.md`.
- Need RouterOS field meaning, defaults, or version differences →
  `references/routeros-docs.md` (fetch the linked page; don't guess).
- Hit an error, a CONFLICT, or a destructive/confirmation flow →
  `references/safety-and-recovery.md`.
````

- [ ] **Step 2: Verify the file exists and frontmatter is valid**

Run: `head -5 skills/mikromcp/SKILL.md`
Expected: the `---` frontmatter block with `name: mikromcp` and a `description:` line.

- [ ] **Step 3: Commit**

```bash
git add skills/mikromcp/SKILL.md
git commit -m "feat(skill): add MikroMCP usage skill entry point"
```

---

## Task 2: Add the tool-map ↔ allTools lockstep test

This test fails first (no tool-map yet), then passes once Task 3 authors the map.

**Files:**
- Create: `test/unit/skill/tool-map-sync.test.ts`

- [ ] **Step 1: Write the test with this exact content**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "../../../src/domain/tools/index.js";

const MAP_PATH = join(process.cwd(), "skills/mikromcp/references/tool-map.md");

/** Tool names referenced in the map: any `code` span that matches a real tool name shape. */
function toolNamesInMap(markdown: string): Set<string> {
  const names = new Set<string>();
  const codeSpan = /`([a-z][a-z0-9_]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = codeSpan.exec(markdown)) !== null) {
    names.add(m[1]);
  }
  return names;
}

describe("skill tool-map stays in lockstep with allTools", () => {
  const markdown = readFileSync(MAP_PATH, "utf-8");
  const mapped = toolNamesInMap(markdown);
  const real = new Set(allTools.map((t) => t.name));

  it("every tool in allTools is documented in tool-map.md", () => {
    const missing = [...real].filter((name) => !mapped.has(name)).sort();
    expect(missing, `tools missing from tool-map.md: ${missing.join(", ")}`).toEqual([]);
  });

  it("every tool name referenced in tool-map.md exists in allTools", () => {
    // Only check tokens that look like tool names (verb_noun); ignore RouterOS
    // paths and field names by requiring an underscore and a known verb prefix.
    const verbs = ["list", "get", "manage", "create", "export", "run", "set", "ping", "traceroute", "torch", "reboot", "rollback", "plan", "apply", "bulk", "check", "upload"];
    const referencedTools = [...mapped].filter((n) =>
      verbs.some((v) => n === v || n.startsWith(v + "_")),
    );
    const unknown = referencedTools.filter((name) => !real.has(name)).sort();
    expect(unknown, `unknown tool names in tool-map.md: ${unknown.join(", ")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (no map file yet)**

Run: `npx vitest run test/unit/skill/tool-map-sync.test.ts`
Expected: FAIL — `ENOENT` reading `tool-map.md` (file does not exist yet).

- [ ] **Step 3: Commit the test**

```bash
git add test/unit/skill/tool-map-sync.test.ts
git commit -m "test(skill): lockstep check between tool-map and allTools"
```

---

## Task 3: Author `references/tool-map.md` until the lockstep test passes

**Files:**
- Create: `skills/mikromcp/references/tool-map.md`

- [ ] **Step 1: Dump every tool name + safety class from the live source**

Run this to generate authoritative rows (copy the output into the table below):

```bash
cat > /tmp/dump-tools.ts <<'EOF'
import { allTools } from "/Users/alikarami/Projects/MikroMCP/src/domain/tools/index.js";
for (const t of allTools) {
  const a = t.annotations;
  const cls = a.destructiveHint ? "destructive" : a.readOnlyHint ? "read" : "write";
  console.log(`${t.name}\t${cls}\t${t.title}`);
}
EOF
cp /tmp/dump-tools.ts ./_dump.ts && npx tsx _dump.ts | sort; rm -f ./_dump.ts
```

Expected: one line per tool, e.g. `list_interfaces  read  List Interfaces`, `manage_firewall_rule  write  Manage Firewall Rule`. There are ~117 lines.

- [ ] **Step 2: Write `references/tool-map.md` using this structure**

Header + one section per family. Each row: **intent → `tool_name` → `ros/rest/path` → class**. REST paths come from the table in `CLAUDE.md` ("RouterOS paths (reference)"). Every tool from Step 1 MUST appear in exactly one section. Use this skeleton and fill all families (Firewall shown fully worked as the pattern to follow):

````markdown
# Tool map

Every MikroMCP tool, grouped by RouterOS area. Columns: what you want →
tool → REST path it hits → safety class (read / write / destructive).
The quick index in `SKILL.md` covers the common cases; this is the full set.

Multi-tool patterns:
- **Expose an internal service** = NAT dst-nat rule (`manage_firewall_rule` table
  `nat`) + an allow rule in `filter` + optionally an `address-list` entry.
- **New subnet on a port** = `manage_ip_address` + `manage_dhcp_server` (+ pool
  via `manage_ip_pool`) + a firewall rule.

## Firewall & NAT
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List filter/nat/mangle rules | `list_firewall_rules` | `ip/firewall/filter` | read |
| Add/remove/toggle a filter or NAT rule | `manage_firewall_rule` | `ip/firewall/filter`, `ip/firewall/nat` | write |
| List mangle rules | `list_mangle_rules` | `ip/firewall/mangle` | read |
| Add/remove a mangle rule | `manage_mangle_rule` | `ip/firewall/mangle` | write |
| List address-list entries | `list_address_list_entries` | `ip/firewall/address-list` | read |
| Add/remove an address-list entry | `manage_address_list_entry` | `ip/firewall/address-list` | write |

## System
| Intent | Tool | REST path | Class |
|---|---|---|---|
| … | … | … | … |

## Interfaces & bridges
## IP, DNS & addressing
## DHCP
## Routing
## VPN (WireGuard / OpenVPN / IPSec / PPP / PPPoE)
## Wireless
## Queues
## Users & access
## Files, scripts & scheduler
## Containers
## Diagnostics
## Change management & fleet
````

Author the remaining sections by placing every dumped tool into the most natural
family, writing a plain-English intent phrase and the REST path from `CLAUDE.md`.

- [ ] **Step 3: Run the lockstep test until green**

Run: `npx vitest run test/unit/skill/tool-map-sync.test.ts`
Expected: PASS both assertions. If "tools missing from tool-map.md" lists names,
add rows for them. If "unknown tool names" lists names, fix the typo.

- [ ] **Step 4: Commit**

```bash
git add skills/mikromcp/references/tool-map.md
git commit -m "feat(skill): complete tool-map reference, lockstep test green"
```

---

## Task 4: Author `references/safety-and-recovery.md`

**Files:**
- Create: `skills/mikromcp/references/safety-and-recovery.md`

- [ ] **Step 1: Write the file with this exact content**

````markdown
# Safety & recovery

## The change lifecycle

1. **Inspect** with a `list_*`/`get_*` tool.
2. **Dry-run** the `manage_*` tool with `dryRun: true`. The result's
   `structuredContent.action` is `dry_run` and includes a `diff`.
3. **Confirm if required** (destructive tools): the first real call returns an
   `APPROVAL_REQUIRED` error carrying a `confirmationToken`. Re-issue the same
   call with that `confirmationToken`. Tokens are HMAC-signed and scoped to the
   tool+router+args; they are required in HTTP mode and for non-admin identities.
4. **Apply** and read the `action`: `created`, `updated`, or `removed`.

## Idempotency outcomes (all are SUCCESS unless noted)

| `action` | Meaning | What to do |
|---|---|---|
| `created` / `updated` / `removed` | The change was applied | Note the journal ID |
| `already_exists` | Identical resource already present | Nothing — desired state reached |
| `no_change` | Update requested but nothing differed | Nothing |
| `dry_run` | Preview only | Review `diff`, then apply for real |
| `CONFLICT` (error) | Resource exists with DIFFERENT config | Decide: remove existing first, or change your request. See the error's `details` (existing vs requested) and `alternativeTools` |

## Rollback

Write tools take a config snapshot and write a journal entry before applying.
- Find the journal ID in the apply result or the server's write journal.
- Undo with `rollback_change` (`dryRun: true` first to preview the restore plan).
- Requires `MIKROMCP_DATA_DIR` (defaults to `data/`).

## Circuit breaker & retries

- Each router has a circuit breaker. After repeated failures it "opens"
  (`CIRCUIT_OPEN`) and rejects calls until a cooldown elapses — wait and retry.
- Read tools auto-retry with backoff; write tools do not (to avoid duplicate
  side effects).

## Error → action table

| Category / code | Meaning | Next step |
|---|---|---|
| `VALIDATION` / `MISSING_ROUTER_ID` | Bad params, or no router resolved | Fix params; provide `routerId` or set `MIKROMCP_DEFAULT_ROUTER` |
| `NOT_FOUND` | Target resource/router absent | Verify with the matching `list_*`; check the id/name |
| `CONFLICT` | Exists with different config | Remove-then-recreate, or adjust the request (see above) |
| `PERMISSION_DENIED` | Identity lacks rights, or outside maintenance window | Use an allowed identity; wait for the window; check `details` |
| `APPROVAL_REQUIRED` | Destructive op needs confirmation | Re-issue with the returned `confirmationToken` |
| `ROUTER_UNREACHABLE` | Network/TLS failure to the router | Check host/port/TLS in `routers.yaml`; verify the router is up |
| `ROUTER_AUTH_FAILED` | Bad credentials | Fix `ROUTER_<PREFIX>_USER`/`_PASS`; pooled client is evicted automatically |
| `ROUTER_TIMEOUT` | Router too slow to respond | Retry; check router load |
| `ROUTER_ERROR` | RouterOS rejected the request | Read the message; verify the operation is valid for this ROS version |
| `ROUTER_BUSY` / `CIRCUIT_OPEN` | Breaker open after failures | Wait for cooldown, then retry |
| `INTERNAL` | Unexpected server error | Check server logs; not user-fixable |
| `CONFIGURATION` | Server misconfigured at startup | Fix `routers.yaml` / env vars |
````

- [ ] **Step 2: Verify the category list matches the source enum**

Run: `grep -oE "[A-Z_]+ = " src/domain/errors/error-types.ts`
Expected: every enum member (VALIDATION, NOT_FOUND, CONFLICT, PERMISSION_DENIED, APPROVAL_REQUIRED, ROUTER_UNREACHABLE, ROUTER_AUTH_FAILED, ROUTER_TIMEOUT, ROUTER_ERROR, ROUTER_BUSY, INTERNAL, CONFIGURATION) appears as a row in the table above. Add any that are missing.

- [ ] **Step 3: Commit**

```bash
git add skills/mikromcp/references/safety-and-recovery.md
git commit -m "feat(skill): add safety & recovery reference"
```

---

## Task 5: Author `references/routeros-docs.md` (the pointer index)

**Files:**
- Create: `skills/mikromcp/references/routeros-docs.md`

- [ ] **Step 1: Write the file with this content (verified seed URLs included)**

````markdown
# RouterOS documentation pointers

**Rule:** For RouterOS field semantics, defaults, valid values, or version
differences, FETCH the linked official page — do not guess. These are pointers,
not copies. MikroMCP tool behavior is the source of truth for *how* to act; the
official docs are the source of truth for *what a setting means*.

If a deep link 404s, start from the RouterOS space root and search:
- RouterOS space: https://help.mikrotik.com/docs/spaces/ROS/pages/328059/RouterOS
- REST API guide: https://help.mikrotik.com/docs/spaces/ROS/pages/47579162/REST+API

## Family → official doc → REST path

| Family | Official doc (help.mikrotik.com) | REST path |
|---|---|---|
| REST API basics | https://help.mikrotik.com/docs/spaces/ROS/pages/47579162/REST+API | `/rest` |
| Users & groups | https://help.mikrotik.com/docs/spaces/ROS/pages/8978504/User | `user`, `user/group` |
| Firewall | search "Firewall" in the ROS space | `ip/firewall/*` |
| Routing | search "Routing" in the ROS space | `ip/route`, `routing/*` |
| DHCP | search "DHCP" in the ROS space | `ip/dhcp-server/*`, `ip/dhcp-client` |
| DNS | search "DNS" in the ROS space | `ip/dns`, `ip/dns/static` |
| WireGuard | search "WireGuard" in the ROS space | `interface/wireguard*` |
| Wireless / WiFi | search "WiFi" in the ROS space | `interface/wifi` or `interface/wireless` |
| IPSec | search "IPsec" in the ROS space | `ip/ipsec/*` |
| Queues | search "Queue" in the ROS space | `queue/*` |
| Containers | search "Container" in the ROS space | `container*` |

> When you add a row, search help.mikrotik.com for the feature, open the ROS-space
> page, confirm it loads, and paste its URL. Replace any "search …" cell with the
> verified deep link as you confirm it.

## RouterOS quirks (MikroMCP/RouterOS facts, not doc copies)

- Field names are **kebab-case**: `dst-address`, `routing-table`, `mac-address`.
- The id field is `.id` (e.g. `*1`).
- Booleans come back as the **strings** `"true"`/`"false"`, not JSON booleans.
- WiFi lives at `interface/wifi` on ROS 7.13+, `interface/wireless` on older.
````

- [ ] **Step 2: Verify the two seed URLs resolve**

Use WebFetch on both seed URLs (REST API page and RouterOS space root) and confirm each returns RouterOS documentation content (not a 404). If either has moved, update it from a `help.mikrotik.com` search before committing.

- [ ] **Step 3: Commit**

```bash
git add skills/mikromcp/references/routeros-docs.md
git commit -m "feat(skill): add RouterOS documentation pointer index"
```

---

## Task 6: Distribution docs and changelog

**Files:**
- Create: `docs/wiki/Using-the-Skill.md`
- Modify: `README.md`
- Modify: `docs/wiki/Connecting-to-AI-Assistants.md`
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Create `docs/wiki/Using-the-Skill.md`**

````markdown
# Using the MikroMCP Skill

MikroMCP ships a Claude Code **skill** at `skills/mikromcp/` that teaches an AI
assistant to drive the tools safely — picking the right tool, running
dry-run → confirm → apply changes, fleet rollouts, and error recovery. It links to
official MikroTik documentation rather than copying it.

## Install (personal use)

Symlink (or copy) the skill into your Claude Code skills directory:

```bash
ln -s "$PWD/skills/mikromcp" ~/.claude/skills/mikromcp
# or: cp -r skills/mikromcp ~/.claude/skills/mikromcp
```

Restart Claude Code; the skill activates automatically when you work with MikroTik
routers through MikroMCP.

## What's inside

- `SKILL.md` — entry point: golden safety rules, intent→tool quick index, core
  workflows.
- `references/tool-map.md` — every tool by family with its REST path.
- `references/safety-and-recovery.md` — change lifecycle, idempotency, rollback,
  error→action table.
- `references/routeros-docs.md` — curated links into help.mikrotik.com.

The tool-map is kept in lockstep with the server's tools by a test in
`test/unit/skill/tool-map-sync.test.ts` (runs under `npm test`).
````

- [ ] **Step 2: Add a pointer to `README.md`**

Find the "Available Tools" or documentation/links section and add this line under it:

```markdown
- **[Using the Skill](docs/wiki/Using-the-Skill.md)** — install the MikroMCP usage skill so your AI assistant drives the tools safely.
```

Run: `grep -n "Using the Skill" README.md`
Expected: the new line is present.

- [ ] **Step 3: Add a pointer to `docs/wiki/Connecting-to-AI-Assistants.md`**

Append this section at the end of the file:

```markdown
## Usage skill

For best results, install the MikroMCP usage skill so the assistant knows how to
drive the tools safely (dry-run → confirm → rollback, fleet ops, diagnosis). See
[Using the Skill](Using-the-Skill.md).
```

Run: `grep -n "Usage skill" docs/wiki/Connecting-to-AI-Assistants.md`
Expected: the new section is present.

- [ ] **Step 4: Add a doc-sync trigger row to `CLAUDE.md`**

In the "Trigger → required doc updates" table, add this row immediately after the
existing "New tool added" row:

```markdown
| Tool added/renamed/removed (skill sync) | `skills/mikromcp/references/tool-map.md` (the lockstep test `test/unit/skill/tool-map-sync.test.ts` will fail until updated) |
```

Run: `grep -n "tool-map.md" CLAUDE.md`
Expected: the new row is present.

- [ ] **Step 5: Add a CHANGELOG entry**

In `CHANGELOG.md` under `## [Unreleased]`, add (create the `### Added` subsection if absent):

```markdown
### Added
- MikroMCP usage skill (`skills/mikromcp/`) — a progressive-disclosure Claude Code skill for driving the tools safely (tool selection, dry-run/confirm/rollback flows, fleet ops, error recovery) with curated links to official MikroTik documentation. See `docs/wiki/Using-the-Skill.md`.
```

- [ ] **Step 6: Commit**

```bash
git add docs/wiki/Using-the-Skill.md README.md docs/wiki/Connecting-to-AI-Assistants.md CLAUDE.md CHANGELOG.md
git commit -m "docs(skill): install guide, pointers, changelog, doc-sync rule"
```

---

## Task 7: Final verification

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all tests pass, including `test/unit/skill/tool-map-sync.test.ts` (both lockstep assertions green). Typecheck and lint clean.

- [ ] **Step 2: Manual smoke check (record results)**

With the skill installed locally, confirm it triggers and routes correctly on:
1. "block 1.2.3.4 on the gateway router" → expects `manage_firewall_rule` with `dryRun: true` first.
2. "why can't host 192.168.88.20 reach the internet?" → expects `ping`/`traceroute` + `list_routes`/`list_firewall_rules`.
3. "add this firewall rule to all edge routers" → expects validate-on-one then `bulk_execute` by tag.

Expected: each ask surfaces the golden rules (dry-run/confirm) and the right tools.

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "test(skill): verification fixes"
```
