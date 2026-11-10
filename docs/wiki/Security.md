# Security

MikroMCP controls real network devices. Treat it like an operations system: scope access tightly, prefer verified TLS, keep credentials out of source and shell history, and audit everything in shared or production use.

This page consolidates the security model and hardening checklist. Related detail lives in [Configuration](Configuration), [RouterOS API Setup](RouterOS-API-Setup), and [Architecture](Architecture).

## Threat model in one line

An AI assistant with raw router CLI access can issue arbitrary, irreversible commands. MikroMCP narrows that to a typed, permission-aware, auditable tool surface with dry-run previews, confirmation gates, and rollback — so a mistake (or a prompt injection) is contained, visible, and recoverable.

## RouterOS-side hardening

- **Least-privilege users.** Create a dedicated RouterOS user per deployment with only the policies your tools need. A read-only setup needs just `read,rest-api` (the `api` policy is for the binary API, which MikroMCP does not use); full coverage adds `write,test,ssh,sniff,ftp`. See [RouterOS API Setup](RouterOS-API-Setup#required-policies-by-tool-category).
- **Prefer verified TLS.** Run the REST API over `www-ssl`/HTTPS with an explicitly configured server certificate. Set `tls.rejectUnauthorized: true` with a valid CA, or pin the certificate with `tls.fingerprint` for self-signed certs. Plaintext (`tls.enabled: false`) is for lab/local use only.
- **Restrict API exposure.** Limit the REST/SSH services to management subnets with RouterOS firewall rules and the IP service `address` allowlist.

## Credentials

- Keep router credentials in `~/.mikromcp/.env` (loaded at startup), **not** in `routers.yaml` or shell history.
- Credentials are never logged and never included in tool responses; the audit log and write journal redact secret fields (including those nested in `apply_plan` / `bulk_execute` step arrays), and a tool whose parameter can carry a secret inside a free-form value scrubs it before the first log entry, including for calls that are refused and for calls made through `bulk_execute`, `plan_changes` and `apply_plan`. `apply_swos_config` redacts a written-out `snmp.community` in an object config; a text config that writes the community out, or does not parse, is logged as a placeholder instead of the text.
- SwOS secrets live in two environment namespaces that cannot reach each other: `MIKROMCP_SECRET_<NAME>` holds values a switch config may reference as `${NAME}` (the SNMP community), `MIKROMCP_PASSWORD_<NAME>` holds new device passwords for `set_swos_password`. A config can reference a secret only in `snmp.community`, a config given as text must reference it (a literal is refused, because the text reaches the audit log), and the community is redacted in every SwOS tool output, `get_swos_endpoint snmp.b` and `write_swos_blob` previews included. A switch's `secrets` list in `routers.yaml` binds secrets to it: a config applied to that switch may reference only the listed names, and a switch without a list may reference none, so one switch's community cannot be pushed onto another by a wrong `${NAME}`. RouterOS routers bind secrets the same way for `create_backup`'s `passwordSecret`, which encrypts a backup without the password ever entering the conversation.
- `upgrade_swos_firmware` is the one tool that connects out: it fetches `<board>.LATEST` and the image from `https://download.mikrotik.com/swos/` with redirects refused and a size limit, then checks the image before flashing. A host without that egress passes the image as a named `file` from `<MIKROMCP_DATA_DIR>/swos/` instead. Backups saved there hold the switch's credentials, so the folder is created `0700` and its files `0600`.
- The connection pool evicts a router's cached client on authentication failure so stale/rotated credentials are not reused.

## HTTP mode access control

When running with `MIKROMCP_TRANSPORT=http`:

- **Run behind a trusted network boundary** (reverse proxy, VPN, or private network). Bind to `127.0.0.1` unless a proxy terminates TLS in front.
- **Bearer-token auth is mandatory.** Every request must carry `Authorization: Bearer <token>`. Tokens are stored only as bcrypt hashes in `~/.mikromcp/identities.yaml`.
- **Set `MIKROMCP_CONFIRMATION_SECRET`.** It signs the confirmation tokens that gate destructive operations. The server refuses to start in HTTP mode without it when any `readonly` or `operator` identity exists. With only `admin` identities it is optional for per-router calls. `bulk_execute` write fan-outs are gated for every role either way: without a configured secret the server signs fleet tokens with a random per-process secret, so those tokens stop working after a restart and do not verify on a sibling instance.

## RBAC identities

Each identity declares the smallest practical scope:

- `role` — `readonly` and `operator` must confirm destructive tools; `admin` and `superadmin` skip the gate. The role does not limit which tools can be called — use the pattern list for that.
- `allowedRouters` — which routers this identity may touch. An empty list means all; entries are exact router ids, not globs.
- `allowedToolPatterns` — which tools it may call, as `*` globs (e.g. `list_*`, `get_*`, `ping` for a read-only identity). An empty list means all. Fleet tools (`bulk_read`, `bulk_execute`, `list_routers`, `list_journal`) are matched by their own name too, and the bulk tools also check each tool they fan out. A broad pattern such as `manage_*` includes `manage_script` and `manage_scheduled_job`, which run arbitrary RouterOS script — see [Change safety](#change-safety).

See [Configuration → Identities](Configuration#identities-http-transport) for the file format.

Define identities for distinct consumers (a read-only dashboard vs. an automation runner) rather than sharing one all-powerful token.

## Change safety

- **Dry-run first.** Every write tool supports `dryRun: true` to preview the diff without touching the router.
- **Confirmation tokens.** When `MIKROMCP_CONFIRMATION_SECRET` is set, `readonly` and `operator` identities must call a destructive tool twice: the first call returns `APPROVAL_REQUIRED` with a single-use token valid for five minutes, the second call carries it as `confirmationToken`. `admin` and `superadmin` (including the built-in stdio identity) skip this per-router gate. Every `bulk_execute` fan-out of a write tool, destructive or not, is gated for every role with a fleet-wide token obtained the same two-step way.
- **A token approves the state that was previewed.** Besides the request, the token carries a fingerprint of the configuration the tool touches on the router — every record under the tool's snapshot paths (for `apply_plan`, every step's paths; for `bulk_execute`, every targeted router), read when the token is issued. The fingerprint drops dynamic records, except those the call acts on itself (the dynamic lease `manage_dhcp_lease` makes static, the timed entry `manage_address_list_entry` targets), and leaves out counters and status fields that change on their own (`bytes`, `packets`, a DHCP lease's `expires-after`, a WireGuard peer's `last-handshake`, an address-list entry's remaining `timeout`, and similar), and keeps record order, since order is configuration on a firewall chain. When the second call arrives, the server reads the same paths again; if the fingerprint differs, the call is refused with `CONFIRMATION_STATE_CHANGED` (category `CONFLICT`) and nothing is written. So approving a preview does not approve a different diff: a rule edited or inserted between the preview and the apply makes the old token useless. The fingerprint covers whole sections, not only the records the call matches, so an unrelated edit in the same section also invalidates a token; that costs one more round-trip and never lets a change through. Not covered: SwOS switches (their `.b` blobs mix configuration with live readings such as uptime and PoE power) and `set_system_clock` (the clock moves on its own).
- **Admins and the drift check.** `admin` and `superadmin` still get no token, so there is no previewed state to bind a per-router call to. For a multi-step change, pass the `planFingerprint` from `plan_changes` to `apply_plan`: it is checked for every role and refuses the plan with `PLAN_STATE_CHANGED` if the configuration changed after the preview. `bulk_execute` fleet tokens, required for every role, carry the state binding too.
- **What a confirmation token is — and is not.** The token is returned to the caller that asked for it. It binds the second call to the exact tool, router(s), parameters, identity, and observed configuration of the first, and stops one-shot mistakes, runaway loops, and approvals of a preview that no longer holds; it is **not** a human approval. An LLM client can complete the round-trip on its own. MikroMCP's server instructions and usage skill tell the assistant to show the user what will change before re-submitting, but for an enforced human in the loop rely on your MCP client's per-tool approval prompts (clients typically key them off the `destructiveHint` annotation) and scope identities with `allowedToolPatterns`.
- **Which tools are destructive.** Every write tool that can remove, overwrite, or reconfigure router state, or run RouterOS script, is annotated `destructiveHint: true` — in practice every write tool except `plan_changes`, which only previews. A unit test enforces this for new tools. Treat these as equivalent to arbitrary script execution with the RouterOS user's policies: `run_command`, `run_script`, `manage_script`, `manage_scheduled_job` (its `onEvent` is script), and `upload_file` (RouterOS runs a file named `*.auto.rsc` as soon as it arrives over FTP, which `upload_file` falls back to when SFTP is unavailable). The `run_command` deny-list applies only to `run_command`.
- **Where these tools run.** `run_command` and the other script-capable tools act on the **router**, with the RouterOS user's policies. `run_command` sends its text to the router over an SSH `exec` channel; nothing runs in a shell on the machine hosting MikroMCP. Their reach is therefore bounded by the RouterOS user, not by the `run_command` deny-list, which is a guard against obvious mistakes and not an authorization control.
- **Fleet reads vs. fleet writes.** `bulk_read` fans out only read-only tools and refuses everything else on the server, so a client that approves tools by name (for example Claude Code permission rules) can allow `bulk_read` and keep `bulk_execute` behind a prompt.
- **Maintenance windows.** Routers can declare windows during which destructive operations are permitted; calls outside them are rejected with `PERMISSION_DENIED`.
- **Snapshots & rollback.** Write tools snapshot affected config and append a journal entry before applying, so a change can be reversed with `rollback_change`.

## Scoping arbitrary-command tools

If a client should never run arbitrary RouterOS commands or script, take the tools away from it rather than relying on the `run_command` deny-list:

- **Leave them out of `allowedToolPatterns`.** List what the identity may call (for example `list_*`, `get_*`, `ping`, `manage_firewall_rule`) instead of a broad `manage_*` or an empty list, which allows everything. For stdio, set `MIKROMCP_STDIO_IDENTITY` to a scoped identity; without it the stdio client is the built-in superadmin and can call every tool.
- **Narrow `run_command` when you keep it.** A `cmdAllow` list (per router in `routers.yaml`, or `MIKROMCP_CMD_ALLOW`) makes every `;`-separated segment match an allowed pattern, for example `/ip route print*` and `/interface print*`.
- **Limit the RouterOS user.** A user group without `ssh` cannot use `run_command` at all; one without `write` cannot change configuration through any tool.

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

For vulnerabilities or unsafe behavior, please open a [private GitHub security advisory](https://github.com/AliKarami/MikroMCP/security/advisories/new) rather than a public issue, so a fix can be prepared responsibly. [`SECURITY.md`](https://github.com/AliKarami/MikroMCP/blob/main/SECURITY.md) describes what is in scope.
