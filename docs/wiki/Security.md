# Security

MikroMCP controls real network devices. Treat it like an operations system: scope access tightly, prefer verified TLS, keep credentials out of source and shell history, and audit everything in shared or production use.

This page consolidates the security model and hardening checklist. Related detail lives in [Configuration](Configuration), [RouterOS API Setup](RouterOS-API-Setup), and [Architecture](Architecture).

## Threat model in one line

An AI assistant with raw router CLI access can issue arbitrary, irreversible commands. MikroMCP narrows that to a typed, permission-aware, auditable tool surface with dry-run previews, confirmation gates, and rollback — so a mistake (or a prompt injection) is contained, visible, and recoverable.

## RouterOS-side hardening

- **Least-privilege users.** Create a dedicated RouterOS user per deployment with only the policies your tools need. A read-only setup needs just `read,api,rest-api`; full coverage adds `write,test,ssh,sniff,ftp`. See [RouterOS API Setup](RouterOS-API-Setup#required-policies-by-tool-category).
- **Prefer verified TLS.** Run the REST API over `api-ssl`/HTTPS. Set `tls.rejectUnauthorized: true` with a valid CA, or pin the certificate with `tls.fingerprint` for self-signed certs. Plaintext (`tls.enabled: false`) is for lab/local use only.
- **Restrict API exposure.** Limit the REST/SSH services to management subnets with RouterOS firewall rules and the IP service `address` allowlist.

## Credentials

- Keep router credentials in `~/.mikromcp/.env` (loaded at startup), **not** in `routers.yaml` or shell history.
- Credentials are never logged and never included in tool responses; the audit log and write journal redact secret fields (including those nested in `apply_plan` / `bulk_execute` step arrays).
- The connection pool evicts a router's cached client on authentication failure so stale/rotated credentials are not reused.

## HTTP mode access control

When running with `MIKROMCP_TRANSPORT=http`:

- **Run behind a trusted network boundary** (reverse proxy, VPN, or private network). Bind to `127.0.0.1` unless a proxy terminates TLS in front.
- **Bearer-token auth is mandatory.** Every request must carry `Authorization: Bearer <token>`. Tokens are stored only as bcrypt hashes in `~/.mikromcp/identities.yaml`.
- **Set `MIKROMCP_CONFIRMATION_SECRET`.** It signs the confirmation tokens that gate destructive operations. The server refuses to start in HTTP mode without it when any `readonly` or `operator` identity exists; with only `admin` identities it is optional, because those roles skip the gate anyway.

## RBAC identities

Each identity declares the smallest practical scope:

- `role` — `readonly` and `operator` must confirm destructive tools; `admin` and `superadmin` skip the gate. The role does not limit which tools can be called — use the pattern list for that.
- `allowedRouters` — which routers this identity may touch. An empty list means all; entries are exact router ids, not globs.
- `allowedToolPatterns` — which tools it may call, as `*` globs (e.g. `list_*`, `get_*`, `ping` for a read-only identity). An empty list means all.

See [Configuration → Identities](Configuration#identities-http-transport) for the file format.

Define identities for distinct consumers (a read-only dashboard vs. an automation runner) rather than sharing one all-powerful token.

## Change safety

- **Dry-run first.** Every write tool supports `dryRun: true` to preview the diff without touching the router.
- **Confirmation tokens.** When `MIKROMCP_CONFIRMATION_SECRET` is set, `readonly` and `operator` identities must call a destructive tool twice: the first call returns `APPROVAL_REQUIRED` with a single-use token valid for five minutes, the second call carries it as `confirmationToken`. `admin` and `superadmin` (including the built-in stdio identity) skip the gate. `bulk_execute` uses a fleet-wide token the same way.
- **Maintenance windows.** Routers can declare windows during which destructive operations are permitted; calls outside them are rejected with `PERMISSION_DENIED`.
- **Snapshots & rollback.** Write tools snapshot affected config and append a journal entry before applying, so a change can be reversed with `rollback_change`.

## Auditing

- Set `MIKROMCP_AUDIT_LOG_PATH` to capture an NDJSON audit trail (identity, tool, router, params with secrets redacted, outcome, duration) for shared or production use.
- Correlation IDs tie every log line and audit record for a single tool call together.

## Hardening checklist

- [ ] Dedicated least-privilege RouterOS user
- [ ] TLS verification on, or certificate fingerprint pinned
- [ ] Credentials only in `~/.mikromcp/.env`
- [ ] HTTP mode behind a trusted boundary, `MIKROMCP_CONFIRMATION_SECRET` set
- [ ] Identities scoped with minimal `allowedRouters` / `allowedToolPatterns`
- [ ] Audit logging enabled
- [ ] Write changes previewed with `dryRun: true` before applying

## Reporting a vulnerability

For vulnerabilities or unsafe behavior, please open a private GitHub security advisory or contact the maintainer **before** publishing details, so a fix can be prepared responsibly.
