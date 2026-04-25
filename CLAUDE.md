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

Run `npm test && npm run typecheck` before committing.

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

RouterOS record fields use kebab-case (`"dst-address"`, `"routing-table"`). The special ID field is `".id"`. Boolean fields come back as the string `"true"` or `"false"`, not JS booleans — always compare with `=== "true"` or `=== true` (some fields vary).

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

Tests live in `test/unit/` mirroring `src/`. File naming: `<module>.test.ts`.

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
| `MIKROMCP_CONFIG_PATH` | `config/routers.yaml` | Path to router registry |
| `MIKROMCP_LOG_LEVEL` | `info` | `trace` `debug` `info` `warn` `error` |
| `MIKROMCP_PORT` | `3000` | HTTP transport only |
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
| BGP peers | `routing/bgp/peer` |
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

**Every time a milestone is completed or a tool is added/changed, update all of the following together — never leave them out of sync:**

| Document | What to update |
|---|---|
| `ROADMAP.md` | Flip `🔜` → `✅` on the completed milestone; update bullet descriptions to match what was actually shipped |
| `README.md` | Tool count in the mermaid diagram, the Available Tools table (add/modify rows), and the roadmap progress note at the bottom of the docs table |
| `CLAUDE.md` header line | Update the `> For the full feature roadmap` pointer if the phrasing is stale |
| GitHub wiki — **Available Tools** page | Add parameter tables and example prompts for every new tool |
| GitHub wiki — **Roadmap** page | Mirror the same milestone status changes as in `ROADMAP.md` |

Do this as part of the same commit that ships the feature — not as a follow-up.

## What not to do

- Don't add retry/circuit-breaker logic inside a tool handler — that's handled by `tool-registry.ts`
- Don't access credentials inside a tool — credentials are resolved by `tool-registry.ts` before calling the handler; the handler gets an already-authenticated `routerClient`
- Don't log sensitive fields (passwords, auth headers)
- Don't use `let` for variables that are assigned once
- Don't use `as any` — use `as unknown as T` or refine the type
- Don't paginate with server-side `limit`/`offset` on RouterOS endpoints that don't support it — fetch all and paginate client-side (see `list_routes` for the pattern)
