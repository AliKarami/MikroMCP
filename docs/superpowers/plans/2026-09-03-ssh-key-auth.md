# Separate SSH Key Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add separate SSH username and private-key authentication to MikroMCP, then verify a multi-router deployment without enabling password-based SSH.

**Architecture:** Extend the existing router registry with two optional SSH-only fields. `SshClient` uses the configured private key and SSH username when present and preserves the current REST-password fallback when absent. Runtime configuration pins both router host keys and keeps REST credentials separate from SSH credentials.

**Tech Stack:** TypeScript, Node.js `fs`, `ssh2`, Zod, Vitest, RouterOS REST and SSH

**Spec:** `docs/superpowers/specs/2026-09-03-ssh-key-auth-design.md`

## Global Constraints

- Keep existing key-only RouterOS access working.
- Disable password SSH only after a positive key-authentication check.
- Never print, commit, or copy private-key contents or router passwords into documentation.
- Preserve password-based SSH behavior for router entries without `sshPrivateKeyPath`.
- Do not change firewall, VLAN, CAPsMAN, Wi-Fi, or forwarding configuration.

---

### Task 1: Router configuration contract

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config/router-registry.ts`
- Test: `test/unit/config/router-registry.test.ts`

**Interfaces:**
- Produces: `RouterConfig.sshUsername?: string`
- Produces: `RouterConfig.sshPrivateKeyPath?: string`

- [x] **Step 1: Add a registry test that loads both SSH-only fields**

```typescript
it("accepts a separate SSH username and absolute private-key path", () => {
  const path = tempYaml(`
routers:
  home:
    host: 192.168.1.1
    port: 443
    tls: { enabled: true, rejectUnauthorized: true }
    credentials: { source: env, envPrefix: ROUTER_HOME }
    tags: []
    rosVersion: "7"
    sshUsername: automation
    sshPrivateKeyPath: /tmp/id_automation
`);
  const router = new RouterRegistry(path).getRouter("home");
  expect(router.sshUsername).toBe("automation");
  expect(router.sshPrivateKeyPath).toBe("/tmp/id_automation");
});
```

- [x] **Step 2: Run the focused test and confirm it fails because the strict schema rejects the fields**

Run: `npx vitest run test/unit/config/router-registry.test.ts`

Expected: FAIL containing `Unrecognized key` for `sshUsername` or `sshPrivateKeyPath`.

- [x] **Step 3: Add the optional fields to `RouterConfig` and `RouterConfigSchema`**

```typescript
// src/types.ts
sshUsername?: string;
sshPrivateKeyPath?: string;

// src/config/router-registry.ts
sshUsername: z.string().min(1).optional(),
sshPrivateKeyPath: z.string().min(1).refine(isAbsolute, "sshPrivateKeyPath must be absolute").optional(),
```

- [x] **Step 4: Run the focused registry tests and confirm they pass**

Run: `npx vitest run test/unit/config/router-registry.test.ts`

Expected: the complete registry test file passes.

### Task 2: SSH public-key authentication

**Files:**
- Modify: `src/adapter/ssh-client.ts`
- Test: `test/unit/adapter/ssh-client.test.ts`

**Interfaces:**
- Consumes: `RouterConfig.sshUsername`, `RouterConfig.sshPrivateKeyPath`
- Produces: `ssh2.Client.connect()` options that contain either `privateKey` or `password`, never both when a private key is configured

- [x] **Step 1: Add a test using a temporary private-key fixture and a separate SSH username**

```typescript
it("uses a separate SSH username and private key without the REST password", () => {
  const { conn } = buildMocks();
  const keyPath = tempPrivateKey("test-private-key");
  const client = new SshClient(
    { ...routerConfig, sshUsername: "automation", sshPrivateKeyPath: keyPath },
    credentials,
  );

  client.execute("test command");

  const options = conn.connect.mock.calls[0][0] as Record<string, unknown>;
  expect(options.username).toBe("automation");
  expect(options.privateKey).toEqual(Buffer.from("test-private-key"));
  expect(options.password).toBeUndefined();
});
```

- [x] **Step 2: Run the focused test and confirm it fails because the old client sends the REST password**

Run: `npx vitest run test/unit/adapter/ssh-client.test.ts`

Expected: FAIL because `username` remains the REST username, `privateKey` is absent,
and `password` is present.

- [x] **Step 3: Read the configured key and construct the minimal key-authenticated connection options**

```typescript
const privateKey = this.config.sshPrivateKeyPath
  ? readFileSync(this.config.sshPrivateKeyPath)
  : undefined;
const connectOptions: Record<string, unknown> = {
  host: this.config.host,
  port: this.config.sshPort ?? 22,
  username: this.config.sshUsername ?? this.credentials.username,
  readyTimeout: 10_000,
};
if (privateKey) connectOptions.privateKey = privateKey;
else connectOptions.password = this.credentials.password;
```

- [x] **Step 4: Add a regression assertion that configurations without a key still use the REST password**

```typescript
expect(options).toMatchObject({ username: "admin", password: "pass" });
expect(options.privateKey).toBeUndefined();
```

- [x] **Step 5: Run both focused adapter and registry test files**

Run: `npx vitest run test/unit/adapter/ssh-client.test.ts test/unit/config/router-registry.test.ts`

Expected: both files pass with no skipped tests.

### Task 3: User documentation

**Files:**
- Modify: `config/routers.example.yaml`
- Modify: `docs/wiki/Configuration.md`
- Modify: `docs/wiki/Architecture.md`
- Modify: `docs/wiki/Connecting-to-AI-Assistants.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Documents: absolute private-key paths, separate SSH username, password fallback, and secret-handling boundary

- [x] **Step 1: Document `sshUsername` and `sshPrivateKeyPath` beside `sshPort` in `config/routers.example.yaml` and `docs/wiki/Configuration.md`**

Use an absolute example path and state that setting a key suppresses password
authentication for SSH only; REST continues to use `ROUTER_<PREFIX>_*`.

- [x] **Step 2: Update the architecture and assistant-connection guidance**

State that REST and SSH may use separate usernames and authentication methods,
that the key stays local, and that `list_routers` never returns key material.

- [x] **Step 3: Add the backward-compatible feature to `[Unreleased]`**

```markdown
### Added
- Router entries can use a separate SSH username and an absolute private-key path; SSH-backed tools no longer require RouterOS password authentication when a key is configured.
```

- [x] **Step 4: Run formatting checks and documentation lockstep tests**

Run: `npm run format:check`

Run: `npx vitest run test/unit/docs test/unit/skill/tool-map-sync.test.ts`

### Task 4: Build and live rollout

**Files outside Git:**
- Modify: `~/.mikromcp/routers.yaml`
- Modify: `~/.mikromcp/.env`
- Replace the globally installed MikroMCP package

**Interfaces:**
- Each router keeps its REST username and password under a distinct environment
  prefix.
- Each router can use a separate SSH username and absolute private-key path.

- [x] **Step 1: Run the complete source verification and build**

Run: `npm test`

Run: `npm run build`

- [x] **Step 2: Back up active configuration without exposing secrets**

Create timestamped copies of `~/.mikromcp/routers.yaml` and
`~/.mikromcp/.env`. Do not print either file, and restrict the environment file
and its backup to owner-only access.

- [x] **Step 3: Verify each SSH alias uses the intended username and private key; calculate raw SHA-256 host-key fingerprints for the registry**

Expected: both `/system identity print` commands succeed non-interactively.

- [x] **Step 4: Configure separate REST credentials without displaying the generated password**

Generate 32 random bytes locally. Set or rotate only the intended REST user,
store the same value under that router's environment prefix, and keep the
environment file mode `0600`. The command must not include the password in
captured output.

- [x] **Step 5: Configure both router entries**

Each entry uses its intended `sshUsername`, an absolute `sshPrivateKeyPath`,
and a pinned `sshFingerprint`.

- [x] **Step 6: Install the tested worktree package**

Run: `npm install --global /absolute/path/to/mikromcp-worktree`

- [x] **Step 7: Verify both protocol paths on both routers**

REST check: read `system/identity` through MikroMCP for each router.

SSH check: run `/system identity print` through MikroMCP for each router.

- [x] **Step 8: Disable SSH password authentication only after Step 7 succeeds**

Keep a working key-authenticated session open, apply
`/ip ssh set password-authentication=no`, then open a new key-authenticated
session and repeat the identity check.

- [x] **Step 9: Run final verification and commit the source branch**

Run: `npm test`

Run: `npm run build`

Run: `git diff --check`

Commit: `feat: support SSH private-key authentication`
