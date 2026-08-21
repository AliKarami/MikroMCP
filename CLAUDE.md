# MikroMCP — Claude Code Guide

> For the full feature roadmap (milestones v0.4–v1.0, planned tools and subsystems) see **[ROADMAP.md](./ROADMAP.md)**.

## Commands

```bash
npm run dev          # tsx watch hot-reload (development)
npm run build        # tsup → dist/main.js (ESM)
npm start            # run built server
npm test             # vitest run once
npm run test:watch   # vitest watch mode
npm run typecheck    # tsc --noEmit (no output, type checking only)
npm run lint         # eslint src/
npm run format       # prettier --write src/ test/
```

Run `npm test` before pushing a branch (runs vitest, tsc, and eslint).

## Architecture in one sentence

MCP clients speak JSON-RPC to MikroMCP over stdio or HTTP/SSE; MikroMCP routes each tool call through a per-router circuit breaker (and retry engine for read tools) before hitting the RouterOS REST API over HTTPS.

## Key file map

| File | What it does |
|---|---|
| `src/main.ts` | Entry point — loads config, wires transport |
| `src/mcp/tool-registry.ts` | Registers all tools with the MCP server; injects circuit breaker, retry, correlation ID, credentials |
| `src/domain/tools/index.ts` | **Add new tool arrays here** to expose them |
| `src/domain/tools/tool-definition.ts` | `ToolDefinition`, `ToolContext`, `ToolResult` interfaces |
| `src/domain/errors/error-types.ts` | `MikroMCPError`, `ErrorCategory` enum, `Recoverability` |
| `src/domain/errors/error-enricher.ts` | Maps HTTP/network errors to `MikroMCPError` |
| `src/adapter/rest-client.ts` | `RouterOSRestClient` — `get`, `getOne`, `create`, `update`, `remove`, `execute` |
| `src/config/app-config.ts` | Reads `MIKROMCP_*` env vars |
| `src/config/router-registry.ts` | Loads `config/routers.yaml`; `getRouter(id)` throws if missing |
| `src/types.ts` | `RouterConfig`, `RouterOSRecord`, `QueryOptions`, `Role` |

## Adding a tool — the pattern

Every tool lives in `src/domain/tools/`. Either add to an existing file or create a new one and export from `index.ts`.

```typescript
import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("my-tools");   // module name, not tool name

const myInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  // all params with .describe() for AI clients
  limit: z.number().int().min(1).max(500).default(100).describe("..."),
  dryRun: z.boolean().default(false).describe("Preview changes without applying"),
}).strict();  // always .strict() — reject extra fields

const myTool: ToolDefinition = {
  name: "my_tool",
  title: "My Tool",
  description: "What this does. Describe idempotency and dry-run behavior.",
  inputSchema: myInputSchema,
  annotations: {
    readOnlyHint: true,      // true → auto-retry enabled in tool-registry
    destructiveHint: false,  // true → circuit breaker trips on failure
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = myInputSchema.parse(params);

    log.info({ routerId: context.routerId }, "Doing thing");

    try {
      const records = await context.routerClient.get<RouterOSRecord>("ros/path", {
        filter: { key: "value" },   // optional server-side filter
        limit: undefined,           // pass undefined to fetch all, paginate client-side
        offset: undefined,
      });

      return {
        content: `Found ${records.length} things.`,
        structuredContent: { routerId: context.routerId, records },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "my_tool" });
    }
  },
};

export const myTools: ToolDefinition[] = [myTool];
```

Then in `src/domain/tools/index.ts`:
```typescript
import { myTools } from "./my-tools.js";

export const allTools: ToolDefinition[] = [
  ...systemTools, ...interfaceTools, ...ipTools,
  ...dhcpTools, ...routeTools, ...firewallTools,
  ...myTools,   // add here
];
```

## Idempotency pattern (write tools)

Every write tool must check for existing state before acting:

```typescript
// 1. Look up existing resource
const existing = await context.routerClient.get<RouterOSRecord>("path", {
  filter: { key: parsed.key },
});

// 2a. Exists and matches → return already_exists (not an error)
if (existing && sameConfig) {
  return { content: "Already exists.", structuredContent: { action: "already_exists", ... } };
}

// 2b. Exists but different config → throw CONFLICT
if (existing && differentConfig) {
  throw new MikroMCPError({
    category: ErrorCategory.CONFLICT,
    code: "MY_CONFLICT",
    message: "Exists with different config: ...",
    details: { existing: ..., requested: ... },
    recoverability: {
      retryable: false,
      suggestedAction: "Remove the existing resource first.",
      alternativeTools: ["remove_tool"],
    },
  });
}

// 3. Dry-run before create
if (parsed.dryRun) {
  return { content: "Dry run: would create ...", structuredContent: { action: "dry_run", diff } };
}

// 4. Create
const created = await context.routerClient.create("path", { key: value });
return { content: "Created.", structuredContent: { action: "created", route: created } };
```

## Error handling rules

- **Always wrap the handler body** in `try/catch` and call `enrichError(err, context)` in the catch — this maps HTTP/network errors to typed `MikroMCPError`.
- **Re-throw `MikroMCPError` as-is** — never wrap it: `if (err instanceof MikroMCPError) throw err;`
- **Throw `MikroMCPError` directly** for domain errors (NOT_FOUND, CONFLICT, VALIDATION) — don't throw raw `Error`.
- **`enrichError` is idempotent** — safe to call on any error including ones already enriched.

## `RouterOSRestClient` methods

```typescript
get<T>(path: string, options?: { filter?, proplist?, limit?, offset? }): Promise<T[]>
getOne<T>(path: string, id: string): Promise<T>
create(path: string, data: Record<string, string>): Promise<RouterOSRecord>
update(path: string, id: string, data: Record<string, string>): Promise<void>
remove(path: string, id: string): Promise<void>
execute<T>(path: string, data?: Record<string, unknown>): Promise<T>
```

RouterOS record fields use kebab-case (`"dst-address"`, `"routing-table"`). The special ID field is `".id"`. RouterOS sends everything as strings, but `response-parser.ts` converts records: `"true"`/`"false"` become real JS booleans and numeric strings become numbers (unsafe 64-bit integers stay strings to preserve precision). For boolean-ish fields, **always use `isTrue(value)` from `adapter/response-parser.js`** — it handles parsed booleans, raw `"true"`/`"false"`, and `"yes"`/`"no"`. For any other field, **compare with `sameValue(recordValue, desired)`** from the same module — never `record.x === String(desired)` (it silently never matches once the parser has turned the wire string into a number). Note `RouterOSRecord` values are typed `string | number | boolean`.

## Code conventions

- **ESM with `.js` extensions** in all imports, even for `.ts` source files: `from "../../adapter/rest-client.js"`
- **No comments explaining what the code does** — only add a comment when the WHY is non-obvious (hidden constraint, RouterOS quirk, workaround)
- **No `// Section header` dividers** unless the file is long enough to need navigation
- **Zod schemas always `.strict()`** — never allow extra fields through
- **`z.transform()`** is fine for normalisation (e.g., plain IP → CIDR `/32`)
- **Logger at module top:** `const log = createLogger("module-name");` — never create inside handler
- **Prettier config:** `semi: true`, `trailingComma: "all"`, `singleQuote: false`, `printWidth: 100`, `tabWidth: 2`
- **TypeScript strict mode** — no `any`, no `@ts-ignore`

## Test conventions

Unit tests live in `test/unit/` mirroring `src/` (file naming: `<module>.test.ts`) and run via `npm test`. Integration tests live in `test/integration/` and run only via `npm run test:integration` against a live RouterOS CHR in Docker (see `docs/wiki/Development.md`) — never put a live-router test under `test/unit/`.

```typescript
import { describe, it, expect, vi } from "vitest";
import { myTools } from "../../../src/domain/tools/my-tools.js";  // .js extension

const myTool = myTools[0];

// Build a minimal mock context
function makeContext(records: Record<string, unknown>[]): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: {
      get: vi.fn().mockResolvedValue(records),
      create: vi.fn().mockResolvedValue({ ".id": "*1" }),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}
```

Test groups follow: `metadata` → `input schema` → `handler - <action>`. Always test:
- Correct tool count and names in the exported array
- Correct annotations (especially `readOnlyHint`)
- Input schema: valid input with defaults, rejection of extra fields, rejection of out-of-range values
- Handler: happy path, idempotency (`already_exists`), conflict, dry-run, not-found

Use inline Zod schemas in schema tests so they don't depend on internal exports.

## Transport

Two transports:
- **stdio** (default): MCP client spawns the process, communicates over stdin/stdout
- **HTTP/SSE** (`MIKROMCP_TRANSPORT=http`): stateless `StreamableHTTPServerTransport`, listens at `POST /mcp` and `GET /mcp` on `MIKROMCP_PORT` (default 3000)

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `MIKROMCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MIKROMCP_CONFIG_PATH` | `~/.mikromcp/routers.yaml` | Path to router registry |
| `MIKROMCP_DEFAULT_ROUTER` | — | Router id used when a tool call omits `routerId` (falls back to the sole router if only one is configured) |
| `MIKROMCP_LOG_LEVEL` | `info` | `trace` `debug` `info` `warn` `error` |
| `MIKROMCP_PORT` | `3000` | HTTP transport only |
| `MIKROMCP_IDENTITIES_PATH` | `~/.mikromcp/identities.yaml` | Path to identity/token registry |
| `MIKROMCP_STDIO_IDENTITY` | — | Named identity for stdio transport (omit for built-in superadmin) |
| `MIKROMCP_CONFIRMATION_SECRET` | — | HMAC secret for confirmation tokens (**required** in HTTP mode when identities with role `readonly` or `operator` are configured) |
| `MIKROMCP_AUDIT_LOG_PATH` | — | NDJSON audit log file path (omit to disable file sink) |
| `MIKROMCP_SNAPSHOT_RETENTION_DAYS` | `30` | Age in days after which config snapshots are pruned at startup |
| `ROUTER_<PREFIX>_USER` | — | Per-router credential (matches `envPrefix` in YAML) |
| `ROUTER_<PREFIX>_PASS` | — | Per-router credential |

## RouterOS paths (reference)

| Data | REST path |
|---|---|
| System identity/resource | `system/identity`, `system/resource` |
| System clock | `system/clock` |
| System packages | `system/package` |
| System scripts | `system/script` |
| System scheduler | `system/scheduler` |
| Interfaces | `interface` |
| Bridge interfaces | `interface/bridge`, `interface/bridge/port` |
| WiFi interfaces | `interface/wifi` (ROS 7.13+) or `interface/wireless` |
| WireGuard interfaces | `interface/wireguard`, `interface/wireguard/peers` |
| IP addresses | `ip/address` |
| DNS settings / static entries | `ip/dns`, `ip/dns/static` |
| Routes | `ip/route` |
| Routing rules | `routing/rule` |
| Routing tables | `routing/table` |
| BGP peers | `routing/bgp/session` |
| OSPF neighbors | `routing/ospf/neighbor` |
| DHCP leases | `ip/dhcp-server/lease` |
| Firewall filter | `ip/firewall/filter` |
| Firewall NAT | `ip/firewall/nat` |
| Firewall mangle | `ip/firewall/mangle` |
| Firewall address lists | `ip/firewall/address-list` |
| IPSec peers / policies | `ip/ipsec/peer`, `ip/ipsec/policy` |
| Certificates | `certificate` |
| Users / groups | `user`, `user/group` |
| Files | `file` |
| Containers | `container` |
| System log | `log` |
| Ping (tool) | `tool/ping` |
| Traceroute (tool) | `tool/traceroute` |
| Torch (tool) | `tool/torch` |

## Keeping documentation in sync

Documentation is updated in the **same PR** that ships the change — never as a follow-up.

### Trigger → required doc updates

| What changed | Docs to update |
|---|---|
| New tool added | `docs/wiki/Available-Tools.md` (add full parameter table + example prompt), `README.md` (tool count, Available Tools table row), `CHANGELOG.md` (`[Unreleased]` → Added) |
| Tool added/renamed/removed (skill sync) | `skills/mikromcp/references/tool-map.md` (the lockstep test `test/unit/skill/tool-map-sync.test.ts` will fail until updated) |
| Tool added/renamed/removed (Available-Tools sync) | `docs/wiki/Available-Tools.md` (the lockstep test `test/unit/docs/available-tools-sync.test.ts` will fail until updated) |
| Tool parameter changed | `docs/wiki/Available-Tools.md` (update parameter table), `CHANGELOG.md` (`[Unreleased]` → Changed) |
| Tool removed or renamed | `docs/wiki/Available-Tools.md` (remove/rename entry), `README.md` (update table), `CHANGELOG.md` (`[Unreleased]` → Removed) |
| New transport or auth mechanism | `docs/wiki/Architecture.md`, `docs/wiki/Connecting-to-AI-Assistants.md` |
| New CLI command or install path | `docs/wiki/Getting-Started.md` |
| Bug fix shipped | `CHANGELOG.md` (`[Unreleased]` → Fixed) only; no wiki update needed unless user-facing behaviour changes |
| Milestone completed | `ROADMAP.md` (flip `🔜` → `✅`), `docs/wiki/Roadmap.md` (mirror status), `README.md` (roadmap note) |
| Anything user-facing | The two websites — see [Keeping the websites in sync](#keeping-the-websites-in-sync) below |

### Keeping the websites in sync

Two sites ship from this repo, and **both are part of the same PR as the code change** — never a follow-up:

| Site | Source | Deployed to |
|---|---|---|
| Landing page | `site/` (Astro) | https://mikromcp.com |
| Documentation | `docs-site/` (Astro + Starlight) | https://docs.mikromcp.com |

**docs.mikromcp.com is generated, not hand-written.** Its pages come from `docs/wiki/*.md` via `docs-site/scripts/sync-wiki.mjs`, which runs automatically on `predev`/`prebuild`. Edit `docs/wiki/` and never `docs-site/src/content/docs/` — that directory is overwritten on every build. A new wiki page also needs an entry in `WIKI_ORDER` in `sync-wiki.mjs`.

**Visual system.** Everything derives from a four-stop cool ramp defined in `site/src/styles/theme.css` — `--c1` teal `#2DD4BF` → `--c2` cyan → `--c3` blue → `--c4` violet `#8B5CF6`, exposed as `--grad-brand`. Rules of thumb when adding to the page:

- Reach for a token (`--c1`…`--c4`, `--grad-brand`, `.grad-text`, `.panel`, `.panel-field`) rather than a new hex value. `docs-site/src/styles/custom.css` mirrors the ramp; change both together.
- Colour arrives as **bounded fields** — a full-bleed section background or a large rounded panel — not as a blurred glow floating behind text.
- Illustration is inline SVG in `site/src/components/Shapes.astro` (`fan`, `mesh`, `pipe`), never an image asset. Astro's scoped styles do not reach inside a child component, so a figure must be wrapped in a host-owned positioned element: `<div class="fan"><Shapes name="fan" /></div>`. The svg itself is sized by the global `.shape-svg` rule.
- Page rhythm alternates: colour field → plain ground → panel. Two colour fields in a row flattens the effect.

**mikromcp.com has a single source of truth for product facts:** `site/src/data/content.ts`. Tool count, version, feature list, example prompts and FAQ all live there, and `site/src/pages/llms.txt.ts` and `llms-full.txt.ts` generate the LLM-facing text files from it. Never hardcode a tool count or version in a component.

| What changed | Site updates required |
|---|---|
| Tool added/removed | `site/src/data/content.ts` → `toolCount` (the lockstep test `test/unit/docs/tool-count-sync.test.ts` fails until every listed file agrees) |
| New capability worth advertising | `site/src/data/content.ts` → `features`, and an `examples` entry if there is a prompt a user would paste |
| Version bumped | Nothing by hand — `npm version` runs `scripts/sync-version.mjs`, which regenerates both `src/version.ts` and `site/src/data/version.ts`. `test/unit/docs/site-version-sync.test.ts` catches it if the script was bypassed |
| Wiki page added/edited/renamed | `docs/wiki/*.md`, plus `WIKI_ORDER` in `docs-site/scripts/sync-wiki.mjs` for a new page |
| Install path or CLI flow changed | `site/src/components/QuickStart.astro`, `docs/wiki/Getting-Started.md` |
| Milestone shipped | `ROADMAP.md` **and** `docs/wiki/Roadmap.md` — the docs site publishes the wiki copy, so a roadmap that stops at an old version is publicly visible |

Before pushing, build both so a template or link error is caught locally:

```bash
npm --prefix site run build
npm --prefix docs-site run build
```

Roadmap files are deliberately excluded from `tool-count-sync.test.ts`: their counts are historical statements about past releases ("99 → 117 tools") and must not be rewritten to the current count.

### CHANGELOG discipline

Keep `CHANGELOG.md`'s `[Unreleased]` section current throughout development. Every PR that touches user-facing behaviour adds a line there. At release time, that section becomes the `## [X.Y.Z]` entry — no archaeology required.

### Available-Tools.md format

Each tool entry must have: section header with tool name and Read/Write/Destructive tag, one-line description, parameter table with Type / Default / Description columns, and an **Example prompt** that a user could actually paste.

Tool count in `README.md` and `docs/wiki/Architecture.md` must stay accurate.

## Git development process

### Branch conventions

All work happens on branches — **never commit directly to `main`**. `main` is always releasable.

| Branch prefix | Use for |
|---|---|
| `feat/<short-description>` | New features or tools |
| `fix/<short-description>` | Bug fixes |
| `chore/<short-description>` | Version bumps, dependency updates, config, CI |
| `docs/<short-description>` | Documentation-only changes |
| `refactor/<short-description>` | Code restructuring with no behaviour change |

Branch names use kebab-case: `feat/wifi-scan-tool`, `fix/circuit-breaker-timeout`.

### Commit message conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary>
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`.  
Breaking changes: append `!` after the type, e.g. `feat!: rename tool parameter`.

### Pull request workflow

1. Create a branch from `main` using the naming convention above.
2. Make commits, run `npm test` before pushing.
3. Open a PR targeting `main`. PR title must follow the same Conventional Commits format as the commit messages.
4. Merge using **squash merge** so `main` history stays one-commit-per-feature.
5. Delete the branch after merge.

### Tag and release conventions

Tags follow strict semver: `vMAJOR.MINOR.PATCH`.

- **PATCH** — bug fixes only, no new tools or breaking changes
- **MINOR** — new tools, new features, backwards-compatible changes
- **MAJOR** — breaking changes to config, tool names, or behaviour

Tags are created only on `main` after the release PR merges.

### Changelog

`CHANGELOG.md` lives at the repo root and follows [Keep a Changelog](https://keepachangelog.com/) format.

- Each release section covers **only changes since the previous release** — no cumulative history.
- Sections within a release (use only those that apply): `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security`.
- An `[Unreleased]` section at the top accumulates changes while a release is in progress.

Example entry:
```markdown
## [1.1.0] - 2026-06-01

### Added
- `list_wifi_clients` tool — lists associated WiFi stations per interface
- `manage_wifi_interface` tool — enable/disable WiFi interfaces

### Fixed
- Circuit breaker no longer trips on 404 responses from read tools
```

### Release checklist

Run when merging a release PR into `main`:

1. Move all items from `[Unreleased]` in `CHANGELOG.md` to a new `## [X.Y.Z] - YYYY-MM-DD` section.
2. `npm version <major|minor|patch>` — bumps `package.json` + `package-lock.json`. (`npm version` auto-runs `scripts/sync-version.mjs`, which regenerates `src/version.ts` **and** `site/src/data/version.ts`, so the mikromcp.com footer follows the release.)
3. Update README version badge: `version-v<X.Y.Z>`.
4. Update `server.json` — change BOTH the top-level `"version"` field AND `packages[0].version` to `"X.Y.Z"`.
5. Add the release to `ROADMAP.md` and mirror it in `docs/wiki/Roadmap.md` (flip `🔜` → `✅`, or add a section for a release that had no planned milestone). docs.mikromcp.com publishes the wiki copy.
6. Update `docs/wiki/Available-Tools.md` for any new/changed tools, and `site/src/data/content.ts` (`toolCount`, `features`, `examples`) for anything worth advertising on the landing page.
7. `npm test` — the lockstep tests fail if any doc, wiki page, or site file still states the old tool count or version.
8. Build both sites: `npm --prefix site run build && npm --prefix docs-site run build`.
9. Commit on the release branch: `chore: bump version to X.Y.Z`.
10. Open PR, squash-merge into `main`.
11. `git tag vX.Y.Z && git push origin vX.Y.Z`
12. CI `release.yml` auto-runs: builds binaries, pushes Docker images, creates GitHub Release (uses the release section from `CHANGELOG.md` as release notes).
13. Deploy the two sites (see `site/DEPLOY.md` and `docs-site/DEPLOY.md`).

## What not to do

- Don't add retry/circuit-breaker logic inside a tool handler — that's handled by `tool-registry.ts`
- Don't access credentials inside a tool — credentials are resolved by `tool-registry.ts` before calling the handler; the handler gets an already-authenticated `routerClient`
- Don't log sensitive fields (passwords, auth headers)
- Don't use `let` for variables that are assigned once
- Don't use `as any` — use `as unknown as T` or refine the type
- Don't paginate with server-side `limit`/`offset` on RouterOS endpoints that don't support it — fetch all and paginate client-side (see `list_routes` for the pattern)
