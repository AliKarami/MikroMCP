# Changelog

All notable changes to MikroMCP are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versioning follows [Semantic Versioning](https://semver.org/).

Each release section covers changes **since the previous release only**.

---

## [Unreleased]

### Added
- Router entries can use a separate SSH/SFTP username and an absolute private-key path; SSH-backed commands and SFTP uploads no longer require RouterOS password authentication when a key is configured.

### Fixed
- SSH-backed diagnostic tools now build one RouterOS command with every user-supplied string quoted, preventing command injection through ping, traceroute, or torch arguments.

## [1.10.0] - 2026-08-23

### Added
- **RouterOS CHR integration test harness.** `test/integration/` runs tool handlers against a real RouterOS instance — a Cloud Hosted Router booted in Docker via `docker-compose.test.yml` (QEMU, KVM-accelerated where available). The suite provisions a fresh CHR automatically (readiness poll + admin password setup) and covers REST response parsing, the full idempotency lifecycle (dry-run → create → already_exists → conflict → remove → not-found) for IP addresses, routes, firewall rules, DNS entries, VLANs, and VRRP instances, and the complete change-safety cycle (`plan_changes` → `apply_plan` → snapshot → `rollback_change`) against live state. A smoke sweep additionally runs every parameter-less RouterOS read tool (~50) against the live router, so new list/get tools are covered automatically; SSH-backed tools (`run_command`, `export_config`, `ping`) are exercised over their real transport, and one suite drives the full tool executor (retry, circuit breaker, snapshot + journal wiring). An opt-in second CHR (`docker compose --profile pair` + `MIKROMCP_ITEST_PAIR=1`; always on in CI) covers fleet operations — `list_routers` and `bulk_execute` fan-out across two genuinely distinct live routers. Runs via `npm run test:integration`; a new `Integration` GitHub Actions workflow runs it on demand (`workflow_dispatch` or the `integration` PR label). This closes the harness the v1.0 roadmap had deferred.

### Fixed
- `rollback_change` could not restore a set-menu singleton, and made things worse trying: `ip/dns`, `system/ntp/client`, `container/config`, and the pre-7.16 OVPN server have no `.id` and no semantic key, so the restore planner fell through to signature matching and emitted a `DELETE <path>/undefined` followed by a `PUT` that RouterOS rejects. Singletons are now detected structurally (at most one record per side, no `.id`) and restored as a whole-record `POST <path>/set`. The read-only `cache-used` and `dynamic-servers` fields join the runtime-field filter, since a whole-record write fails outright if it carries one. Reachable only since the singleton write fix above — before that, those tools could not write at all, so there was never anything to roll back.
- `manage_route` falsely reported a CONFLICT when re-adding an identical route: the idempotency check compared the record's `distance` (parsed to a number by the response parser) against a string with strict equality. Found by the new integration harness on its first run.
- `manage_ip_address` with `action=update` always reported `updated` (and re-sent `disabled`) even when nothing changed: the change detection compared the record's parsed boolean `disabled` against the string `"false"`. Also found by the integration harness.
- `manage_vrrp_instance` could never report `already_exists`: the idempotency check compared the record's `vrid` (parsed to a number) against a string, so every identical re-add threw a false CONFLICT. Same bug class as the two above, found by reviewing for the pattern.
- `manage_vlan` had the same false CONFLICT on an identical re-add (`vlan-id` parsed to a number, compared against a string). Confirmed and covered live by the integration harness.
- `manage_ovpn_server` with `action=disable` was a silent no-op on an enabled server: the state check compared the parsed boolean `enabled` field against the string `"yes"`, so the server always looked disabled. Enable/disable now use `isTrue()`; `set` no longer re-sends an unchanged `port`.
- `manage_ovpn_client` updates always re-sent (and reported a change for) an unchanged `port` — parsed number compared against a string.
- `manage_certificate` trust/untrust never recognised the current trust state (`trusted` compared against `"yes"`/`"no"` literals), so the idempotent short-circuit never fired.
- `manage_ntp_client` always reported (and re-applied) an `enabled` change even when the value already matched — parsed boolean compared against a stringified boolean.
- `manage_dns_settings` always reported (and re-applied) changes for unchanged `allow-remote-requests`, `max-udp-packet-size`, and `cache-size` — same comparison class, so every no-op call issued a phantom write. Found by a second audit pass; the non-boolean comparisons now go through a shared `sameValue()` helper next to `isTrue()` in the response parser so the rule lives in one place.
- `manage_ipsec_policy` never matched an existing policy: its composite key compared the parsed boolean `tunnel` against a string, so identical re-adds created duplicate IPSec policies and remove/enable/disable threw NOT_FOUND for policies that plainly exist.
- `manage_container_config` always reported (and re-applied) an unchanged `ram-high` — parsed number compared against a string.
- `get_ovpn_server` reported `enabled=undefined` on RouterOS 7.16+ (which sends `disabled` instead of `enabled`); it now derives the state through the same dialect detection as `manage_ovpn_server`.
- `list_connections` was completely broken: every call failed with HTTP 400. Queries carrying a `.proplist` were POSTed to the bare collection path, which RouterOS rejects — the REST client now targets the `/print` command endpoint. Found by the new read-tool smoke sweep on its first run; `list_connections` was the only tool using `.proplist`.
- A tool call naming an unknown `routerId` returned a generic `INTERNAL_ERROR` ("An unexpected internal error occurred") because the router registry threw a plain `Error`. It now returns a typed `NOT_FOUND` (`ROUTER_NOT_FOUND`) listing the available routers and pointing at `list_routers`.
- `manage_ovpn_server` enable/disable did not work on RouterOS 7.16+: that release replaced the singleton's `enabled` flag with per-instance `disabled`, so the tool read a field the device no longer sends and wrote a parameter the API rejects (`unknown parameter enabled`). The tool now detects which dialect the device speaks and reads/writes the matching field. Found while provisioning the OVPN server for the integration suite.
- `manage_dns_settings`, `manage_ntp_client`, and `manage_container_config` could never actually write: RouterOS set-menu singletons return no `.id`, so every non-dry-run change was PATCHed to `.../undefined` and failed with HTTP 500 (verified live against the CHR). Singleton writes now go through the `POST <path>/set` command endpoint. The pre-7.16 `manage_ovpn_server` write path had the same flaw and uses the same fix when the record carries no `.id`.
- `manage_ovpn_server` and `get_ovpn_server` acted on an arbitrary instance when a RouterOS 7.16+ router carried more than one OVPN server instance; they now throw a typed CONFLICT (`OVPN_SERVER_AMBIGUOUS`) naming the instances instead of silently picking the first.
- `manage_wifi_interface` always reported (and re-applied) a `disabled` change even when the value already matched — a parsed boolean compared against a string, the same bug class as the sweep above; `no_change` was unreachable. The `ssid` comparison had the numeric variant of the same bug (a purely numeric SSID parses to a number) and now goes through `sameValue()`.
- `manage_pppoe_client` updates always re-sent (and reported a change for) unchanged `add-default-route` and `dial-on-demand` flags — parsed booleans compared against `"yes"`/`"no"` literals.
- `manage_vlan`, `manage_ovpn_client`, and `manage_pppoe_client` could not find a resource with a purely numeric name (the parser turns a name like `"100"` into a number), so remove/enable/disable reported NOT_FOUND and identical re-adds mis-errored; identity matching now goes through `sameValue()`.

## [1.9.0] - 2026-08-16

SwOS support was contributed by [@f0086](https://github.com/f0086) — MikroMCP's first community feature contribution, and the first time the server reaches beyond RouterOS.

### Added
- **SwOS support (experimental).** Devices can now be declared with `deviceType: "swos"` in `routers.yaml` — MikroTik switch firmware, both SwOS and SwOS Lite (e.g. CSS326, CSS610-8P-2S+); `"swos-lite"` is accepted as an alias. These speak the `.b` HTTP API with digest auth instead of the RouterOS REST API, and the field-naming dialect is detected per field from the device's own response. MikroTik does not document that API: the schema is reverse-engineered and pinned to a CSS610-8P-2S+ on SwOS Lite 2.21, so other models decode best-effort (unrecognised keys are preserved under `_raw`) and writes should be dry-run first.
- `list_swos_endpoints` tool — lists the supported `.b` endpoints and their decoded field names (schema introspection, no device call)
- `get_swos_status` tool — identity, model, firmware, uptime, per-port link/speed/duplex, PoE mode/state/power, and SFP modules
- `get_swos_endpoint` tool — fetches and decodes any single `.b` endpoint; unknown keys are preserved under `_raw`
- `write_swos_blob` tool — merges fields into a `.b` endpoint and writes the whole blob back (the only write the firmware accepts). Defaults to `dryRun: true`, snapshots the pre-write blob, and is undoable via `rollback_change`. Untouched fields are re-sent byte-for-byte, and a field the device did not send is refused rather than injected, so a firmware that renames or drops a key fails loudly instead of writing junk.
- Firmware compatibility reporting for SwOS. `get_swos_status` and `write_swos_blob` compare the switch's model and firmware against the set the schema was validated on and report the verdict in `structuredContent.compatibility`; writes also name any wire keys the schema does not map. It warns rather than blocks — a version allow-list cannot be kept current for hardware the project has never seen, and the structural checks (a removed or renamed field is refused, an added one is preserved verbatim) already cover the drift that can be detected without one.
- Tools declare a `platform`; the executor and `bulk_execute` refuse to run a RouterOS tool against a switch and vice versa (`PLATFORM_MISMATCH`).

### Changed
- `check_router_health` now works on SwOS switches (reports firmware and uptime from `sys.b`); `list_routers` reports each device's `deviceType`.
- `rollback_change` restores SwOS writes by re-POSTing the exact pre-write blob.
- `snapshotPaths` accepts a function of the call's arguments, for tools whose write target is a parameter rather than a fixed path.
- mikromcp.com rebuilt around a cool brand ramp — teal `#2DD4BF` → cyan → blue → violet `#8B5CF6`, anchored on the logo teal. The page is now structured as alternating zones: full-bleed gradient colour fields for the hero and closing call to action, large rounded gradient panels for the problem statement and request pipeline, and plain ground between them. Geometric motifs (a fan of rounded squares, a node/edge mesh, radiating arcs) are authored as inline SVG in `site/src/components/Shapes.astro` rather than shipped as image assets, so they stay crisp and theme-aware. Feature tiles each sample a different span of the ramp; buttons are pills with a solid-white primary that holds up on a colour field. The orange accent is gone.
- mikromcp.com and docs.mikromcp.com share the ramp, and the docs header carries the same gradient rule, so the two read as one product.
- Landing page product facts (tool count, version, features, example prompts, FAQ) now come from a single source, `site/src/data/content.ts`; `/llms.txt` and `/llms-full.txt` are generated from it instead of being hand-maintained static files. Site documentation links point at docs.mikromcp.com rather than the GitHub wiki.
- `scripts/sync-version.mjs` also regenerates `site/src/data/version.ts`, so the version in the site footer follows `npm version` instead of being edited by hand (it had been stuck at v1.6.0 since the v1.6 release).
- The Open Graph share image is regenerated from the ramp and reads its tool count from `site/src/data/content.ts`, so it cannot state a different number from the page.

### Fixed
- SwOS writes are transported over `node:http` with a lenient parser: the CSS610 firmware terminates the status line of a POST response with a bare LF (`HTTP/1.0 200 OK\n`) instead of CRLF, which a strict parser rejects — reporting a write that had actually been applied as a failure. Verified against a CSS610-8P-2S+ on firmware 2.21. Note that this leniency is scoped to the SwOS client only: RouterOS connections still use a strict parser.
- A SwOS request that gets no response (the CSS610 firmware applies a POSTed `.b` blob without ever answering, and a longer wait does not help) is now classified as `ROUTER_TIMEOUT` with code `SWOS_REQUEST_TIMEOUT` instead of a generic internal error. For writes this triggers the existing ambiguous-outcome handling — the caller is told the change may already have been applied and to verify switch state before retrying, and the write is explicitly not retryable. Read timeouts stay retryable. The client timeout is now injectable for tests.
- Stale tool count corrected across the landing page, `/llms.txt`, `/llms-full.txt`, and the wiki pages published to docs.mikromcp.com (`Available-Tools`, `Connecting-to-AI-Assistants`, `Development`, `Getting-Started`, `RouterOS-API-Setup`) — the site had been stuck at 117.
- `ROADMAP.md` and `docs/wiki/Roadmap.md` stopped at v1.6.0; v1.7 and v1.8 are now documented, so the published roadmap reflects shipped releases.
- `test/unit/docs/tool-count-sync.test.ts` now also covers the landing page and the wiki pages that state a current tool count; a new `site-version-sync.test.ts` checks the site footer version and README badge against `package.json`.

## [1.8.0] - 2026-07-21

### Security
- HTTP transport hardening: `GET /metrics` now requires a bearer token when any identities are configured (was fully unauthenticated); 401 responses carry a `WWW-Authenticate: Bearer` header; Streamable HTTP sessions are bound to the identity that created them (a token can no longer drive another identity's session) and idle sessions are evicted after 30 minutes (previously the session map grew unbounded); token lookups are cached by `sha256(token)` so bcrypt runs once per token instead of on every request; and non-integer numeric env vars (`MIKROMCP_PORT`, body/rate/ssh/retention) now fail fast with a clear configuration error instead of silently becoming `NaN`.
- `allowedToolPatterns` in `identities.yaml` used prefix-only matching: it took the text before the first `*`, so a pattern like `*_wifi` had an empty prefix and silently allowed **every** tool. Matching now uses a proper anchored glob, so leading/mid-string wildcards (`*_wifi`, `manage_*_rule`) behave correctly.
- `run_command`'s deny-list guard was trivially bypassable: it matched patterns against the raw command string, so ROS7 slash-path syntax (`/system/reboot`), whitespace/case variation, command chaining (`:put 1; /system reboot`), and `:execute`/`:parse` indirection all slipped past. The guard now normalizes each command (path and space separators treated equally) and checks every `;`/newline-separated segment; `:execute`/`:parse` are denied by default. Documented explicitly as best-effort defense-in-depth, not an authorization boundary.
- TLS certificate fingerprint pinning (`tls.fingerprint` in `routers.yaml`) was a silent no-op: it was enforced via `tls.checkServerIdentity`, which Node ignores when `rejectUnauthorized` is false — exactly the self-signed setup the docs recommend pinning for. Pinning is now enforced in the connection layer (post-handshake `fingerprint256` check that destroys the socket on mismatch), so it holds regardless of `rejectUnauthorized`.

### Changed
- Tool risk annotations audited against a written rubric (destructive = removes resources, changes the authentication/authorization surface, or can sever connectivity/running services). `manage_user`, `manage_user_group`, `manage_script`, `run_script`, `manage_container`, `manage_vrrp_instance`, `manage_mangle_rule`, `manage_ipsec_policy`, `manage_dhcp_server`, `manage_wifi_interface`, `manage_package`, `manage_routing_rule`, `manage_routing_table`, `manage_dns_settings`, `manage_interface_list`, `manage_interface_list_member`, `manage_address_list_entry`, and `manage_wireguard_interface` are now `destructiveHint: true` (they gate confirmation, maintenance windows, and circuit-breaker tripping). `fetch_url` is no longer marked read-only (POSTs have side effects and `outputFile` writes to the router) and both `fetch_url` and `bandwidth_test` are marked open-world. `export_config` is no longer read-only (it writes a file when `file` is set). `bandwidth_test` no longer auto-retries and its `duration` cap dropped from 30s to 20s (it collided with the 30s REST timeout). A tool may now set `retryable: false` to opt a read tool out of automatic retry.
- `upload_file` now prefers SFTP (encrypted, over the existing SSH channel) and only falls back to plaintext FTP when SFTP is unavailable, avoiding sending router credentials and file contents in the clear. The result reports which transport was used; the FTP path is labeled as plaintext.
- Confirmation tokens (single-tool and fleet `bulk_execute`) are now self-verifying HMACs: validity is recomputed from the current call and secret rather than looked up in an in-memory pending map, so a token issued before a server restart still verifies afterward and the HMAC secret is actually load-bearing. Single-use replay protection is kept via an in-memory cache (single-instance; multi-instance replay within the TTL is a documented limitation).

### Fixed
- `bulk_execute` tag targeting now matches routers carrying **ALL** requested tags, as the schema documents (it previously matched ANY tag, over-targeting destructive fan-outs). Fanned-out calls also run through the full per-router safety stack — maintenance-window enforcement, per-router circuit breakers, and read-tool retry — which direct calls already had but the fleet path skipped.
- `get_file_content` now caps returned content at 65536 characters (with a truncation marker and `truncated`/`totalLength` in `structuredContent`) so a large file can't blow up the client context, and `list_connections` requests only the fields it renders to shrink large conntrack payloads.
- When a write tool fails with an ambiguous outcome (router timeout or unreachable), the error's suggested action now warns that the write may already have been applied and to verify router state before retrying, instead of implying a blind retry is safe.
- Fleet tools (`skipRouterContext`) received `null`-cast router-scoped capabilities; a tool that mistakenly touched `routerClient`/`sshClient`/`ftpClient`/`routerConfig` crashed with an opaque `TypeError`. These now raise a typed `FLEET_CONTEXT_UNAVAILABLE` error explaining to target a specific router.
- The REST connection pool keyed clients by router id only, so a client cached with old credentials kept being reused after credentials rotated. Clients are now also keyed by a credential hash and rebuilt (old one closed) when credentials change.
- `rollback_change`/snapshots are substantially safer: snapshots now store only restorable configuration (dynamic router-generated records excluded, runtime/counter fields like `bytes`/`packets`/`rx-byte`/uptime stripped), so counters no longer produce spurious diffs and read-only fields are never written back and rejected mid-restore. Semantic-key diffing falls back to whole-record matching when the key is not unique within a side (e.g. multiple uncommented firewall rules that previously collapsed to one and scheduled the rest for deletion). Order-sensitive paths (firewall filter/nat/mangle, routing rules) now emit a warning that rule order is not restored, and deleted users are never recreated (passwords aren't in snapshots) — a warning is returned instead.
- HTTP request bodies and SSH command output are now decoded once over the full byte stream instead of per chunk, so multi-byte UTF-8 characters split across chunk boundaries are no longer corrupted into replacement characters.
- SSH command timeouts (`run_command`, inline `export_config`) now reject with an `ETIMEDOUT` error instead of silently resolving with partial (or empty) output as if the command had succeeded — the command may still be running on the router, so the caller is told to verify.
- Maintenance windows spanning midnight (e.g. `22:00`–`02:00`) never matched, so destructive operations were blocked around the clock on routers configured with an overnight window. Overnight windows are now supported: `days` names the day the window opens and the window wraps past midnight into the following day.
- Boolean record fields (`disabled`, `running`, `dynamic`, `active`, …) are parsed into real JS booleans by the REST client, but several idempotency checks compared them against the string `"true"` — which is always false — so `enable` actions on `manage_scheduled_job`, `manage_firewall_rule`, `manage_mangle_rule`, `manage_routing_rule`/`manage_routing_table`, `manage_package`, and the `manage_ip_address` add idempotency check silently reported "no change" without applying anything. All boolean-field comparisons now go through a shared `isTrue()` helper. `RouterOSRecord` values are now typed `string | number | boolean` to reflect the parser's output.
- Numeric parsing kept 64-bit RouterOS counters (e.g. `rx-byte` above 2^53) as JS numbers, silently losing precision. Unsafe integers now stay strings.

## [1.7.0] - 2026-07-14

### Added
- `list_routers` tool — read-only enumeration of the routers configured in `routers.yaml` (id, host, port, TLS status, tags, ROS version, and which is the default), so MCP clients can discover valid `routerId` values and tags for targeting other tools (including `bulk_execute`) without opening the config file. Reflects local config only — no RouterOS API call and no credentials in the response; results are scoped to the caller's `allowedRouters` ([#53](https://github.com/AliKarami/MikroMCP/issues/53))

## [1.6.1] - 2026-07-11

### Fixed
- `get_log`'s `sinceMinutes` filter now recognises RouterOS full-date timestamps (`YYYY-MM-DD HH:MM:SS`), which routers use for entries older than the current day. Previously these timestamps were unparseable and kept regardless of the time window, so `sinceMinutes` appeared to have no effect on logs spanning multiple days ([#45](https://github.com/AliKarami/MikroMCP/issues/45))
- `get_log`'s `sinceMinutes` window is now measured against the router's own clock instead of the MikroMCP host clock. When the host and router were in different timezones, the window was offset by the difference; the tool now reads `system/clock` (only when `sinceMinutes` is set) and falls back to the host clock if it is unavailable
- All 44 `list_*` tools now serialize their rows into the human-readable `content` field (one compact `key=value` line per record) instead of returning only a summary count. Clients that render only `content` (not `structuredContent`) previously saw no itemized data — e.g. `list_firewall_rules` returned "Full records in structuredContent." with no rows. `structuredContent` still carries the full untruncated records ([#46](https://github.com/AliKarami/MikroMCP/issues/46))

## [1.6.0] - 2026-05-30

### Added
- `MIKROMCP_DEFAULT_ROUTER` environment variable — sets the router used when a tool call omits `routerId`
- MikroMCP usage skill (`skills/mikromcp/`) — a progressive-disclosure Claude Code skill for driving the tools safely (tool selection, dry-run/confirm/rollback flows, fleet ops, error recovery) with curated links to official MikroTik documentation. See `docs/wiki/Using-the-Skill.md`.
- MCP server now sends a concise `instructions` string in the initialize response (safety nudge: dry-run writes, confirmation tokens, prefer dedicated tools over `run_command`) so any client gets baseline guidance even without the usage skill

### Changed
- `routerId` is now optional on every router-scoped tool. When omitted, the server resolves it from `MIKROMCP_DEFAULT_ROUTER`, or the sole configured router when exactly one exists; otherwise it returns a `MISSING_ROUTER_ID` error listing available routers
- Slimmed the advertised tool catalog (`tools/list`) by reusing shared schema-field definitions and tightening the longest tool descriptions — roughly 14% fewer tokens per catalog with no change to tool behaviour
- List tools now return a concise summary in their text `content`; full per-item detail remains in `structuredContent`, avoiding duplicate payloads across both result fields
- `mikromcp init` now prompts whether to set the configured router as the default (`MIKROMCP_DEFAULT_ROUTER`), writes it into `.env` accordingly (active when accepted, commented-out otherwise), shows the choice in the summary, and points to the usage skill in its next-steps
- `mikromcp doctor` now validates default-router resolution (errors if `MIKROMCP_DEFAULT_ROUTER` names an unknown router, notes the implicit sole-router default, warns when multiple routers have no default) and checks whether the usage skill is installed
- Internal: extracted a shared `paginate()` helper for client-side pagination, a shared `toolError()` handler-error wrapper, and made the circuit breaker `state` getter side-effect-free (the open→half-open transition is now explicit). No user-facing behaviour change.

### Fixed
- Audit log redaction now recurses into arrays, so secrets nested in step arrays (e.g. `apply_plan` / `bulk_execute` step params) are stripped instead of leaking
- `manage_firewall_rule` idempotency now compares `src-address`, `dst-address`, and `protocol` in addition to chain/action/ports — previously rules differing only by address or protocol were treated as identical (returned `already_exists`) instead of raising a `CONFLICT`
- `bulk_execute` now takes config snapshots and writes journal entries for destructive sub-operations, matching single-router write tools (enables rollback of fleet changes)

---

## [1.5.0] - 2026-05-28

### Added
- `manage_dns_settings` tool — write upstream servers, cache TTL, allow-remote-requests
- `delete_file` tool — delete a file from the router filesystem by name
- `manage_ipsec_policy` tool — add/remove/enable/disable IPSec policies
- `manage_wireguard_interface` tool — add/remove/enable/disable WireGuard interfaces
- `get_container_config` tool — read global container registry/RAM/veth config
- `manage_container_config` tool — write global container config settings
- `list_container_envs` tool — list container environment variable entries
- `manage_container_env` tool — add/remove container environment variables
- `list_container_mounts` tool — list container volume mount definitions
- `manage_container_mount` tool — add/remove container volume mounts
- `bandwidth_test` tool — run RouterOS bandwidth test to a remote btest server
- `fetch_url` tool — send HTTP/HTTPS request from the router using /tool/fetch
- `list_connections` tool — list active firewall connection tracking entries
- `list_interface_lists` tool — list all interface lists
- `manage_interface_list` tool — add/remove interface lists
- `manage_interface_list_member` tool — add/remove interfaces from interface lists
- `list_ppp_profiles` tool — list PPP profiles including built-in defaults
- `manage_ppp_profile` tool — add/update/remove PPP profiles

### Fixed
- `fetch_url` — RouterOS requires `http-method` in lowercase; uppercase values (`GET`/`POST`) were rejected with HTTP 400
- `fetch_url` — added `output=user` for inline body response; fixed file-save mode to use `output=file` + `dst-path` (was incorrectly setting `output=<filepath>`)
- `fetch_url` — RouterOS `/tool/fetch` returns a streaming array of progress sections; handler now finds the `finished` section and reads `code` (HTTP status) and `data` (body) from it

---

## [1.4.0] - 2026-05-24

### Added
- `list_user_groups` — list local user groups with policy bitmask (`/user/group`)
- `manage_user_group` — create, update, or remove user groups; idempotent by name; update action changes the policy string
- `get_upgrade_status` — check RouterOS and routerboard firmware upgrade availability and current channel
- `manage_upgrade` — trigger a package update check (`action=check`) or install an upgrade (`action=install`, destructive, reboots)
- `create_backup` — create a binary router config backup file with optional encryption password
- `export_config` — export running config as a RouterOS script text (`/export`); compact mode supported; optionally save to router file
- `list_log_rules` — list system logging rules with topic substring and action name filters
- `manage_log_rule` — add, remove, enable, or disable log rules; idempotent by topics+action composite key
- `list_log_actions` — list log action targets (memory, disk, remote syslog, etc.) with type filter
- `manage_log_action` — add or remove log action targets; idempotent by name; type required for add
- `manage_ntp_client` — configure NTP client: enable/disable, set servers, mode, and VLAN source interface; complements `get_ntp_settings`

---

## [1.3.0] - 2026-05-24

### Added
- `list_pppoe_clients` — list PPPoE client interfaces with connection state; filters by parent interface and status (connected/disconnected/all); supports pagination
- `manage_pppoe_client` — add, update, or remove PPPoE client interfaces (idempotent by name+interface+user for add; no_change guard on update; password always written when provided since RouterOS does not expose it in GET)
- `list_ovpn_clients` — list OpenVPN client interfaces with connection state and remote endpoint; supports pagination
- `manage_ovpn_client` — add, update, or remove OpenVPN client interfaces (idempotent by name+connectTo for add; no_change guard on update; certificate and credential references)
- `get_ovpn_server` — read OpenVPN server configuration (port, mode, protocol, certificate, cipher, auth, enabled state)
- `manage_ovpn_server` — enable/disable the OpenVPN server or update its configuration (port, mode, protocol, certificate, cipher, auth); enable/disable are idempotent; set returns no_change when all fields already match

---

## [1.2.0] - 2026-05-23

### Added
- `manage_vlan` — add, remove, enable, or disable VLAN interfaces (idempotent by name; supersedes `create_vlan`)
- `list_ip_pools`, `manage_ip_pool` — IP address pool tools (renamed from `list_dhcp_pools`/`manage_dhcp_pool`; pools serve any subsystem, not only DHCP)
- `manage_dhcp_lease` — convert dynamic DHCP leases to static or remove leases (idempotent by MAC address; make-static is a no-op when lease is already static)
- `list_dhcp_clients`, `manage_dhcp_client` — DHCP client configuration per interface (which interfaces obtain IP via DHCP)
- `list_ip_services`, `manage_ip_service` — view and enable/disable RouterOS IP services (api, api-ssl, ssh, telnet, www, www-ssl, winbox, ftp; port changes excluded to prevent lockout)

### Changed
- `list_dhcp_leases` gains `leaseType` filter (`dynamic`, `static`, `all`) to distinguish lease types
- `list_dhcp_servers` gains `offset` parameter for consistent pagination across all list tools

### Removed
- `create_vlan` — replaced by `manage_vlan` which covers the full interface lifecycle
- `list_dhcp_pools`, `manage_dhcp_pool` — renamed to `list_ip_pools`, `manage_ip_pool`

---

## [1.1.0] - 2026-05-22

### Added
- `GET /healthz` endpoint on the HTTP transport for container liveness/readiness probes (unauthenticated, not rate-limited).
- `GET /metrics` Prometheus endpoint exposing per-tool call counters (`mikromcp_tool_calls_total`).
- `bulk_execute` can now fan out destructive tools when given a fleet confirmation token (two-step HMAC flow; requires `MIKROMCP_CONFIRMATION_SECRET`).
- `MIKROMCP_SNAPSHOT_RETENTION_DAYS` (default 30) — config snapshots older than this are pruned at server startup.
- Expanded snapshot semantic keys so `rollback_change` produces in-place updates (instead of delete-then-create) for certificates, files, VRRP, DHCP servers, IPSec peers, IP pools, simple queues, netwatch entries, and users.

### Changed
- Server version is derived from `package.json` (generated `src/version.ts`) instead of a hardcoded string.
- Snapshot, write-journal, and audit-log file writes are now asynchronous (non-blocking).

### Fixed
- Read tools now retry on transient HTTP 5xx / timeout / busy responses (the retry engine previously honoured only raw network errors).
- Circuit breaker half-open state now admits a single recovery probe at a time.
- `apply_plan` records real per-step duration in the write journal, and its sub-steps now run through the per-router circuit breaker so a plan fails fast against a router known to be down.
- Audit log and write journal now redact VPN/crypto secrets (WireGuard private keys, IPSec PSK, SNMP community strings).
- `MIKROMCP_AUDIT_LOG_PATH` set via `~/.mikromcp/.env` now activates the audit file sink (it was read before dotenv loaded and silently ignored).
- HTTP rate-limiter no longer leaks memory — stale per-IP windows are swept periodically.
- The pooled RouterOS REST client is now evicted after a router authentication failure.
- `bulk_execute` fleet operations are now written to the audit log (previously produced no audit trail).
- `mikromcp init` now writes empty `allowedRouters`/`allowedToolPatterns` (the documented "all" sentinel) instead of `["*"]`, which silently denied access to every router.

### Removed
- Unused `pagination` configuration block.

---

## [1.0.10] - 2026-05-20

### Fixed
- MCP Registry name casing corrected to `io.github.AliKarami/mikromcp` (was lowercase, causing 403 on publish).
- MCP Registry description trimmed to satisfy 100-character validation limit.

---

## [1.0.9] - 2026-05-20

### Added
- MCP Registry metadata and GitHub Actions publishing via `mcp-publisher` OIDC.

### Changed
- Add npm `mcpName` ownership marker for `io.github.alikarami/mikromcp`.

---

## [1.0.8] - 2026-05-20

### Fixed
- Suppress dotenv v17 stdout output in stdio transport (dotenv 17 writes to stdout on load, which corrupted the JSON-RPC stream)

---

## [1.0.7] - 2026-05-20

### Fixed
- `mikromcp init`: default router port to 80, set `rejectUnauthorized: false`, quote YAML string values to prevent parse errors

---

## [1.0.6] - 2026-05-20

### Fixed
- `mikromcp init`: overwrite `.env` instead of appending when re-running; warn upfront if config files already exist

---

## [1.0.5] - 2026-05-20

### Added
- `mikromcp update` CLI command — self-updates the installed package via npm

---

## [1.0.4] - 2026-05-20

### Fixed
- `mikromcp init`: add transport selection prompt; collect and write router credentials to `.env`

### Changed
- README quick-start rewritten for the `npm install / init / doctor` workflow

---

## [1.0.3] - 2026-05-20

### Fixed
- Default all config paths to `~/.mikromcp/` for consistent behaviour across install methods

---

## [1.0.2] - 2026-05-20

### Fixed
- Remove unused `platform` import and stray `data` parameter; add `lint` + `typecheck` to `npm test`

---

## [1.0.1] - 2026-05-20

### Fixed
- Bundle all dependencies for pkg binary and stub `node:sqlite`; use separate tsup config for pkg binaries to avoid native-addon conflicts
- Normalize `repository.url` to `git+https` format for npm provenance

---

## [1.0.0] - 2026-05-20

Initial stable release.

### Added
- 60+ RouterOS management tools across: system, interfaces, IP, DHCP, DNS, routing, firewall, IPSec, WireGuard, WiFi, VLANs, certificates, users, files, containers, queues, scripts, scheduler, and diagnostics
- stdio and HTTP/SSE transports
- Per-router circuit breaker and retry engine
- Role-based access control via `config/identities.yaml`
- HMAC confirmation tokens for destructive operations
- NDJSON audit log
- `mikromcp init` and `mikromcp doctor` CLI commands
- Docker image and pre-built binaries via CI release pipeline
