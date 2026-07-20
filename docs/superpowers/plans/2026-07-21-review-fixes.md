# Deep-Review Bug Fixes & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all confirmed bugs and design-level gaps found in the 2026-07-21 deep review (boolean-parse mismatch, TLS pinning no-op, maintenance windows, command-guard bypasses, bulk_execute gaps, SSH timeout, UTF-8 corruption, rollback-engine fragility, tool annotations, doc drift, stateless confirmation, authz glob, HTTP hygiene, pool rotation, numeric precision, output caps, fleet-context nulls, write-retry hints, SFTP upload).

**Architecture:** All fixes are surgical changes inside the existing layering (adapter → domain → mcp → middleware). No new subsystems; two small new modules (`src/util/glob.ts`, `src/adapter/sftp-client.ts`). One branch `fix/deep-review-hardening`, one conventional commit per task, squash-merged as one PR per repo policy.

**Tech Stack:** TypeScript strict ESM, zod, undici, ssh2, basic-ftp, vitest.

## Global Constraints

- All imports use `.js` extensions (ESM), even for `.ts` sources.
- Zod schemas stay `.strict()`.
- No `any`; use `as unknown as T` when needed.
- No comments explaining WHAT; only non-obvious WHY.
- Run `npm test` (vitest) + `npm run typecheck` + `npm run lint` after each task.
- Every user-facing change adds a line to `CHANGELOG.md` `[Unreleased]` in the task's own commit.
- Tool annotation/description changes update `docs/wiki/Available-Tools.md` in the same commit (lockstep tests enforce name sync).
- Do NOT push or open a PR without the user asking.

---

### Task 1: Boolean/number parse mismatch (`=== "true"` bug class)

**Files:**
- Modify: `src/adapter/response-parser.ts` (add `isTrue`, guard big ints)
- Modify: `src/types.ts` (`RouterOSRecord` value type)
- Modify: `src/domain/tools/scheduler-tools.ts:252`, `src/domain/tools/firewall-tools.ts:103,418`, `src/domain/tools/mangle-tools.ts:308`, `src/domain/tools/policy-routing-tools.ts:248`, `src/domain/tools/packages-tools.ts:116`, `src/domain/tools/ip-tools.ts:95`, plus every `=== true || === "true"` site to use `isTrue`
- Modify: `CLAUDE.md` (fix the `=== "true"` guidance)
- Test: `test/unit/adapter/response-parser.test.ts`, `test/unit/domain/tools/scheduler-tools.test.ts` (and siblings)

**Interfaces:**
- Produces: `export function isTrue(v: unknown): boolean` from `src/adapter/response-parser.ts` — true for `true`, `"true"`, `"yes"`; false otherwise. Also `export type RouterOSValue = string | number | boolean` from `src/types.ts`.

- [ ] **Step 1: Failing tests** — in `response-parser.test.ts` add:

```ts
import { isTrue, parseRouterOSValue } from "../../../src/adapter/response-parser.js";

describe("isTrue", () => {
  it("accepts parsed booleans and raw strings", () => {
    expect(isTrue(true)).toBe(true);
    expect(isTrue("true")).toBe(true);
    expect(isTrue("yes")).toBe(true);
    expect(isTrue(false)).toBe(false);
    expect(isTrue("false")).toBe(false);
    expect(isTrue(undefined)).toBe(false);
  });
});
```

In `scheduler-tools.test.ts` (mirror for the other five tools): feed the handler a mock whose `get` resolves **parsed** records (`disabled: true` boolean, as production produces) and assert `enable` on a disabled job performs the update instead of returning `no_change`.

- [ ] **Step 2: Implement** — in `response-parser.ts`:

```ts
export function isTrue(v: unknown): boolean {
  return v === true || v === "true" || v === "yes";
}
```

In `types.ts`:

```ts
export type RouterOSValue = string | number | boolean;
export interface RouterOSRecord {
  ".id": string;
  [key: string]: RouterOSValue;
}
```

Replace all boolean comparisons on record fields with `isTrue(rec.disabled)` etc. (`ip-tools.ts:95` becomes `isTrue(rec.disabled) === parsed.disabled`; `firewall-tools.ts:103` compares `isTrue(rec.disabled) === isTrue(parsed.disabled)`). Run `npm run typecheck` and fix union-type fallout at the listed sites (mostly `String(v)` or `isTrue(v)`); `as Record<string, string>` casts elsewhere are unaffected.

- [ ] **Step 3: Fix CLAUDE.md** — replace the "always compare with `=== "true"`" paragraph with: parsed records hold real booleans/numbers; compare with `isTrue()` from `response-parser.ts`.

- [ ] **Step 4: Verify** — `npm test && npm run typecheck && npm run lint` all green.

- [ ] **Step 5: Commit** — `fix: boolean-parsed record fields broke enable/disable idempotency checks`

---

### Task 2: Enforce TLS fingerprint pinning

**Files:**
- Modify: `src/adapter/tls-manager.ts`
- Test: `test/unit/adapter/tls-manager.test.ts`

**Interfaces:**
- Produces: `export function makePinnedConnector(inner: buildConnector.connector, expectedFingerprint: string): buildConnector.connector` (exported for tests); `buildAgentOptions` unchanged signature.

- [ ] **Step 1: Failing test** — stub inner connector that yields a fake socket with `getPeerCertificate(): { fingerprint256 }`; assert wrong fingerprint destroys socket + errors callback, right fingerprint passes socket through.

```ts
import { makePinnedConnector } from "../../../src/adapter/tls-manager.js";

function fakeSocket(fp: string) {
  return {
    destroyed: false,
    destroy() { this.destroyed = true; },
    getPeerCertificate: () => ({ fingerprint256: fp }),
  };
}

it("rejects and destroys the socket on fingerprint mismatch", async () => {
  const sock = fakeSocket("AA:BB");
  const inner = ((_o: unknown, cb: (e: Error | null, s: unknown) => void) => cb(null, sock)) as never;
  const pinned = makePinnedConnector(inner, "cc:dd");
  await new Promise<void>((resolve) => {
    pinned({} as never, (err, s) => {
      expect(err?.message).toMatch(/fingerprint mismatch/i);
      expect(s).toBeNull();
      expect(sock.destroyed).toBe(true);
      resolve();
    });
  });
});

it("passes the socket through on fingerprint match", async () => { /* mirror with aa:bb vs AA:BB */ });
```

- [ ] **Step 2: Implement** — in `tls-manager.ts`, when `tls.fingerprint` is set, stop relying on `checkServerIdentity` (ignored under `rejectUnauthorized:false`); wrap `undici.buildConnector`:

```ts
import { buildConnector } from "undici";
import type { TLSSocket } from "node:tls";

export function makePinnedConnector(
  inner: buildConnector.connector,
  expectedFingerprint: string,
): buildConnector.connector {
  const expected = expectedFingerprint.replace(/:/g, "").toLowerCase();
  return (opts, cb) => {
    inner(opts, (err, socket) => {
      if (err || !socket) {
        cb(err ?? new Error("TLS connection failed"), null);
        return;
      }
      const cert = (socket as TLSSocket).getPeerCertificate();
      const actual = (cert?.fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
      if (actual !== expected) {
        socket.destroy();
        cb(new Error(`TLS certificate fingerprint mismatch. Expected: ${expected}, got: ${actual || "none"}`), null);
        return;
      }
      cb(null, socket);
    });
  };
}
```

`buildAgentOptions`: when fingerprint set, return `{ connect: makePinnedConnector(buildConnector({ ...connectOptions }), tls.fingerprint) }`; keep the old plain path (ca/rejectUnauthorized) otherwise. Remove the dead `checkServerIdentity` block.

- [ ] **Step 3: Verify + commit** — `fix(security): enforce TLS fingerprint pinning (was a no-op under rejectUnauthorized:false)`

---

### Task 3: Overnight maintenance windows

**Files:**
- Modify: `src/config/maintenance-window.ts`
- Test: `test/unit/config/maintenance-window.test.ts`

- [ ] **Step 1: Failing tests** — window `{days:["Tue"], startTime:"22:00", endTime:"02:00", timezone:"UTC"}`: Tue 23:00 → true; Wed 01:00 → true (spillover from Tue start); Wed 03:00 → false; Tue 21:00 → false; Tue 02:00 exactly with days ["Mon"] → true (Mon 22:00 start wraps into Tue).

- [ ] **Step 2: Implement** — semantics: `days` names the day the window *starts*. For `start > end`, match if (today ∈ days && time >= start) OR (yesterday ∈ days && time <= end):

```ts
const DAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
// inside windows.some((w) => { ...existing parts extraction... })
const dayIdx = DAY_ORDER.indexOf(day);
const prevDay = DAY_ORDER[(dayIdx + 6) % 7];
if (w.startTime === w.endTime) return false;
if (w.startTime < w.endTime) {
  return w.days.includes(day) && currentTime >= w.startTime && currentTime <= w.endTime;
}
return (
  (w.days.includes(day) && currentTime >= w.startTime) ||
  (w.days.includes(prevDay) && currentTime <= w.endTime)
);
```

- [ ] **Step 3: Verify + docs + commit** — note overnight support in `docs/wiki/Configuration.md` maintenance-window section; `fix: maintenance windows spanning midnight never matched`

---

### Task 4: UTF-8 chunk-boundary corruption (HTTP body + SSH output)

**Files:**
- Modify: `src/mcp/transports/http.ts` (`readBody`), `src/adapter/ssh-client.ts` (`appendOutput`)
- Test: `test/unit/transports/http.test.ts`, `test/unit/adapter/ssh-client.test.ts`

- [ ] **Step 1: Failing test** — push `Buffer.from("…")` (3-byte U+2026) split across two chunks through a `PassThrough` into `readBody`; expect parsed JSON string to contain `…` not `�`.

- [ ] **Step 2: Implement** — `readBody`: accumulate `chunks: Buffer[]`, count `size += chunk.length`, and on `end` do `Buffer.concat(chunks).toString("utf-8")` then `JSON.parse`. `ssh-client`: accumulate `Buffer[]` (slice the final chunk at the byte cap), decode once in `cleanup` — truncation marker unchanged.

- [ ] **Step 3: Verify + commit** — `fix: decode request/SSH output buffers once to avoid UTF-8 chunk corruption`

---

### Task 5: Command-guard hardening

**Files:**
- Modify: `src/domain/tools/command-guard.ts`
- Test: `test/unit/domain/tools/command-guard.test.ts`

**Interfaces:**
- Produces: `export function normalizeCommand(raw: string): string` (exported for tests); `checkCommand(command, policy)` signature unchanged but now checks each `;`/newline-separated segment against deny patterns.

- [ ] **Step 1: Failing tests** — all of these must throw `COMMAND_DENIED` with the default policy: `/system/reboot`, `system reboot`, `/system   reboot`, `/SYSTEM REBOOT`, `:put 1; /system reboot`, `:execute "/system reboot"`, `/execute` inline scripts. Legit commands still pass: `/interface print`, `/ip/address/print`, `/ip firewall filter print where comment~"a;b"` is acceptable-to-deny (document: `;` splits are checked segment-wise, fail-safe).

- [ ] **Step 2: Implement**:

```ts
export function normalizeCommand(raw: string): string {
  let cmd = raw.trim().replace(/\s+/g, " ");
  // ROS7 slash-path syntax: "/system/reboot x" -> "/system reboot x"
  const m = /^\/?([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+)(?=\s|$)/i.exec(cmd);
  if (m) cmd = "/" + m[1].split("/").join(" ") + cmd.slice(m[0].length);
  if (!cmd.startsWith("/") && !cmd.startsWith(":")) cmd = "/" + cmd;
  return cmd;
}
```

`checkCommand`: split the raw command on `/[;\n]/`, normalize each non-empty segment, and run every segment through the deny loop (allow-list check stays against the full normalized command). Add built-in deny patterns: `*:execute*` and `:execute*`. Extend `BUILTIN_DENY_PATTERNS` docstring: this is defense-in-depth, not a security boundary (scripts/scheduler can still run anything — they are confirmation-gated instead, see Task 9).

- [ ] **Step 3: Verify + commit** — `fix(security): normalize ROS7 syntax and check chained segments in run_command guard`

---

### Task 6: bulk_execute — ALL-tags semantics + full safety stack

**Files:**
- Modify: `src/mcp/tool-executor.ts` (extract helpers), `src/domain/tools/fleet-tools.ts`, `src/domain/tools/tool-definition.ts` (context gets `circuitBreakers`)
- Test: `test/unit/domain/tools/fleet-tools.test.ts`

**Interfaces:**
- Produces from `tool-executor.ts`:
  - `export function getOrCreateBreaker(map: Map<string, CircuitBreaker>, routerId: string, config: AppConfig): CircuitBreaker`
  - `export function assertMaintenanceWindow(tool: ToolDefinition, routerConfig: RouterConfig, routerId: string): void` (throws the existing `OUTSIDE_MAINTENANCE_WINDOW` error)
- `ToolContext` gains `circuitBreakers?: Map<string, CircuitBreaker>`; executor passes it into the fleet context.

- [ ] **Step 1: Failing tests** — (a) `tags: ["edge","prod"]` targets only routers having **both** tags; (b) fanning out a destructive tool to a router whose maintenance window excludes now yields a per-router `error` result mentioning maintenance; (c) an open circuit breaker for one router yields `CIRCUIT_OPEN` for that router without calling the handler; (d) read-only tools are retried per `config.retry` (spy on a handler failing once with a retryable `MikroMCPError`, expect 2 calls).

- [ ] **Step 2: Implement** — in `fleet-tools.ts` `runForRouter`, after `checkAuthz`:

```ts
if (targetTool.annotations.destructiveHint) {
  const windows = router.maintenanceWindows;
  if (windows && windows.length > 0 && !isWithinMaintenanceWindow(windows, new Date())) {
    throw new MikroMCPError({ /* same OUTSIDE_MAINTENANCE_WINDOW shape via assertMaintenanceWindow */ });
  }
}
const cb = getOrCreateBreaker(context.circuitBreakers!, router.id, context.appConfig);
const run = () => targetTool.handler(toolParams as Record<string, unknown>, routerContext);
const result = await cb.execute(
  targetTool.annotations.readOnlyHint ? () => withRetry(run, context.appConfig.retry) : run,
);
```

Tag targeting: `routers = context.routerRegistry!.listRouters().filter((r) => parsed.tags!.every((t) => r.tags.includes(t)));` — schema description already says ALL; leave `list_routers` (documented ANY) untouched. In `tool-executor.ts`, factor the existing breaker-creation and maintenance-window blocks into the two exported helpers and use them in both paths.

- [ ] **Step 3: Verify + docs + commit** — Available-Tools bulk_execute entry documents ALL-tags + safety stack. `fix: bulk_execute honors ALL-tag targeting, maintenance windows, breakers, and read retries`

---

### Task 7: SSH timeout must fail loudly

**Files:**
- Modify: `src/adapter/ssh-client.ts`
- Test: `test/unit/adapter/ssh-client.test.ts`

- [ ] **Step 1: Failing test** — with mocked `ssh2` stream that never closes until `close()` is called, expect `execute` to reject with an error whose `code === "ETIMEDOUT"` and whose message includes the timeout and partial output length.

- [ ] **Step 2: Implement** — timer callback sets `timedOut = true` before `stream.close()`; `cleanup` path:

```ts
timer = setTimeout(() => {
  timedOut = true;
  stream.close();
}, timeoutMs);
// in stream.on("close"):
if (timedOut) {
  const err = new Error(
    `SSH command timed out after ${timeoutMs}ms (${output.length} bytes of partial output discarded)`,
  ) as NodeJS.ErrnoException;
  err.code = "ETIMEDOUT";
  cleanup(err);
} else {
  cleanup();
}
```

(`ETIMEDOUT` maps to `ROUTER_UNREACHABLE`/retryable via the enricher; Task 18 adds the write-verify hint.)

- [ ] **Step 3: Verify + commit** — `fix: SSH command timeouts now reject instead of returning partial output as success`

---

### Task 8: Rollback/diff engine hardening

**Files:**
- Modify: `src/domain/snapshot/diff-engine.ts`, `src/domain/snapshot/snapshot-engine.ts`, `src/domain/tools/change-management-tools.ts`
- Test: `test/unit/domain/snapshot/diff-engine.test.ts`

**Interfaces:**
- Produces from `diff-engine.ts`:
  - `export function normalizeForDiff(records: RouterOSRecord[]): RouterOSRecord[]` — drops records where `isTrue(r.dynamic)`; strips `RUNTIME_FIELDS`.
  - `export const RUNTIME_FIELDS: ReadonlySet<string>` = `bytes, packets, dynamic, invalid, dead, expired, about, .about, creation-time, last-logged-in, last-link-up-time, last-link-down-time, link-downs, running`.
  - `RestorePlan` gains `warnings: string[]`.
  - `export const ORDER_SENSITIVE_PATHS: ReadonlySet<string>` = `ip/firewall/filter, ip/firewall/nat, ip/firewall/mangle, routing/rule`.

- [ ] **Step 1: Failing tests** —
  (a) records differing only in `bytes`/`packets` produce an empty plan;
  (b) `dynamic: true` records are ignored on both sides (no toRemove/toCreate);
  (c) two uncommented firewall rules (colliding semantic key `""`) fall back to signature diff — both survive, no spurious removal;
  (d) plan for `ip/firewall/filter` carries a warning about rule order;
  (e) plan for `user` never emits `toCreate` (warning instead).

- [ ] **Step 2: Implement** — `takeSnapshot` stores `normalizeForDiff(records)`. `computeRestorePlan` normalizes `before` and `current` first; if the chosen semantic keys produce duplicates within either side, fall back to the signature-based branch; append warnings:

```ts
const warnings: string[] = [];
if (ORDER_SENSITIVE_PATHS.has(path)) {
  warnings.push(`Restored entries for ${path} are appended at the end — rule ORDER is not restored; review manually.`);
}
if (path === "user") {
  if (toCreate.length > 0) warnings.push(`Refusing to recreate ${toCreate.length} deleted user(s): passwords are not in snapshots and recreation would produce password-less logins. Recreate manually with manage_user.`);
  toCreate.length = 0;
}
```

`rollback_change` surfaces `plan.warnings` in both dry-run and applied `content`/`structuredContent`.

- [ ] **Step 3: Verify + docs + commit** — Available-Tools rollback_change entry mentions order warning + user restriction. `fix: rollback plans ignore runtime fields/dynamic records, survive key collisions, warn on order-sensitive paths, never recreate users`

---

### Task 9: Tool annotation audit

**Files:**
- Modify: annotations in `network-test-tools.ts` (fetch_url, bandwidth_test), `backup-tools.ts` (export_config), and destructiveHint→true in: `user-tools.ts` (manage_user), `user-group-tools.ts` (manage_user_group), `scripts-tools.ts` (manage_script, run_script), `container-tools.ts` (manage_container), `vrrp-tools.ts` (manage_vrrp_instance), `mangle-tools.ts` (manage_mangle_rule), `ipsec-tools.ts` (manage_ipsec_policy), `dhcp-server-tools.ts` (manage_dhcp_server), `wifi-tools.ts` (manage_wifi_interface), `packages-tools.ts` (manage_package), `policy-routing-tools.ts` (manage_routing_rule, manage_routing_table), `dns-tools.ts` (manage_dns_settings), `interface-list-tools.ts` (manage_interface_list, manage_interface_list_member), `address-list-tools.ts` (manage_address_list_entry), `wireguard-tools.ts` (manage_wireguard_interface)
- Modify: `src/domain/tools/tool-definition.ts` + `src/mcp/tool-executor.ts` (add `retryable?: false` override)
- Modify: `docs/wiki/Available-Tools.md` (Read/Write/Destructive tags), `CHANGELOG.md`
- Test: `test/unit/domain/tools/annotations.test.ts` (new — asserts the rubric matrix), `test/unit/mcp/tool-registry-retry.test.ts`

**Rubric (record in Available-Tools intro):** destructive = removes resources, changes authentication/authorization surface, or can sever connectivity or running services.

- [ ] **Step 1: Failing test** — new `annotations.test.ts` with the full expected matrix (tool name → {readOnly, destructive}) for every tool in `allTools`; plus a retry test asserting `retryable: false` tools are not retried.

- [ ] **Step 2: Implement** —
  - `fetch_url`: `readOnlyHint: false, openWorldHint: true` (POSTs re-sent by auto-retry; can write router files).
  - `bandwidth_test`: keep `readOnlyHint: true` but add `retryable: false`; `openWorldHint: true`; reduce `duration` max 30 → 20 (collides with the 30s HTTP client timeout).
  - `export_config`: `readOnlyHint: false` (file mode writes to the router).
  - Flip `destructiveHint: true` on the tools listed in **Files**.
  - `ToolDefinition` gains `retryable?: boolean`; executor: `tool.annotations.readOnlyHint && tool.retryable !== false ? withRetry(...) : run`.

- [ ] **Step 3: Verify + docs + commit** — update every affected Available-Tools entry tag + parameter change (`bandwidth_test` duration max). `fix: correct tool risk annotations (destructive/write/open-world) and exempt bandwidth_test from auto-retry`

---

### Task 10: Documentation drift

**Files:**
- Modify: `CLAUDE.md` (env-var defaults `~/.mikromcp/routers.yaml`, `~/.mikromcp/identities.yaml`; confirmation-secret wording "required in HTTP mode when readonly/operator identities exist"), `README.md` (same defaults if listed), `docs/wiki/Architecture.md:127`
- Test: none (docs)

- [ ] **Step 1: Apply the three corrections; grep for `config/routers.yaml` to catch stragglers** (leave Connecting-to-AI-Assistants examples that intentionally use explicit paths).
- [ ] **Step 2: Commit** — `docs: fix config-path defaults and confirmation-secret wording`

---

### Task 11: Self-verifying confirmation tokens (single + fleet)

**Files:**
- Modify: `src/middleware/confirmation.ts`, `src/middleware/fleet-confirmation.ts`
- Test: `test/unit/middleware/confirmation.test.ts`, `test/unit/middleware/fleet-confirmation.test.ts`

**Interfaces:**
- Token format: `"<expiresAtMs>.<hmacHex>"` where `hmacHex = HMAC-SHA256(secret, `${tool}|${routerId}|${identityId}|${paramHash}|${expiresAtMs}`)` (fleet: `${fingerprint}|${expiresAtMs}`). Verification recomputes from the **current** call — no pending map needed for validity. A small in-memory `usedTokens: Map<string, number>` (token → expiresAtMs, swept on access) provides single-instance replay protection; document multi-instance replay as a known limitation.

- [ ] **Step 1: Failing tests** — issue token (catch APPROVAL_REQUIRED), resubmit identical call + token → passes; resubmit with changed params → CONFIRMATION_MISMATCH; expired (fake timers) → CONFIRMATION_EXPIRED; reuse after success → rejected; **token survives "restart"** (clear internal state via exported `_resetForTests()`, replay-cache only — verify still passes).

- [ ] **Step 2: Implement** —

```ts
function sign(parts: string[], expiresAtMs: number, secret: string): string {
  const mac = createHmac("sha256", secret).update([...parts, String(expiresAtMs)].join("|")).digest("hex");
  return `${expiresAtMs}.${mac}`;
}
// verify: split on ".", check Number(expiresAtMs) > Date.now(),
// timingSafeEqual(recomputed mac, submitted mac), then usedTokens replay check + insert.
```

Keep error codes/messages and the admin/superadmin bypass unchanged. Same scheme in fleet-confirmation over the existing fingerprint.

- [ ] **Step 3: Verify + commit** — `fix: confirmation tokens are self-verifying (survive restarts, HMAC actually enforced)`

---

### Task 12: Real glob matching in authz

**Files:**
- Create: `src/util/glob.ts` (move `globMatch` from command-guard; export)
- Modify: `src/middleware/authz.ts`, `src/domain/tools/command-guard.ts` (import from util)
- Test: `test/unit/middleware/authz.test.ts`

- [ ] **Step 1: Failing tests** — pattern `*_wifi` allows `manage_wifi`? No: allows only names ending `_wifi` (e.g. denies `manage_user`); `list_*` allows `list_users`, denies `manage_user`; exact names still exact.
- [ ] **Step 2: Implement** — `src/util/glob.ts`:

```ts
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}
```

`authz.checkAuthz` uses it; command-guard imports it (delete its local copy).

- [ ] **Step 3: Verify + commit** — `fix(security): allowedToolPatterns uses full glob matching (leading * no longer allows everything)`

---

### Task 13: HTTP transport hygiene

**Files:**
- Modify: `src/mcp/transports/http.ts`, `src/config/app-config.ts`, `src/config/identity-registry.ts`
- Test: `test/unit/transports/http.test.ts`, `test/unit/config/app-config.test.ts`, `test/unit/config/identity-registry.test.ts`

- [ ] **Step 1: Failing tests** —
  (a) `loadAppConfig` with `MIKROMCP_PORT=abc` throws a CONFIGURATION error naming the variable;
  (b) 401 responses carry `WWW-Authenticate: Bearer`;
  (c) a session created by identity A returns 403 when identity B posts to it;
  (d) sessions idle past the TTL are closed and evicted by the sweep;
  (e) `/metrics` returns 401 without a token when identities are configured, 200 with a valid one (and stays open when the registry is empty);
  (f) `findIdentityByToken` caches: two calls with the same token invoke `bcrypt.compare` once (spy).

- [ ] **Step 2: Implement** —
  - `app-config.ts`: `function intEnv(name: string, fallback: number): number` that throws `MikroMCPError CONFIGURATION` on NaN; use for port/body/rate/ssh/retention values.
  - 401 handler adds `"WWW-Authenticate": "Bearer"` header.
  - `streamableSessions` values become `{ transport, identityId, lastSeenMs }`; on reuse check identity, update `lastSeenMs`; sweep timer (reuse the rate-limit interval) closes transports with `now - lastSeenMs > 30 * 60_000`.
  - `/metrics`: run `authenticateHttp` first when `identityRegistry.getIdentities().length > 0`.
  - `identity-registry.ts`: private `tokenCache = new Map<string, Identity>()` keyed by `sha256(token)`; check before bcrypt loop, set after match.

- [ ] **Step 3: Verify + docs + commit** — document session TTL + authenticated /metrics in `docs/wiki/Architecture.md`. `fix: HTTP hygiene — env validation, WWW-Authenticate, session identity binding + TTL, authed /metrics, bcrypt cache`

---

### Task 14: Connection pool credential rotation

**Files:**
- Modify: `src/adapter/connection-pool.ts`
- Test: `test/unit/adapter/connection-pool.test.ts`

- [ ] **Step 1: Failing test** — `getClient(cfg, {user,pass1})` then `getClient(cfg, {user,pass2})` returns a **different** client and closes the first; same credentials → same instance.
- [ ] **Step 2: Implement** — store `{ client, credHash }` per router id; `credHash = createHash("sha256").update(`${username}\0${password}`).digest("hex")`; on mismatch, `client.close()` and rebuild. `healthCheck`/`removeClient`/`closeAll` unchanged shape.
- [ ] **Step 3: Verify + commit** — `fix: connection pool rebuilds clients when credentials rotate`

---

### Task 15: Numeric precision guard in parser

**Files:**
- Modify: `src/adapter/response-parser.ts`
- Test: `test/unit/adapter/response-parser.test.ts`

- [ ] **Step 1: Failing tests** — `"12345678901234567890"` stays a string; `"9007199254740993"` (2^53+1) stays a string; `"42"` → 42; `"3.14"` → 3.14.
- [ ] **Step 2: Implement** — for integer matches, `Number.isSafeInteger(num)` required to convert; decimals keep the existing `isFinite` check.
- [ ] **Step 3: Verify + commit** — `fix: keep 64-bit counters as strings to avoid precision loss`

---

### Task 16: Output caps for unbounded reads

**Files:**
- Modify: `src/domain/tools/files-tools.ts` (get_file_content), `src/domain/tools/network-test-tools.ts` (list_connections proplist)
- Test: `test/unit/domain/tools/files-tools.test.ts`

- [ ] **Step 1: Failing test** — file with 100KB contents returns capped 64KB + `[TRUNCATED at 65536 chars — file is N chars]` marker in both `content` and `structuredContent.truncated: true`.
- [ ] **Step 2: Implement** — `const CONTENT_CAP = 65536;` slice + marker. `list_connections`: pass `proplist: ["protocol","src-address","dst-address","tcp-state","connection-mark","timeout"]` to shrink the conntrack payload.
- [ ] **Step 3: Verify + docs + commit** — Available-Tools notes the cap. `fix: cap get_file_content output and trim list_connections payload`

---

### Task 17: Fleet context throws clearly instead of null-cast crash

**Files:**
- Modify: `src/mcp/tool-executor.ts`
- Test: `test/unit/mcp/tool-executor.test.ts`

- [ ] **Step 1: Failing test** — a `skipRouterContext` tool whose handler touches `context.routerClient.get` receives a `MikroMCPError` INTERNAL with message naming the missing capability, not a TypeError.
- [ ] **Step 2: Implement**:

```ts
function fleetUnavailable<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get() {
      throw new MikroMCPError({
        category: ErrorCategory.INTERNAL,
        code: "FLEET_CONTEXT_UNAVAILABLE",
        message: `${what} is not available in a fleet-tool context (skipRouterContext).`,
        recoverability: { retryable: false, suggestedAction: "Target a specific router instead." },
      });
    },
  });
}
```

Use for `routerClient`, `routerConfig`, `sshClient`, `ftpClient` in the fleet context.

- [ ] **Step 3: Verify + commit** — `fix: fleet tool context raises a typed error instead of crashing on router-scoped access`

---

### Task 18: Write-timeout errors advise state verification

**Files:**
- Modify: `src/mcp/tool-executor.ts`
- Test: `test/unit/mcp/tool-executor.test.ts`

- [ ] **Step 1: Failing test** — a write tool (readOnlyHint:false) whose handler rejects with `ETIMEDOUT` returns an error whose `suggestedAction` starts with "The write may already have been applied".
- [ ] **Step 2: Implement** — in the executor catch, after enrichment:

```ts
const AMBIGUOUS = new Set([ErrorCategory.ROUTER_TIMEOUT, ErrorCategory.ROUTER_UNREACHABLE]);
if (!tool.annotations.readOnlyHint && AMBIGUOUS.has(error.category)) {
  error.recoverability.suggestedAction =
    "The write may already have been applied — verify router state (list tool or get_log) before retrying. " +
    error.recoverability.suggestedAction;
}
```

(If `recoverability` is readonly on the class, rebuild the error with the amended field.)

- [ ] **Step 3: Verify + commit** — `fix: ambiguous write failures tell the caller to verify state before retrying`

---

### Task 19: SFTP upload (FTP fallback)

**Files:**
- Create: `src/adapter/sftp-client.ts`
- Modify: `src/adapter/adapter-factory.ts`, `src/domain/tools/tool-definition.ts` (context gains `sftpClient`), `src/mcp/tool-context.ts`, `src/domain/tools/files-tools.ts` (upload_file)
- Test: `test/unit/adapter/sftp-client.test.ts`, `test/unit/domain/tools/files-tools.test.ts`

**Interfaces:**
- Produces: `class SftpClient { constructor(config: RouterConfig, credentials: {username; password}); upload(remoteName: string, content: string): Promise<void> }` — ssh2 `conn.sftp()` + `writeFile`, honoring `sshPort`/`sshFingerprint` like `SshClient`.

- [ ] **Step 1: Failing tests** — mocked ssh2: upload writes content via sftp and closes; upload_file uses SFTP first; when SFTP rejects, falls back to FTP and the result content notes `via FTP (plaintext) — enable SSH for encrypted transfer`.
- [ ] **Step 2: Implement** — `SftpClient` mirrors `SshClient`'s connect options/hostVerifier; `upload` = `conn.sftp((err, sftp) => sftp.writeFile(remoteName, Buffer.from(content), cb))` with cleanup. `upload_file` handler: try `context.sftpClient.upload(...)`; on error `log.warn` and fall back to existing `ftpClient.upload`, appending the plaintext note. Dry-run probes SFTP first, FTP second.
- [ ] **Step 3: Verify + docs + commit** — Available-Tools + Getting-Started note SSH is now the preferred transfer path. `feat: upload_file prefers SFTP over plaintext FTP`

---

### Task 20: Final sweep

- [ ] **Step 1:** Full `npm test && npm run typecheck && npm run lint`; fix any cross-task fallout.
- [ ] **Step 2:** Verify `CHANGELOG.md` `[Unreleased]` lists every task; verify lockstep tests (`tool-map-sync`, `available-tools-sync`, `tool-count-sync`) pass.
- [ ] **Step 3:** Commit any doc sync remainder — `docs: changelog and wiki sync for review-fix batch`

## Self-Review Notes

- Spec coverage: bugs #1–#11 → Tasks 1–10; areas A–I → Tasks 11–19 (area C split across 13; area G is Task 19). Recommended *features* from the review are intentionally out of scope.
- Type consistency: `isTrue` (Task 1) is reused by Tasks 8; `globMatch` (Task 12) reused by command-guard; executor helpers (Task 6) shared by fleet tools. `retryable` override defined once (Task 9).
- Known judgment calls recorded: ALL-tags for bulk_execute only; `;`-segment deny checks are fail-safe strict; users are never auto-recreated by rollback.
