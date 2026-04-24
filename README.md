# MikroMCP

A production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives AI assistants (Claude, Cursor, etc.) safe, structured access to MikroTik RouterOS devices via the RouterOS REST API.

---

## What it does

MikroMCP exposes MikroTik router management as MCP tools. An AI assistant connected to MikroMCP can query system status, list interfaces, create VLANs, and manage IP addresses — all through natural language, with the server enforcing validation, idempotency, and safety guardrails.

Key characteristics:

- **Read-only tools auto-retry** with exponential backoff + jitter
- **Write tools are idempotent** — creating something that already exists returns success, not an error
- **Dry-run mode** on all write tools — preview changes before applying
- **Circuit breaker** per router — trips after N consecutive failures, self-heals after cooldown
- **Structured + human-readable responses** — every tool returns both a text summary and a JSON `structuredContent` block
- **Zero secrets in config** — credentials come from environment variables (or future Vault integration)
- **Multi-router** — manage any number of routers from a single server instance

---

## Architecture

```
MCP Client (Claude, Cursor, etc.)
        │  stdio (JSON-RPC 2.0)
        ▼
┌─────────────────────────────────┐
│         MikroMCP Server         │
│                                 │
│  Tool Registry                  │
│    ├── get_system_status        │
│    ├── list_interfaces          │
│    ├── create_vlan              │
│    └── manage_ip_address        │
│                                 │
│  Per-call pipeline:             │
│    Correlation ID → Circuit     │
│    Breaker → Retry Engine →     │
│    RouterOS REST Client         │
└──────────────┬──────────────────┘
               │ HTTPS / REST
       ┌───────┴────────┐
  RouterA          RouterB ...
(RouterOS 7.x)
```

**Layers:**

| Layer | Path | Responsibility |
|---|---|---|
| Entry point | `src/main.ts` | Boot, transport wiring, shutdown |
| MCP server | `src/mcp/` | Tool registration, response formatting |
| Tools | `src/domain/tools/` | Business logic, validation, idempotency |
| Adapter | `src/adapter/` | REST client, retry, circuit breaker, TLS, connection pool |
| Config | `src/config/` | App config (env vars), router registry (YAML), credential resolution |
| Observability | `src/observability/` | Structured logging (pino), correlation IDs |
| Errors | `src/domain/errors/` | Typed error taxonomy, enrichment |

---

## Requirements

- **Node.js >= 22**
- **MikroTik RouterOS 7.x** with REST API enabled (`ip/service` → enable `www-ssl` or `www`)
- An MCP-capable client (Claude Desktop, Cursor, etc.)

---

## End-to-end setup guide

This section walks you from a bare MikroTik router to a working AI assistant that can query and configure it.

### Step 1 — Create a dedicated API user on the router

Connect to your router via SSH, WinBox terminal, or the web console and run:

```
# Create a restricted group (read + write + REST API access, nothing else)
/user group add name=mcp-api policy=read,write,api,rest-api,!local,!telnet,!ssh,!ftp,!reboot,!password,!sniff,!sensitive,!romon

# Create the user
/user add name=mcp-api group=mcp-api password="<strong-password>"
```

For a **read-only** setup (safer for monitoring-only use):

```
/user group add name=mcp-readonly policy=read,api,rest-api
/user add name=mcp-readonly group=mcp-readonly password="<strong-password>"
```

> **Tip:** Never use the `admin` account for API access. A dedicated account limits blast radius and makes credential rotation painless.

### Step 2 — Enable the REST API service

MikroMCP talks to the RouterOS REST API over HTTPS. Enable the `www-ssl` service (port 443):

```
/ip service enable www-ssl
/ip service set www-ssl port=443
```

For local-network/lab use you can use plain HTTP instead:

```
/ip service enable www
/ip service set www port=80
```

Verify: open `https://<router-ip>/rest/system/identity` in a browser (or `curl -k`). You should get a JSON response after entering credentials.

### Step 3 — Install and build MikroMCP

```bash
git clone https://github.com/alikarami/MikroMCP.git
cd MikroMCP
npm install
npm run build
```

### Step 4 — Configure your routers

```bash
cp config/routers.example.yaml config/routers.yaml
```

Edit `config/routers.yaml` — add one entry per router (see [Configuration](#configuration) for all options):

```yaml
routers:
  core-01:
    host: "10.0.0.1"
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: false   # set true if you have a valid cert
    credentials:
      source: "env"
      envPrefix: "ROUTER_CORE01"
    rosVersion: "7.14"
```

### Step 5 — Set credentials

```bash
export ROUTER_CORE01_USER=mcp-api
export ROUTER_CORE01_PASS=<strong-password>
```

Add these to your shell profile or a `.env` file (never commit it).

### Step 6 — Run the server

**Development (hot-reload):**

```bash
npm run dev
```

**Production:**

```bash
npm start
```

You should see a log line like `MikroMCP server started` and no errors. If you see `ROUTER_AUTH_FAILED` or `ROUTER_UNREACHABLE`, go back to steps 1–2.

### Step 7 — Connect to Claude or another MCP client

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mikrotik": {
      "command": "node",
      "args": ["/absolute/path/to/MikroMCP/dist/main.js"],
      "env": {
        "MIKROMCP_CONFIG_PATH": "/absolute/path/to/MikroMCP/config/routers.yaml",
        "ROUTER_CORE01_USER": "mcp-api",
        "ROUTER_CORE01_PASS": "your-password"
      }
    }
  }
}
```

Restart Claude Desktop. The MikroTik tools appear in the tools panel (hammer icon).

**Claude Code (CLI):**

```bash
claude mcp add mikrotik node /absolute/path/to/MikroMCP/dist/main.js \
  -e MIKROMCP_CONFIG_PATH=/absolute/path/to/MikroMCP/config/routers.yaml \
  -e ROUTER_CORE01_USER=mcp-api \
  -e ROUTER_CORE01_PASS=your-password
```

**Other MCP clients** — any client that supports the MCP stdio transport works. Point `command` to `node` and `args` to the built `dist/main.js`, passing credentials via `env`.

### Step 8 — Verify it's working

Ask your AI assistant:

> *"Use the get_system_status tool on core-01 and tell me the RouterOS version and CPU load."*

A successful response looks like:

```
Router: core-01 | Identity: MyRouter
RouterOS: 7.14 (stable)
Uptime: 14d 3h 22m
CPU load: 4%
Free memory: 186.2 MiB / 256.0 MiB
```

If the tool call fails, check:
- Router IP / port reachable from where the server is running (`curl -k https://<ip>/rest/system/identity`)
- Credentials correct and the user has `api` and `rest-api` policies
- `MIKROMCP_CONFIG_PATH` points to the right file
- `MIKROMCP_LOG_LEVEL=debug` for verbose output

---

## Installation

```bash
git clone https://github.com/alikarami/MikroMCP.git
cd MikroMCP
npm install
npm run build
```

---

## Configuration

### 1. Router registry

Copy the example config and fill in your routers:

```bash
cp config/routers.example.yaml config/routers.yaml
```

```yaml
# config/routers.yaml
routers:
  core-01:
    host: "10.0.0.1"
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: false   # set true when using a valid CA cert
      # ca: "/path/to/ca.pem"    # optional: pin a specific CA
    credentials:
      source: "env"
      envPrefix: "ROUTER_CORE01" # reads ROUTER_CORE01_USER + ROUTER_CORE01_PASS
    tags: ["datacenter", "core"]
    rosVersion: "7.14"

  edge-01:
    host: "192.168.88.1"
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: false
    credentials:
      source: "env"
      envPrefix: "ROUTER_EDGE01"
    tags: ["branch", "edge"]
    rosVersion: "7.12"
```

### 2. Credentials

Set environment variables for each router's `envPrefix`:

```bash
export ROUTER_CORE01_USER=admin
export ROUTER_CORE01_PASS=your-password

export ROUTER_EDGE01_USER=admin
export ROUTER_EDGE01_PASS=your-password
```

Credentials are **never** logged or included in responses.

### 3. Server environment variables

All settings have sensible defaults and are optional:

| Variable | Default | Description |
|---|---|---|
| `MIKROMCP_TRANSPORT` | `stdio` | Transport: `stdio` or `http` |
| `MIKROMCP_CONFIG_PATH` | `config/routers.yaml` | Path to router registry YAML |
| `MIKROMCP_LOG_LEVEL` | `info` | Log level (`trace`, `debug`, `info`, `warn`, `error`) |
| `MIKROMCP_PORT` | `3000` | HTTP port (reserved for future HTTP transport) |
| `MIKROMCP_DATA_DIR` | `data` | Data directory (reserved for future use) |

#### HTTP/SSE transport

Set `MIKROMCP_TRANSPORT=http` to run MikroMCP as an HTTP server instead of stdio. The server listens on `MIKROMCP_PORT` (default `3000`) and accepts MCP JSON-RPC at `POST /mcp`. Clients that support Server-Sent Events can connect via `GET /mcp` for streaming.

```bash
MIKROMCP_TRANSPORT=http MIKROMCP_PORT=3000 \
MIKROMCP_CONFIG_PATH=config/routers.yaml \
ROUTER_CORE01_USER=mcp-api ROUTER_CORE01_PASS=secret \
  npm start
```

---

## Running

### Development

```bash
npm run dev
```

Uses `tsx watch` — restarts on file changes. Logs are pretty-printed via `pino-pretty`.

### Production

```bash
npm run build
npm start
```

Builds to `dist/main.js` (ESM, single file via `tsup`), then runs it with Node.

---

## Connecting to an MCP client

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mikrotik": {
      "command": "node",
      "args": ["/absolute/path/to/MikroMCP/dist/main.js"],
      "env": {
        "MIKROMCP_CONFIG_PATH": "/absolute/path/to/MikroMCP/config/routers.yaml",
        "ROUTER_CORE01_USER": "admin",
        "ROUTER_CORE01_PASS": "your-password"
      }
    }
  }
}
```

Restart Claude Desktop after saving. You should see "mikrotik" in the tools panel.

### Claude Code (CLI)

```bash
claude mcp add mikrotik node /absolute/path/to/MikroMCP/dist/main.js
```

Or add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "mikrotik": {
      "command": "node",
      "args": ["/absolute/path/to/MikroMCP/dist/main.js"]
    }
  }
}
```

---

## Available tools

### `get_system_status`

Fetch system information from a router.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | required | Router ID from the registry |
| `sections` | array | `["all"]` | Sections: `resource`, `identity`, `license`, `routerboard`, `health`, `clock`, `all` |

**Example prompt:** *"Show me the system status of core-01 including CPU and memory."*

---

### `list_interfaces`

List network interfaces with optional filtering and pagination.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | required | Router ID |
| `type` | enum | `all` | `ether`, `vlan`, `bridge`, `bonding`, `wireguard`, `gre`, `all` |
| `status` | enum | `all` | `up`, `down`, `all` |
| `includeCounters` | boolean | `false` | Include tx/rx byte and packet counters |
| `limit` | integer | `100` | Max results (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** *"List all running Ethernet interfaces on edge-01."*

---

### `create_vlan`

Create a VLAN interface. Idempotent — re-running with the same parameters is a no-op.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | required | Router ID |
| `name` | string | required | Interface name (alphanumeric, `-`, `_`, max 15 chars) |
| `vlanId` | integer | required | VLAN ID (1–4094) |
| `parentInterface` | string | required | Parent interface (e.g. `ether1`, `bridge1`) |
| `mtu` | integer | `1500` | MTU (68–9000) |
| `disabled` | boolean | `false` | Create in disabled state |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview changes without applying |

**Example prompt:** *"Create VLAN 100 named vlan-mgmt on ether1 of core-01. Show me a dry run first."*

---

### `manage_ip_address`

Add, update, or remove an IP address on a router interface. Idempotent for add operations.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | required | Router ID |
| `action` | enum | required | `add`, `update`, `remove` |
| `address` | string | required | CIDR notation, e.g. `192.168.1.1/24` |
| `interface` | string | required | Target interface name |
| `network` | string | — | Network address (auto-calculated if omitted) |
| `comment` | string | — | Optional comment |
| `disabled` | boolean | `false` | Disable the address entry |
| `dryRun` | boolean | `false` | Preview changes without applying |

**Example prompt:** *"Add 10.10.0.1/30 to vlan-mgmt on core-01, dry run first."*

---

### `list_dhcp_leases`

List DHCP lease assignments from a DHCP server.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | required | Router ID |
| `server` | string | — | Filter by DHCP server name |
| `status` | enum | `all` | `bound`, `waiting`, `offered`, `blocked`, `all` |
| `macAddress` | string | — | Exact MAC address filter (case-insensitive) |
| `limit` | integer | `100` | Max results (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** *"List all bound DHCP leases on core-01."*

---

### `list_routes`

List routes from the routing table.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | required | Router ID |
| `activeOnly` | boolean | `false` | Return only active routes |
| `staticOnly` | boolean | `false` | Return only static (non-dynamic) routes |
| `limit` | integer | `100` | Max results (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** *"Show all active static routes on core-01."*

---

### `manage_route`

Add or remove a static route. Idempotent for add operations.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | required | Router ID |
| `action` | enum | required | `add`, `remove` |
| `dstAddress` | string | required | Destination in CIDR notation (e.g. `0.0.0.0/0`) |
| `gateway` | string | required | Next-hop IP or exit interface |
| `distance` | integer | `1` | Administrative distance (1–255) |
| `comment` | string | — | Optional comment |
| `disabled` | boolean | `false` | Create in disabled state |
| `dryRun` | boolean | `false` | Preview changes without applying |

**Example prompt:** *"Add a default route via 10.0.0.1 on core-01, dry run first."*

---

### `list_firewall_rules`

List firewall filter or NAT rules in evaluation order.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | required | Router ID |
| `table` | enum | `filter` | `filter`, `nat` |
| `chain` | string | — | Filter by chain name (e.g. `forward`, `srcnat`) |
| `disabled` | enum | `all` | `true`, `false`, `all` |
| `limit` | integer | `100` | Max results (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** *"Show all forward chain rules on core-01."*

---

### `manage_firewall_rule`

Add, remove, disable, or enable a firewall filter or NAT rule. Uses `comment` as the idempotency key — required for remove, disable, and enable actions.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | required | Router ID |
| `table` | enum | `filter` | `filter`, `nat` |
| `action` | enum | required | `add`, `remove`, `disable`, `enable` |
| `chain` | string | required | Chain name (e.g. `forward`, `srcnat`) |
| `ruleAction` | string | required | RouterOS action (e.g. `drop`, `accept`, `masquerade`) |
| `srcAddress` | string | — | Source address/range |
| `dstAddress` | string | — | Destination address/range |
| `protocol` | enum | — | `tcp`, `udp`, `icmp`, `gre`, `ospf`, `all` |
| `srcPort` | string | — | Source port or range |
| `dstPort` | string | — | Destination port or range |
| `inInterface` | string | — | Incoming interface |
| `outInterface` | string | — | Outgoing interface |
| `comment` | string | — | Idempotency key — required for remove/disable/enable |
| `disabled` | boolean | `false` | Create in disabled state |
| `placeBefore` | string | — | Rule `.id` or comment to insert before |
| `dryRun` | boolean | `false` | Preview changes without applying |

**Example prompt:** *"Add a firewall rule to drop all traffic from 10.0.0.0/8 in the forward chain on core-01, comment it 'block-rfc1918', dry run first."*

---

## Error handling

Every error includes a machine-readable category, code, and recovery hint:

| Category | When |
|---|---|
| `VALIDATION` | Invalid input parameters |
| `NOT_FOUND` | Resource doesn't exist |
| `CONFLICT` | Resource exists with different config |
| `ROUTER_UNREACHABLE` | Network connectivity failure |
| `ROUTER_AUTH_FAILED` | Bad credentials |
| `ROUTER_TIMEOUT` | Request timed out |
| `ROUTER_BUSY` | Circuit breaker is open |
| `CONFIGURATION` | Missing or invalid server configuration |

Retryable errors include a `retryAfterMs` hint. Conflict errors suggest alternative actions or tools.

---

## Resilience

**Retry engine** — read-only tools automatically retry on transient network errors (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`) and HTTP 5xx responses. Backoff: `min(baseDelay × 2^attempt + jitter, maxDelay)`. Defaults: 3 retries, 200 ms base, 5 s cap.

**Circuit breaker** — per-router, three-state (closed → open → half-open). Opens after 5 consecutive failures, enters half-open after 30 s cooldown, closes on the first successful probe. Write tools go through the breaker but skip the retry layer to avoid partial-apply double-fires.

---

## Development

### Project structure

```
src/
├── main.ts                    # Entry point
├── types.ts                   # Shared type definitions
├── mcp/
│   ├── server.ts              # MCP server bootstrap
│   ├── tool-registry.ts       # Tool registration + execution pipeline
│   ├── response-formatter.ts  # MCP response shaping
│   └── transports/
│       └── stdio.ts           # stdio transport
├── domain/
│   ├── tools/
│   │   ├── index.ts           # Tool aggregation
│   │   ├── tool-definition.ts # Tool interface
│   │   ├── system-tools.ts    # get_system_status
│   │   ├── interface-tools.ts # list_interfaces, create_vlan
│   │   └── ip-tools.ts        # manage_ip_address
│   └── errors/
│       ├── error-types.ts     # MikroMCPError + ErrorCategory
│       └── error-enricher.ts  # HTTP/network error → MikroMCPError
├── adapter/
│   ├── rest-client.ts         # RouterOS REST client (undici)
│   ├── connection-pool.ts     # Client pooling
│   ├── circuit-breaker.ts     # Circuit breaker
│   ├── retry-engine.ts        # Exponential backoff + jitter
│   ├── query-builder.ts       # Filter/pagination query construction
│   ├── response-parser.ts     # RouterOS response normalization
│   └── tls-manager.ts         # TLS/mTLS agent configuration
├── config/
│   ├── app-config.ts          # Env-var based app config
│   ├── router-registry.ts     # YAML router registry
│   └── secrets.ts             # Credential resolution
└── observability/
    ├── logger.ts              # pino structured logger
    └── correlation.ts         # Per-request correlation IDs
```

### Scripts

```bash
npm run dev          # tsx watch (hot reload)
npm run build        # tsup → dist/
npm run test         # vitest (run once)
npm run test:watch   # vitest (watch mode)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src/
npm run format       # prettier --write
```

### Running tests

```bash
npm test
```

Tests live in `test/unit/` and cover the adapter layer (circuit breaker, retry engine, query builder, response parser) and the error taxonomy. No network or real router required.

### Debugging with MCP Inspector

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is an interactive browser UI for exploring and calling MCP tools without a full AI client. It's the fastest way to verify a tool is wired up correctly, check its input schema, and inspect raw responses.

**Install and launch against the built server:**

```bash
npm run build

ROUTER_CORE01_USER=mcp-api \
ROUTER_CORE01_PASS=your-password \
MIKROMCP_CONFIG_PATH=config/routers.yaml \
  npx @modelcontextprotocol/inspector node dist/main.js
```

**Or run it against the dev server (hot-reload):**

```bash
ROUTER_CORE01_USER=mcp-api \
ROUTER_CORE01_PASS=your-password \
MIKROMCP_CONFIG_PATH=config/routers.yaml \
  npx @modelcontextprotocol/inspector npm run dev
```

Inspector opens a browser at `http://localhost:5173`. From there you can:

- Browse all registered tools and their JSON schemas under the **Tools** tab
- Fill in parameters and call any tool directly — no prompt engineering needed
- Inspect the full MCP response including `structuredContent`
- Toggle `dryRun: true` on write tools to preview changes safely

**Typical debugging workflow when contributing a new tool:**

1. Add your tool and run `npm run dev`.
2. Launch Inspector with the command above.
3. Find your tool in the list, call it with sample inputs, and confirm the response shape.
4. Fix any issues, then write the unit test to cover that shape.
5. Run `npm test` and `npm run typecheck` before opening a PR.

---

## Contributing

Contributions are welcome. The project is young — there's a lot of surface area to cover.

### Good first contributions

- New read-only tools: firewall rules, routing tables, DNS, DHCP leases, BGP peers, OSPF neighbors
- New write tools: firewall rule management, static routes
- HTTP transport (currently stubbed)
- Vault credential source
- Integration test harness (RouterOS in Docker or CHR)

### Adding a tool

1. Create a file in `src/domain/tools/` (or add to an existing one).
2. Define the tool using the `ToolDefinition` interface from `tool-definition.ts`.
3. Export it and add it to the `allTools` array in `src/domain/tools/index.ts`.
4. Add unit tests in `test/unit/`.

A minimal tool skeleton:

```typescript
import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";

const inputSchema = z.object({
  routerId: z.string().describe("Target router identifier"),
  // ... your params
}).strict();

const myTool: ToolDefinition = {
  name: "my_tool",
  title: "My Tool",
  description: "What this tool does for the AI.",
  inputSchema,
  annotations: {
    readOnlyHint: true,       // true = auto-retry enabled
    destructiveHint: false,   // true = requires extra caution
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params, context: ToolContext): Promise<ToolResult> {
    const parsed = inputSchema.parse(params);
    const data = await context.routerClient.get("your/ros/path");
    return {
      content: "Human-readable summary",
      structuredContent: { routerId: context.routerId, data },
    };
  },
};

export const myTools: ToolDefinition[] = [myTool];
```

### Guidelines

- **Idempotency first** — write tools must check for existing state before acting.
- **Always support `dryRun`** on write tools.
- **Never log credentials** — they pass through `secrets.ts` and must stay there.
- **Enrich errors** — use `enrichError()` or throw `MikroMCPError` with a `recoverability` block.
- **Keep handlers focused** — adapter concerns (HTTP, retry) belong in `src/adapter/`, not in tool handlers.
- Match the existing code style; run `npm run format` and `npm run lint` before opening a PR.

### Pull request checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] New tool documented in this README
- [ ] Dry-run mode included (write tools)
- [ ] Idempotency check included (write tools)

---

## Roadmap

**v0.1**
- stdio transport
- get_system_status, list_interfaces, create_vlan, manage_ip_address
- Circuit breaker, retry engine, connection pool
- Env-var credential source

**v0.2 (current)**
- Firewall rule tools (`list_firewall_rules`, `manage_firewall_rule`)
- Static route tools (`list_routes`, `manage_route`)
- DHCP lease listing (`list_dhcp_leases`)
- HTTP/SSE transport (`MIKROMCP_TRANSPORT=http`)

**v0.3 (planned)**
- Vault credential source
- RBAC / identity enforcement
- Config snapshot & diff

---

## License

MIT — see [LICENSE](LICENSE).
