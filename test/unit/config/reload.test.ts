import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import bcrypt from "bcryptjs";
import { RouterRegistry } from "../../../src/config/router-registry.js";
import { IdentityRegistry } from "../../../src/config/identity-registry.js";
import { reloadConfig, type ReloadDeps } from "../../../src/config/reload.js";
import { configReloadTools } from "../../../src/domain/tools/config-reload-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { Identity } from "../../../src/types.js";

vi.mock("../../../src/observability/audit-log.js", () => ({ auditLog: vi.fn() }));

const [reloadTool] = configReloadTools;

const router = (host: string, extra = "") => `
  host: ${host}
  port: 443
  tls: { enabled: true, rejectUnauthorized: true }
  credentials: { source: env, envPrefix: ROUTER_X }
  tags: [lab]
  rosVersion: "7.20"${extra}`;

const routersYaml = (entries: Record<string, string>) =>
  "routers:\n" +
  Object.entries(entries)
    .map(([id, body]) => `  ${id}:${body.replace(/\n/g, "\n  ")}`)
    .join("\n") +
  "\n";

const hashes = {
  a: bcrypt.hashSync("token-a", 4),
  b: bcrypt.hashSync("token-b", 4),
};
const identitiesYaml = (entries: Record<string, { hash: string; role: string }>) =>
  "identities:\n" +
  Object.entries(entries)
    .map(
      ([id, e]) =>
        `  ${id}:\n    token: "${e.hash}"\n    role: ${e.role}\n    allowedRouters: []\n    allowedToolPatterns: []`,
    )
    .join("\n") +
  "\n";

function setup(
  routers: Record<string, string>,
  ids: Record<string, { hash: string; role: string }>,
) {
  const dir = mkdtempSync(join(tmpdir(), "mikromcp-reload-"));
  const routersPath = join(dir, "routers.yaml");
  const identitiesPath = join(dir, "identities.yaml");
  writeFileSync(routersPath, routersYaml(routers));
  writeFileSync(identitiesPath, identitiesYaml(ids));
  const routerRegistry = new RouterRegistry(routersPath);
  const identityRegistry = new IdentityRegistry(identitiesPath);
  const pool = { removeClient: vi.fn() };
  const circuitBreakers = new Map<string, unknown>([
    ["r1", {}],
    ["r2", {}],
  ]);
  const deps = {
    routerRegistry,
    identityRegistry,
    pool,
    circuitBreakers,
    config: { transport: "stdio", confirmationSecret: undefined },
  } as unknown as ReloadDeps;
  return {
    dir,
    deps,
    pool,
    circuitBreakers,
    routerRegistry,
    identityRegistry,
    writeRouters: (r: Record<string, string>) => writeFileSync(routersPath, routersYaml(r)),
    writeIdentities: (i: Record<string, { hash: string; role: string }>) =>
      writeFileSync(identitiesPath, identitiesYaml(i)),
    routersPath,
  };
}

const admin = { hash: hashes.a, role: "admin" };

describe("reloadConfig", () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup({ r1: router("192.0.2.1"), r2: router("192.0.2.2") }, { ops: admin });
  });

  it("picks up a changed host and reports the field, not the value", () => {
    env.writeRouters({ r1: router("192.0.2.9"), r2: router("192.0.2.2") });
    const result = reloadConfig(env.deps);
    expect(env.routerRegistry.getRouter("r1").host).toBe("192.0.2.9");
    expect(result.routers.changed).toEqual([{ id: "r1", fields: ["host"] }]);
    expect(result.routers.unchanged).toEqual(["r2"]);
    expect(JSON.stringify(result)).not.toContain("192.0.2");
  });

  it("reports added and removed routers", () => {
    env.writeRouters({ r2: router("192.0.2.2"), r3: router("192.0.2.3") });
    const result = reloadConfig(env.deps);
    expect(result.routers.added).toEqual(["r3"]);
    expect(result.routers.removed).toEqual(["r1"]);
    expect(env.routerRegistry.routerIds().sort()).toEqual(["r2", "r3"]);
  });

  it("drops the pooled client and circuit breaker of changed and removed routers only", () => {
    env.writeRouters({ r1: router("192.0.2.9") });
    reloadConfig(env.deps);
    expect(env.pool.removeClient.mock.calls.map((c) => c[0]).sort()).toEqual(["r1", "r2"]);
    expect([...env.circuitBreakers.keys()]).toEqual([]);
  });

  it("leaves the client and breaker of an unchanged router alone", () => {
    reloadConfig(env.deps);
    expect(env.pool.removeClient).not.toHaveBeenCalled();
    expect(env.circuitBreakers.size).toBe(2);
  });

  it("keeps everything when routers.yaml is invalid", () => {
    writeFileSync(env.routersPath, "routers:\n  r1:\n    host: 192.0.2.9\n");
    expect(() => reloadConfig(env.deps)).toThrow(/Invalid router config/);
    expect(env.routerRegistry.getRouter("r1").host).toBe("192.0.2.1");
    expect(env.pool.removeClient).not.toHaveBeenCalled();
  });

  it("keeps the routers too when only identities.yaml is invalid", () => {
    env.writeRouters({ r1: router("192.0.2.9") });
    writeFileSync(join(env.dir, "identities.yaml"), "identities:\n  ops:\n    role: nobody\n");
    expect(() => reloadConfig(env.deps)).toThrow(/Invalid identity config/);
    expect(env.routerRegistry.getRouter("r1").host).toBe("192.0.2.1");
  });

  it("refuses a file that has been deleted, instead of emptying the registry", () => {
    rmSync(env.routersPath);
    expect(() => reloadConfig(env.deps)).toThrow(/not found/);
    expect(env.routerRegistry.routerIds().sort()).toEqual(["r1", "r2"]);
  });

  it("reloads routers when identities.yaml never existed (stdio setups)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mikromcp-reload-"));
    const routersPath = join(dir, "routers.yaml");
    writeFileSync(routersPath, routersYaml({ r1: router("192.0.2.1") }));
    const routerRegistry = new RouterRegistry(routersPath);
    const identityRegistry = new IdentityRegistry(join(dir, "identities.yaml"));
    const deps = {
      routerRegistry,
      identityRegistry,
      pool: { removeClient: vi.fn() },
      circuitBreakers: new Map(),
      config: { transport: "stdio", confirmationSecret: undefined },
    } as unknown as ReloadDeps;
    writeFileSync(routersPath, routersYaml({ r1: router("192.0.2.9") }));
    const result = reloadConfig(deps);
    expect(routerRegistry.getRouter("r1").host).toBe("192.0.2.9");
    expect(result.identities).toEqual({ added: [], removed: [], changed: [], unchanged: [] });
  });

  it("changes nothing on a dry run, and still reports", () => {
    env.writeRouters({ r1: router("192.0.2.9"), r2: router("192.0.2.2") });
    const result = reloadConfig(env.deps, true);
    expect(result.applied).toBe(false);
    expect(result.routers.changed).toEqual([{ id: "r1", fields: ["host"] }]);
    expect(env.routerRegistry.getRouter("r1").host).toBe("192.0.2.1");
    expect(env.pool.removeClient).not.toHaveBeenCalled();
  });

  it("revokes a removed token at once, despite the token cache", async () => {
    expect((await env.identityRegistry.findIdentityByToken("token-a"))?.id).toBe("ops");
    env.writeIdentities({ other: { hash: hashes.b, role: "admin" } });
    const result = reloadConfig(env.deps);
    expect(result.identities).toMatchObject({ added: ["other"], removed: ["ops"] });
    expect(await env.identityRegistry.findIdentityByToken("token-a")).toBeNull();
    expect((await env.identityRegistry.findIdentityByToken("token-b"))?.id).toBe("other");
  });

  it("stops accepting a rotated token under the same identity id", async () => {
    expect((await env.identityRegistry.findIdentityByToken("token-a"))?.id).toBe("ops");
    env.writeIdentities({ ops: { hash: hashes.b, role: "admin" } });
    reloadConfig(env.deps);
    expect(await env.identityRegistry.findIdentityByToken("token-a")).toBeNull();
    expect((await env.identityRegistry.findIdentityByToken("token-b"))?.id).toBe("ops");
  });

  it("applies a changed role", async () => {
    env.writeIdentities({ ops: { hash: hashes.a, role: "readonly" } });
    const result = reloadConfig(env.deps);
    expect(result.identities.changed).toEqual(["ops"]);
    expect((await env.identityRegistry.findIdentityByToken("token-a"))?.role).toBe("readonly");
  });

  it("refuses limited roles over HTTP without the confirmation secret", () => {
    env.writeIdentities({ ops: { hash: hashes.a, role: "operator" } });
    const http = { ...env.deps, config: { transport: "http", confirmationSecret: undefined } };
    expect(() => reloadConfig(http as ReloadDeps)).toThrow(/MIKROMCP_CONFIRMATION_SECRET/);
    expect(env.identityRegistry.getIdentities()[0].role).toBe("admin");
    const withSecret = { ...env.deps, config: { transport: "http", confirmationSecret: "s" } };
    expect(() => reloadConfig(withSecret as ReloadDeps)).not.toThrow();
  });
});

describe("RouterRegistry.prepareReload with other router sources", () => {
  const inlineYaml = routersYaml({ inl: router("192.0.2.50") });

  it("keeps routers from MIKROMCP_ROUTERS, whatever the file says now", () => {
    const dir = mkdtempSync(join(tmpdir(), "mikromcp-reload-"));
    const path = join(dir, "routers.yaml");
    const registry = new RouterRegistry(path, { MIKROMCP_ROUTERS: inlineYaml });
    writeFileSync(path, routersYaml({ other: router("192.0.2.60") }));

    const { changes, commit } = registry.prepareReload();
    commit();

    expect(changes).toEqual({ added: [], removed: [], changed: [], unchanged: ["inl"] });
    expect(registry.routerIds()).toEqual(["inl"]);
    expect(registry.source).toBe("inline");
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps routers from MIKROMCP_ROUTER_* variables while there is no file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mikromcp-reload-"));
    const registry = new RouterRegistry(join(dir, "routers.yaml"), {
      MIKROMCP_ROUTER_HOST: "192.0.2.70",
    });

    const { changes } = registry.prepareReload();

    expect(changes.unchanged).toEqual(["default"]);
    expect(changes.added).toEqual([]);
    expect(changes.removed).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("moves to a routers.yaml that appears after startup, as it would at startup", () => {
    const dir = mkdtempSync(join(tmpdir(), "mikromcp-reload-"));
    const path = join(dir, "routers.yaml");
    const registry = new RouterRegistry(path, { MIKROMCP_ROUTER_HOST: "192.0.2.70" });
    writeFileSync(path, routersYaml({ r1: router("192.0.2.1") }));

    const { changes, commit } = registry.prepareReload();
    commit();

    expect(changes.added).toEqual(["r1"]);
    expect(changes.removed).toEqual(["default"]);
    expect(registry.source).toBe("file");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("reload_config tool", () => {
  function contextFor(env: ReturnType<typeof setup>, identity: Identity): ToolContext {
    return {
      routerRegistry: env.routerRegistry,
      identityRegistry: env.identityRegistry,
      connectionPool: env.pool,
      circuitBreakers: env.circuitBreakers,
      appConfig: env.deps.config,
      correlationId: "c1",
      identity,
    } as unknown as ToolContext;
  }
  const as = (role: Identity["role"]): Identity => ({
    id: "tester",
    role,
    allowedRouters: [],
    allowedToolPatterns: [],
  });

  it("is a destructive write tool that needs no router", () => {
    expect(reloadTool.name).toBe("reload_config");
    expect(reloadTool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(reloadTool.skipRouterContext).toBe(true);
  });

  it.each(["readonly", "operator"] as const)("refuses the %s role", async (role) => {
    const env = setup({ r1: router("192.0.2.1") }, { ops: admin });
    await expect(reloadTool.handler({}, contextFor(env, as(role)))).rejects.toMatchObject({
      code: "RELOAD_NOT_ALLOWED",
    });
  });

  it("reloads for an admin and says what changed", async () => {
    const env = setup({ r1: router("192.0.2.1") }, { ops: admin });
    env.writeRouters({ r1: router("192.0.2.9"), r2: router("192.0.2.2") });
    const result = await reloadTool.handler({}, contextFor(env, as("admin")));
    expect(result.content).toContain("Configuration reloaded");
    expect(result.content).toContain("changed: r1 (host)");
    expect(result.content).toContain("added: r2");
    expect(env.routerRegistry.getRouter("r1").host).toBe("192.0.2.9");
  });

  it("dry run reports without changing", async () => {
    const env = setup({ r1: router("192.0.2.1") }, { ops: admin });
    env.writeRouters({ r1: router("192.0.2.9") });
    const result = await reloadTool.handler({ dryRun: true }, contextFor(env, as("superadmin")));
    expect(result.content).toContain("nothing was changed");
    expect(env.routerRegistry.getRouter("r1").host).toBe("192.0.2.1");
  });

  it("turns a bad file into RELOAD_REFUSED that says the old config is in force", async () => {
    const env = setup({ r1: router("192.0.2.1") }, { ops: admin });
    writeFileSync(env.routersPath, "routers: nonsense\n");
    await expect(reloadTool.handler({}, contextFor(env, as("admin")))).rejects.toMatchObject({
      code: "RELOAD_REFUSED",
      message: expect.stringContaining("unchanged"),
    });
    expect(env.routerRegistry.getRouter("r1").host).toBe("192.0.2.1");
  });

  it("rejects extra parameters", async () => {
    const env = setup({ r1: router("192.0.2.1") }, { ops: admin });
    await expect(
      reloadTool.handler({ force: true }, contextFor(env, as("admin"))),
    ).rejects.toThrow();
  });
});
