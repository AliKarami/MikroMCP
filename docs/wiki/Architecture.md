# Architecture

## System Overview

```mermaid
flowchart LR
    subgraph Clients["AI and MCP clients"]
        Claude["Claude Desktop / Claude Code"]
        Cursor["Cursor / Cline / IDE agents"]
        Service["Custom MCP clients"]
    end

    subgraph Transport["MCP transport"]
        Stdio["stdio JSON-RPC"]
        Http["Streamable HTTP\nPOST /mcp, GET /mcp"]
    end

    subgraph Core["MikroMCP server"]
        Registry["Tool registry\n88 typed tools"]
        Schemas["Zod schemas\nstrict validation"]
        Auth["Identity, RBAC\nconfirmation gate"]
        Safety["Retry, circuit breaker\naudit, snapshots, journal"]
        Format["Human text + structured JSON"]
    end

    subgraph Adapters["Router adapters"]
        Rest["RouterOS REST\nHTTPS"]
        Ssh["SSH adapter\ndiagnostics and guarded commands"]
        Ftp["FTP adapter\nfile uploads"]
    end

    subgraph Routers["MikroTik RouterOS 7.x fleet"]
        CoreRouter["core-01"]
        EdgeRouter["edge-01"]
        BranchRouter["branch-*"]
    end

    Claude --> Stdio
    Cursor --> Stdio
    Service --> Http
    Stdio --> Registry
    Http --> Auth
    Auth --> Registry
    Registry --> Schemas
    Schemas --> Safety
    Safety --> Rest
    Safety --> Ssh
    Safety --> Ftp
    Rest --> CoreRouter
    Rest --> EdgeRouter
    Rest --> BranchRouter
    Ssh --> CoreRouter
    Ftp --> CoreRouter
    Registry --> Format
```

## Tool Execution Flow

```mermaid
sequenceDiagram
    autonumber
    actor User as Operator
    participant Agent as AI assistant
    participant MCP as MCP client
    participant Server as MikroMCP
    participant Router as RouterOS

    User->>Agent: "Audit firewall and stale WireGuard peers on core-01"
    Agent->>MCP: Select MikroMCP tools
    MCP->>Server: JSON-RPC tool call
    Server->>Server: Authenticate identity and authorize router/tool
    Server->>Server: Validate input schema and attach correlation ID

    alt read-only tool
        Server->>Router: REST/SSH request with retry policy
        Router-->>Server: RouterOS records
    else write tool with dryRun
        Server->>Router: Read existing state
        Server-->>MCP: Planned diff, no mutation
    else confirmed write tool
        Server->>Router: Snapshot affected path
        Server->>Router: Apply idempotent change
        Server->>Server: Record write journal and audit outcome
    end

    Server-->>MCP: Text summary + structured JSON
    MCP-->>Agent: Tool result
    Agent-->>User: Findings and next recommended action
```

## Authentication and Safety Model

```mermaid
flowchart TD
    Request["Incoming MCP request"] --> Transport{"Transport"}
    Transport -->|stdio| StdioIdentity["Built-in superadmin\nor MIKROMCP_STDIO_IDENTITY"]
    Transport -->|HTTP| Bearer["Authorization: Bearer token"]
    Bearer --> TokenHash["bcrypt token verification\nconfig/identities.yaml"]
    StdioIdentity --> RBAC["RBAC check"]
    TokenHash --> RBAC
    RBAC --> RouterScope["allowedRouters"]
    RBAC --> ToolScope["allowedToolPatterns"]
    RouterScope --> Destructive{"Destructive tool?"}
    ToolScope --> Destructive
    Destructive -->|no| Execute["Execute tool"]
    Destructive -->|yes| Window["Maintenance window check"]
    Window --> Confirm["Confirmation token gate\nfor readonly/operator roles"]
    Confirm --> Execute
    Execute --> Audit["Structured logs + optional NDJSON audit log"]
```

## Key Components

| Component | File | Responsibility |
|---|---|---|
| Entry point | `src/main.ts` | Loads config, selects transport, starts server |
| Tool registry | `src/mcp/tool-registry.ts` | Registers tools; injects circuit breaker, retry, correlation ID, credentials |
| All tools | `src/domain/tools/index.ts` | Aggregates all 88 `ToolDefinition` arrays |
| REST client | `src/adapter/rest-client.ts` | `get`, `getOne`, `create`, `update`, `remove`, `execute` over HTTPS |
| SSH adapter | `src/adapter/ssh-client.ts` | Runs `/tool/ping`, `/tool/traceroute`, `/tool/torch`, and `run_command` |
| FTP adapter | `src/adapter/ftp-client.ts` | Uploads files via `upload_file` |
| Snapshot engine | `src/domain/snapshot/snapshot-engine.ts` | Captures RouterOS section state before writes |
| Write journal | `src/domain/snapshot/write-journal.ts` | Append-only record of writes with rollback metadata |
| Auth middleware | `src/mcp/authz.ts` | Enforces RBAC at call time |
| Router registry | `src/config/router-registry.ts` | Loads and validates `config/routers.yaml` |

## Transport Options

| Mode | How to start | Use case |
|---|---|---|
| **stdio** (default) | `mikromcp serve` (no env needed) | Local: Claude Desktop, Claude Code, Cursor — the assistant spawns MikroMCP as a child process |
| **HTTP** | `MIKROMCP_TRANSPORT=http mikromcp serve` | Remote / shared: Docker, systemd, multiple clients connecting to one instance |

HTTP transport listens at `POST /mcp` (call) and `GET /mcp` (SSE event stream) on `MIKROMCP_PORT` (default 3000). Every request must carry `Authorization: Bearer <token>`.

## Safety Guarantees

- **Read tools** carry automatic exponential-backoff retry (up to 3 attempts). The circuit breaker does not trip on read failures.
- **Write tools** are idempotent — each checks existing state before acting and returns `already_exists` / `no_change` when nothing needs to be done.
- **All write tools** support `dryRun: true` to preview the planned change without touching the router.
- **Destructive tools** (`reboot`, `manage_user`, and others flagged `destructiveHint: true`) require a short-lived HMAC confirmation token in HTTP mode.
- **Snapshots** are taken of affected RouterOS paths before `apply_plan` runs a write sequence, enabling `rollback_change` to restore previous state.
- **Audit log** records every write and destructive call with identity, tool name, router, parameters (credentials redacted), and outcome.
