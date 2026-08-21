# Development

## Requirements

- **Node.js 22 or newer**
- TypeScript and all dependencies installed via `npm install`

## Scripts

```bash
npm run dev          # tsx watch — hot-reload during development
npm run build        # tsup → dist/main.js (ESM)
npm start            # run built server (stdio mode)
npm test             # vitest + tsc + eslint (run once)
npm run test:watch   # vitest in watch mode
npm run test:integration  # integration tests against a live RouterOS CHR (Docker)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src/
npm run format       # prettier --write src/ test/
```

Run `npm test` before pushing a branch — it runs vitest, tsc, and eslint together, including the doc-accuracy guards (`test/unit/docs/`) and the skill tool-map lockstep (`test/unit/skill/`).

---

## Project Structure

```
src/
├── main.ts                        # Entry point — wires config, CLI, transport
├── types.ts                       # RouterConfig, RouterOSRecord, QueryOptions, Role
│
├── cli/                           # CLI commands
│   ├── index.ts                   # Command dispatcher (init, doctor, serve, update)
│   ├── init.ts                    # mikromcp init — interactive setup wizard
│   ├── serve.ts                   # mikromcp serve — start the MCP server
│   └── doctor.ts                  # mikromcp doctor — connectivity and config health check
│
├── mcp/
│   ├── server.ts                  # MCP server bootstrap and version string
│   ├── tool-registry.ts           # Register tools; inject circuit breaker, retry, auth, correlation ID
│   ├── authz.ts                   # RBAC enforcement — allowedRouters + allowedToolPatterns
│   ├── response-formatter.ts      # Shape MCP tool results
│   └── transports/                # stdio and HTTP/SSE transport wiring
│
├── domain/
│   ├── tools/                     # 34 tool files — one per subsystem
│   │   ├── index.ts               # Aggregates all tool arrays into allTools[]
│   │   ├── tool-definition.ts     # ToolDefinition, ToolContext, ToolResult interfaces
│   │   ├── system-tools.ts        # get_system_status, get_system_clock, set_system_clock, reboot
│   │   ├── system-ops-tools.ts    # run_command (SSH)
│   │   ├── packages-tools.ts      # list_packages, manage_package
│   │   ├── scripts-tools.ts       # list_scripts, manage_script, run_script
│   │   ├── scheduler-tools.ts     # list_scheduled_jobs, manage_scheduled_job
│   │   ├── files-tools.ts         # list_files, get_file_content, upload_file
│   │   ├── container-tools.ts     # list_containers, manage_container
│   │   ├── interface-tools.ts     # list_interfaces, create_vlan
│   │   ├── bridge-tools.ts        # list_bridges, manage_bridge, manage_bridge_port
│   │   ├── wifi-tools.ts          # list_wifi_interfaces, list_wifi_clients, manage_wifi_interface
│   │   ├── wireguard-tools.ts     # list_wireguard_interfaces, list_wireguard_peers, manage_wireguard_peer
│   │   ├── ip-tools.ts            # manage_ip_address
│   │   ├── dns-tools.ts           # list_dns_entries, manage_dns_entry, get_dns_settings
│   │   ├── dhcp-tools.ts          # list_dhcp_leases
│   │   ├── dhcp-server-tools.ts   # list_dhcp_servers, manage_dhcp_server, list_dhcp_pools, manage_dhcp_pool
│   │   ├── route-tools.ts         # list_routes, manage_route
│   │   ├── policy-routing-tools.ts# list_routing_rules, manage_routing_rule, list/manage_routing_table
│   │   ├── routing-protocol-tools.ts # list_bgp_peers, list_ospf_neighbors
│   │   ├── firewall-tools.ts      # list_firewall_rules, manage_firewall_rule
│   │   ├── mangle-tools.ts        # list_mangle_rules, manage_mangle_rule
│   │   ├── address-list-tools.ts  # list_address_list_entries, manage_address_list_entry
│   │   ├── ipsec-tools.ts         # list_ipsec_peers, list_ipsec_policies, manage_ipsec_peer
│   │   ├── certificate-tools.ts   # list_certificates, manage_certificate
│   │   ├── user-tools.ts          # list_users, manage_user
│   │   ├── queue-tools.ts         # list_queues, manage_queue
│   │   ├── vrrp-tools.ts          # list_vrrp_instances, manage_vrrp_instance
│   │   ├── network-services-tools.ts # get_snmp_settings, get_ntp_settings
│   │   ├── netwatch-tools.ts      # list_netwatch_entries, manage_netwatch_entry
│   │   ├── diagnostic-tools.ts    # ping, traceroute, torch, get_log
│   │   ├── fleet-tools.ts         # check_router_health, bulk_execute
│   │   └── change-management-tools.ts # plan_changes, apply_plan, rollback_change
│   │
│   ├── errors/
│   │   ├── error-types.ts         # MikroMCPError, ErrorCategory, Recoverability
│   │   └── error-enricher.ts      # Maps HTTP/network errors to MikroMCPError
│   │
│   └── snapshot/
│       ├── snapshot-engine.ts     # Capture RouterOS section state before writes
│       ├── diff-engine.ts         # Before/after diff normalization and restore planning
│       └── write-journal.ts       # Append-only write record with rollback metadata
│
├── adapter/
│   ├── rest-client.ts             # RouterOS REST client — get, getOne, create, update, remove, execute
│   ├── ssh-client.ts              # SSH adapter — ping, traceroute, torch, run_command
│   ├── ftp-client.ts              # FTP adapter — upload_file
│   ├── circuit-breaker.ts         # Per-router circuit breaker (closed/open/half-open)
│   ├── retry-engine.ts            # Exponential backoff + jitter for read tools
│   ├── connection-pool.ts         # REST client pooling
│   ├── adapter-factory.ts         # Creates adapters from router config
│   ├── query-builder.ts           # RouterOS filter/pagination query construction
│   ├── response-parser.ts         # RouterOS response normalization
│   └── tls-manager.ts             # TLS agent — cert pinning, rejectUnauthorized
│
├── config/
│   ├── app-config.ts              # Reads all MIKROMCP_* env vars
│   ├── router-registry.ts         # Loads and validates routers.yaml with Zod
│   ├── identity-registry.ts       # Loads identities.yaml, resolves bearer tokens
│   ├── maintenance-window.ts      # Parses and evaluates maintenance window schedules
│   └── secrets.ts                 # Credential resolution — never passed to tool handlers
│
└── observability/
    ├── logger.ts                  # pino structured logger — createLogger(module)
    ├── correlation.ts             # Per-request correlation IDs
    └── audit-log.ts               # NDJSON audit log sink for write/destructive calls
```

---

## Testing

Tests live in `test/unit/` mirroring `src/`. No network or real router required — all tests use mock contexts.

```bash
npm test             # vitest + tsc + eslint
npm run test:watch   # vitest in watch mode for active development
```

Test structure for each tool file:
1. **metadata** — correct tool count, names, annotations (`readOnlyHint` especially)
2. **input schema** — valid input with defaults, rejection of extra fields, out-of-range values
3. **handler** — happy path, idempotency (`already_exists`/`no_change`), conflict, dry-run, not-found

`npm test` also runs two doc-accuracy guard suites that fail CI when documentation drifts from code:

- `test/unit/docs/available-tools-sync.test.ts` — verifies `docs/wiki/Available-Tools.md` lists every registered tool.
- `test/unit/docs/tool-count-sync.test.ts` — verifies the tool count in `README.md` and `docs/wiki/Architecture.md` matches the actual count (currently **122 tools**).
- `test/unit/skill/tool-map-sync.test.ts` — verifies `skills/mikromcp/references/tool-map.md` is in lockstep with the registered tools.

If you add, rename, or remove a tool, you must update `docs/wiki/Available-Tools.md` **and** `skills/mikromcp/references/tool-map.md` in the same PR, or these tests will fail.

### Integration tests (live RouterOS CHR)

`test/integration/` runs tool handlers against a real RouterOS instance — a Cloud Hosted Router booted in Docker (QEMU inside the container, KVM-accelerated where `/dev/kvm` exists). These tests catch what mocks structurally cannot: REST response parsing against real wire payloads and idempotency checks against real record types.

```bash
docker compose -f docker-compose.test.yml up -d   # boot CHR (~30-60s with KVM, slower without)
npm run test:integration                          # waits for readiness, provisions, runs (~2-5 min total)
docker compose -f docker-compose.test.yml down    # tear down
```

**Expected runtimes:**
- CHR boot time: ~30-60 seconds with `/dev/kvm` (hardware acceleration), 2-5 minutes without
- Test suite execution: ~2-5 minutes (depends on router responsiveness and test parallelism)
- Total time: ~3-8 minutes for a full run

The suite's global setup polls the REST API until the router answers and, on a fresh boot, sets the admin password (`mikromcp-itest` by default) — CHR ships with an empty admin password, which MikroMCP's credential layer rejects. Endpoints and credentials are overridable via `MIKROMCP_ITEST_HOST`, `MIKROMCP_ITEST_HTTP_PORT`, `MIKROMCP_ITEST_SSH_PORT`, and `MIKROMCP_ITEST_PASSWORD`.

Integration tests are **not** part of `npm test` and do not run in regular CI. The `Integration` GitHub Actions workflow runs them on `workflow_dispatch` or when a pull request carries the `integration` label. Write tests clean up after themselves, so a local CHR container can be reused across runs.

Fleet tests (`bulk_execute`, `list_routers` across routers) need a second CHR and are skipped by default. To run them locally:

```bash
docker compose -f docker-compose.test.yml --profile pair up -d
MIKROMCP_ITEST_PAIR=1 npm run test:integration
```

CI always runs with both routers. The second router's endpoints default to `18081`/`12223` and can be overridden via `MIKROMCP_ITEST_PAIR_HOST`, `MIKROMCP_ITEST_PAIR_HTTP_PORT`, and `MIKROMCP_ITEST_PAIR_SSH_PORT`.

---

## Debugging with MCP Inspector

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is a browser UI for exploring and calling MCP tools interactively — no AI client needed.

```bash
npm run build

ROUTER_CORE01_USER=mcp-api \
ROUTER_CORE01_PASS=your-password \
MIKROMCP_CONFIG_PATH=config/routers.yaml \
  npx @modelcontextprotocol/inspector node dist/main.js
```

Inspector opens at `http://localhost:5173`. Browse all 122 tools, call them with sample inputs, and inspect raw responses including `structuredContent`.

For hot-reload during tool development, replace `node dist/main.js` with `npm run dev`.
