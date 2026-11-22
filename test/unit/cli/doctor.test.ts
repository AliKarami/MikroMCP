import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock modules before any import ─────────────────────────────────────────

vi.mock("chalk", () => {
  const identity = (s: string) => s;
  const chalkFn = Object.assign(identity, {
    green: identity,
    red: identity,
    yellow: identity,
    bold: identity,
    dim: identity,
  });
  return { default: chalkFn };
});

vi.mock("../../../src/config/router-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/router-registry.js")>();
  return { ...actual, RouterRegistry: vi.fn() };
});

vi.mock("../../../src/config/secrets.js", () => ({
  getCredentials: vi.fn(),
}));

vi.mock("../../../src/adapter/rest-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/adapter/rest-client.js")>();
  return { HttpError: actual.HttpError, RouterOSRestClient: vi.fn() };
});

vi.mock("../../../src/adapter/swos-client.js", () => ({
  SwosClient: vi.fn(),
}));

vi.mock("../../../src/config/identity-registry.js", () => ({
  IdentityRegistry: vi.fn(),
}));

vi.mock("../../../src/config/app-config.js", () => ({
  loadAppConfig: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return { ...actual, createConnection: vi.fn() };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => "/mock/home") };
});

// ─── Imports after mocks ─────────────────────────────────────────────────────

import * as fsModule from "node:fs";
import * as netModule from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RouterRegistry, type RouterSource } from "../../../src/config/router-registry.js";
import { getCredentials } from "../../../src/config/secrets.js";
import { HttpError, RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { SwosClient } from "../../../src/adapter/swos-client.js";
import { IdentityRegistry } from "../../../src/config/identity-registry.js";
import { loadAppConfig } from "../../../src/config/app-config.js";

const MockRouterRegistry = vi.mocked(RouterRegistry);
const mockGetCredentials = vi.mocked(getCredentials);
const MockRouterOSRestClient = vi.mocked(RouterOSRestClient);
const MockSwosClient = vi.mocked(SwosClient);
const MockIdentityRegistry = vi.mocked(IdentityRegistry);
const mockLoadAppConfig = vi.mocked(loadAppConfig);
const mockExistsSync = vi.mocked(fsModule.existsSync);
const mockReadFileSync = vi.mocked(fsModule.readFileSync);
const mockCreateConnection = vi.mocked(netModule.createConnection);

function fakeRegistry(
  routers: unknown[],
  source: RouterSource = "file",
  ignoredSources: string[] = [],
): RouterRegistry {
  return { listRouters: () => routers, source, ignoredSources } as unknown as RouterRegistry;
}

// ─── Test router fixture ─────────────────────────────────────────────────────

function makeRouter(
  overrides: Partial<{
    id: string;
    host: string;
    sshPort?: number;
    sshPrivateKeyPath?: string;
  }> = {},
) {
  return {
    id: overrides.id ?? "core-01",
    host: overrides.host ?? "192.168.1.1",
    port: 443,
    tls: { enabled: true, rejectUnauthorized: false },
    credentials: { source: "env" as const, envPrefix: "ROUTER_CORE01" },
    tags: [],
    rosVersion: "7.14",
    sshPort: overrides.sshPort,
    sshPrivateKeyPath: overrides.sshPrivateKeyPath,
  };
}

function makeAppConfig(
  overrides: Partial<{
    transport: "stdio" | "http";
    configPath: string;
    identitiesPath: string;
    confirmationSecret?: string;
  }> = {},
) {
  return {
    transport: overrides.transport ?? "stdio",
    port: 3000,
    bindHost: "127.0.0.1",
    logLevel: "info",
    configPath: overrides.configPath ?? "config/routers.yaml",
    dataDir: "data",
    snapshotDir: "data/snapshots",
    journalPath: "data/write-journal.ndjson",
    cmdAllow: [],
    cmdDeny: [],
    identitiesPath: overrides.identitiesPath ?? "config/identities.yaml",
    stdioIdentity: undefined,
    confirmationSecret: overrides.confirmationSecret,
    auditLogPath: undefined,
    readOnly: false,
    toolsets: [],
    http: {
      maxBodyBytes: 1048576,
      rateLimitRpm: 60,
      allowedHosts: [],
      allowedOrigins: [],
      allowedIps: [],
    },
    ssh: { commandTimeoutMs: 30000, maxOutputBytes: 524288 },
    retry: { maxRetries: 3, baseDelayMs: 200, maxDelayMs: 5000 },
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30000 },
  };
}

// TCP probe returns connected socket mock
function makeTcpSocket(connectImmediately = true) {
  const socket: Record<string, unknown> = {
    on: vi.fn(),
    destroy: vi.fn(),
  };
  if (connectImmediately) {
    (socket.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, cb: () => void) => {
      if (event === "connect") setTimeout(cb, 0);
      return socket;
    });
  } else {
    (socket.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, cb: () => void) => {
      if (event === "error") setTimeout(cb, 0);
      return socket;
    });
  }
  return socket;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runDoctor", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let globalFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // Default: no fetch update available
    globalFetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "0.9.0" }),
    });
    vi.stubGlobal("fetch", globalFetchMock);

    // Default process.exitCode reset
    process.exitCode = 0;

    // Default app config
    mockLoadAppConfig.mockReturnValue(makeAppConfig() as ReturnType<typeof loadAppConfig>);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.unstubAllGlobals();
    process.exitCode = 0;
  });

  describe("Node version check", () => {
    it("passes with current Node.js version ≥22", async () => {
      // Current test runner must be Node 22+ as required by engines
      mockExistsSync.mockReturnValue(false);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([], "none"));

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/Node\.js v\d+/);
      // As long as Node ≥22, it should show ✅
      const major = parseInt(process.version.slice(1).split(".")[0], 10);
      if (major >= 22) {
        expect(allOutput).toMatch(/✅.*Node\.js/);
      }
    });
  });

  describe("Config file check", () => {
    it("reports error when config file does not exist", async () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        // config file missing, everything else can be false
        return false;
      });
      MockRouterRegistry.mockImplementation(() => fakeRegistry([], "none"));

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/❌.*Config file not found/);
      expect(process.exitCode).toBe(1);
    });

    it("reports success with router count when config is valid", async () => {
      const router = makeRouter();
      mockExistsSync.mockImplementation(() => true);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([router]));
      mockGetCredentials.mockReturnValue({ username: "admin", password: "secret" });

      const mockClient = {
        get: vi.fn().mockResolvedValue([{ version: "7.14" }]),
        close: vi.fn(),
      };
      MockRouterOSRestClient.mockImplementation(() => mockClient as unknown as RouterOSRestClient);
      mockCreateConnection.mockReturnValue(makeTcpSocket(true) as unknown as net.Socket);

      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );

      mockReadFileSync.mockReturnValue(
        JSON.stringify({ mcpServers: { "mikrotik-mcp-server": {} } }),
      );

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/✅.*Config.*1 router/);
    });

    it("warns about a RouterOS router binding a secret whose variable is unset", async () => {
      const router = { ...makeRouter(), secrets: ["BACKUP"] };
      mockExistsSync.mockImplementation(() => true);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([router]));
      mockGetCredentials.mockReturnValue({ username: "admin", password: "secret" });
      MockRouterOSRestClient.mockImplementation(
        () =>
          ({
            get: vi.fn().mockResolvedValue([{ version: "7.14" }]),
            close: vi.fn(),
          }) as unknown as RouterOSRestClient,
      );
      mockCreateConnection.mockReturnValue(makeTcpSocket(true) as unknown as net.Socket);
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: {} }));
      delete process.env.MIKROMCP_SECRET_BACKUP;

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(
        /core-01 binds secret BACKUP, but MIKROMCP_SECRET_BACKUP is not set or empty — create_backup/,
      );
      expect(allOutput).not.toMatch(/core-01 has no secrets list/);
    });

    it("reports error when config file has parse errors", async () => {
      mockExistsSync.mockReturnValue(true);
      MockRouterRegistry.mockImplementation(() => {
        throw new Error("Invalid router config: missing host");
      });

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/❌.*Config parse error/);
      expect(process.exitCode).toBe(1);
    });
  });

  describe("Router source", () => {
    const envRouter = {
      ...makeRouter({ id: "default", host: "192.0.2.1" }),
      credentials: { source: "env" as const, envPrefix: "MIKROMCP_ROUTER" },
    };

    async function runWith(registry: RouterRegistry): Promise<string> {
      mockExistsSync.mockReturnValue(false);
      MockRouterRegistry.mockImplementation(() => registry);
      MockRouterOSRestClient.mockImplementation(
        () =>
          ({
            get: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
            close: vi.fn(),
          }) as unknown as RouterOSRestClient,
      );
      mockCreateConnection.mockReturnValue(makeTcpSocket(false) as unknown as net.Socket);
      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();
      return consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    }

    it("reports routers synthesised from the MIKROMCP_ROUTER_* variables", async () => {
      vi.stubEnv("MIKROMCP_ROUTER_USER", "mcp");
      vi.stubEnv("MIKROMCP_ROUTER_PASS", "pw");
      try {
        mockGetCredentials.mockReturnValue({ username: "mcp", password: "pw" });
        const output = await runWith(fakeRegistry([envRouter], "env"));
        expect(output).toMatch(
          /✅.*Config: MIKROMCP_ROUTER_\* environment variables \(1 router: default at 192\.0\.2\.1:443\)/,
        );
        expect(output).toMatch(/✅.*Env vars: all router credentials present/);
        expect(output).toMatch(/Default router: default \(sole configured router/);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("names the MIKROMCP_ROUTER credential variables when they are missing", async () => {
      vi.stubEnv("MIKROMCP_ROUTER_USER", undefined);
      vi.stubEnv("MIKROMCP_ROUTER_PASS", undefined);
      try {
        const output = await runWith(fakeRegistry([envRouter], "env"));
        expect(output).toMatch(
          /❌.*Missing credential env vars: MIKROMCP_ROUTER_USER, MIKROMCP_ROUTER_PASS/,
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("reports routers from MIKROMCP_ROUTERS", async () => {
      const output = await runWith(fakeRegistry([makeRouter(), makeRouter()], "inline"));
      expect(output).toMatch(/✅.*Config: MIKROMCP_ROUTERS environment variable \(2 routers\)/);
    });

    it("warns about each lower-precedence source that is ignored", async () => {
      const output = await runWith(
        fakeRegistry([makeRouter()], "file", ["MIKROMCP_ROUTER_* variables"]),
      );
      expect(output).toMatch(/✅.*Config: config\/routers\.yaml \(1 router\)/);
      expect(output).toMatch(
        /⚠️.*MIKROMCP_ROUTER_\* variables set but ignored — routers come from the higher-precedence source/,
      );
    });

    it("explains both ways to configure a router when no source is set", async () => {
      const output = await runWith(fakeRegistry([], "none"));
      expect(output).toMatch(
        /❌.*Config file not found: config\/routers\.yaml — and neither MIKROMCP_ROUTERS nor MIKROMCP_ROUTER_HOST is set/,
      );
      expect(output).toMatch(/Hint: run mikromcp init, or set MIKROMCP_ROUTER_HOST/);
      expect(process.exitCode).toBe(1);
    });
  });

  describe("Router connectivity", () => {
    it("reports success for reachable router with read policy", async () => {
      const router = makeRouter({ host: "10.0.0.1" });
      mockExistsSync.mockReturnValue(true);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([router]));
      mockGetCredentials.mockReturnValue({ username: "admin", password: "pass" });

      const mockClient = {
        get: vi.fn().mockResolvedValue([{ version: "7.14" }]),
        close: vi.fn(),
      };
      MockRouterOSRestClient.mockImplementation(() => mockClient as unknown as RouterOSRestClient);
      mockCreateConnection.mockReturnValue(makeTcpSocket(true) as unknown as net.Socket);

      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ mcpServers: { "mikrotik-mcp-server": {} } }),
      );

      // Stub env vars so checkEnvVars passes (router uses envPrefix ROUTER_CORE01)
      process.env.ROUTER_CORE01_USER = "test-user";
      process.env.ROUTER_CORE01_PASS = "test-pass";

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      delete process.env.ROUTER_CORE01_USER;
      delete process.env.ROUTER_CORE01_PASS;

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/Router: core-01/);
      expect(allOutput).toMatch(/✅.*REST API reachable/);
      expect(allOutput).toMatch(/✅.*read policy/);
      expect(process.exitCode).toBe(0);
    });

    it("reports failure when REST API is unreachable — does not throw", async () => {
      const router = makeRouter({ host: "10.0.0.2" });
      mockExistsSync.mockReturnValue(true);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([router]));
      mockGetCredentials.mockReturnValue({ username: "admin", password: "pass" });

      const mockClient = {
        get: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        close: vi.fn(),
      };
      MockRouterOSRestClient.mockImplementation(() => mockClient as unknown as RouterOSRestClient);
      mockCreateConnection.mockReturnValue(makeTcpSocket(false) as unknown as net.Socket);

      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: {} }));

      const { runDoctor } = await import("../../../src/cli/doctor.js");

      // Should not throw
      await expect(runDoctor()).resolves.toBeUndefined();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/❌.*REST API not reachable/);
      expect(process.exitCode).toBe(1);
    });

    it("reports warning for SSH not reachable", async () => {
      const router = makeRouter({ sshPort: 2222 });
      mockExistsSync.mockReturnValue(true);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([router]));
      mockGetCredentials.mockReturnValue({ username: "admin", password: "pass" });

      // REST ok, SSH fails
      let callCount = 0;
      const mockClient = {
        get: vi.fn().mockResolvedValue([{ version: "7.14" }]),
        close: vi.fn(),
      };
      MockRouterOSRestClient.mockImplementation(() => mockClient as unknown as RouterOSRestClient);

      mockCreateConnection.mockImplementation(() => {
        callCount++;
        // SSH probe (port 2222) fails, FTP (port 21) succeeds
        return makeTcpSocket(callCount % 2 === 0) as unknown as net.Socket;
      });

      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ mcpServers: { "mikrotik-mcp-server": {} } }),
      );

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/⚠️.*SSH not reachable on port 2222/);
    });
  });

  describe("SwOS switch connectivity", () => {
    function makeSwitch() {
      return {
        id: "access-sw",
        host: "192.168.88.2",
        port: 80,
        deviceType: "swos" as const,
        tls: { enabled: false, rejectUnauthorized: true },
        credentials: { source: "env" as const, envPrefix: "SWITCH_ACCESS" },
        tags: [],
        rosVersion: "swos",
      };
    }

    function setupSwitch(get: ReturnType<typeof vi.fn>) {
      const sw = makeSwitch();
      mockExistsSync.mockReturnValue(true);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([sw]));
      mockGetCredentials.mockReturnValue({ username: "admin", password: "pass" });
      const mockClient = { get, close: vi.fn() };
      MockSwosClient.mockImplementation(() => mockClient as unknown as SwosClient);
      mockCreateConnection.mockReturnValue(makeTcpSocket(false) as unknown as net.Socket);
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ mcpServers: { "mikrotik-mcp-server": {} } }),
      );
      process.env.SWITCH_ACCESS_USER = "test-user";
      process.env.SWITCH_ACCESS_PASS = "test-pass";
      return mockClient;
    }

    afterEach(() => {
      delete process.env.SWITCH_ACCESS_USER;
      delete process.env.SWITCH_ACCESS_PASS;
    });

    it("reads sys.b over the SwOS API and skips the RouterOS REST/SSH/FTP checks", async () => {
      const client = setupSwitch(
        vi
          .fn()
          .mockResolvedValue({ identity: "access-sw", model: "CSS106-5G-1S", version: "2.16" }),
      );

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(MockSwosClient).toHaveBeenCalledWith("192.168.88.2", 80, {
        username: "admin",
        password: "pass",
      });
      expect(client.get).toHaveBeenCalledWith("sys.b");
      expect(client.close).toHaveBeenCalled();
      expect(MockRouterOSRestClient).not.toHaveBeenCalled();
      expect(mockCreateConnection).not.toHaveBeenCalled();
      expect(allOutput).toMatch(/Switch: access-sw \(192\.168\.88\.2, SwOS\)/);
      expect(allOutput).toMatch(
        /✅.*SwOS API reachable \(identity access-sw, CSS106-5G-1S, SwOS 2\.16, \d+ms\)/,
      );
      expect(allOutput).not.toMatch(/REST API/);
      expect(allOutput).not.toMatch(/SSH not reachable|FTP not reachable/);
      expect(process.exitCode).toBe(0);
    });

    it("warns about a bound secret whose variable is unset or empty, and about a switch with no list", async () => {
      setupSwitch(
        vi
          .fn()
          .mockResolvedValue({ identity: "access-sw", model: "CSS106-5G-1S", version: "2.16" }),
      );
      const bound = { ...makeSwitch(), secrets: ["SNMP_COMMUNITY"] };
      MockRouterRegistry.mockImplementation(() => fakeRegistry([bound]));
      delete process.env.MIKROMCP_SECRET_SNMP_COMMUNITY;
      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();
      let allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(
        /access-sw binds secret SNMP_COMMUNITY, but MIKROMCP_SECRET_SNMP_COMMUNITY is not set or empty/,
      );
      consoleSpy.mockClear();
      process.env.MIKROMCP_SECRET_SNMP_COMMUNITY = "";
      await runDoctor();
      allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/MIKROMCP_SECRET_SNMP_COMMUNITY is not set or empty/);

      consoleSpy.mockClear();
      process.env.MIKROMCP_SECRET_SNMP_COMMUNITY = "c0mmunity";
      try {
        MockRouterRegistry.mockImplementation(() => fakeRegistry([makeSwitch()]));
        await runDoctor();
        allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(allOutput).not.toMatch(/binds secret/);
        expect(allOutput).toMatch(
          /access-sw has no secrets list in routers.yaml: a config referencing \$\{NAME\} is refused on it/,
        );
      } finally {
        delete process.env.MIKROMCP_SECRET_SNMP_COMMUNITY;
      }
    });

    it("reports a 401 as an authentication failure, not as unreachable", async () => {
      setupSwitch(vi.fn().mockRejectedValue(new HttpError(401, "digest authentication failed")));

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/❌.*SwOS API authentication failed \(HTTP 401/);
      expect(allOutput).not.toMatch(/not reachable/);
      expect(process.exitCode).toBe(1);
    });

    it("reports an unreachable switch — does not throw", async () => {
      setupSwitch(vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/❌.*SwOS API not reachable after \d+ms — ECONNREFUSED/);
      expect(process.exitCode).toBe(1);
    });

    it("accepts an empty password for a switch but warns about one for a router", async () => {
      const sw = makeSwitch();
      const router = {
        ...sw,
        id: "core",
        deviceType: undefined,
        rosVersion: "7.x",
        credentials: { source: "env" as const, envPrefix: "ROUTER_CORE" },
      };
      mockExistsSync.mockReturnValue(true);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([sw, router]));
      mockGetCredentials.mockReturnValue({ username: "admin", password: "" });
      MockSwosClient.mockImplementation(
        () => ({ get: vi.fn().mockResolvedValue({}), close: vi.fn() }) as unknown as SwosClient,
      );
      MockRouterOSRestClient.mockImplementation(
        () =>
          ({
            get: vi.fn().mockResolvedValue([{ version: "7.14" }]),
            close: vi.fn(),
          }) as unknown as RouterOSRestClient,
      );
      mockCreateConnection.mockReturnValue(makeTcpSocket(true) as unknown as net.Socket);
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ mcpServers: { "mikrotik-mcp-server": {} } }),
      );
      process.env.SWITCH_ACCESS_USER = "admin";
      process.env.SWITCH_ACCESS_PASS = "";
      process.env.ROUTER_CORE_USER = "admin";
      process.env.ROUTER_CORE_PASS = "";
      try {
        const { runDoctor } = await import("../../../src/cli/doctor.js");
        await runDoctor({ configPath: "/path/to/routers.yaml", transport: "stdio" });
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(output).not.toContain("Missing credential env vars");
        expect(output).toContain("ROUTER_CORE_PASS is empty");
        expect(output).not.toContain("SWITCH_ACCESS_PASS is empty");
      } finally {
        delete process.env.ROUTER_CORE_USER;
        delete process.env.ROUTER_CORE_PASS;
      }
    });
  });

  describe("Claude Desktop check", () => {
    it("reports registered when mikrotik-mcp-server key present", async () => {
      mockExistsSync.mockReturnValue(true);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([], "none"));
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ mcpServers: { "mikrotik-mcp-server": { command: "mikromcp" } } }),
      );

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/✅.*Claude Desktop.*registered/);
    });

    it("warns with snippet when not registered", async () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const path = p as string;
        // config file exists, Claude desktop config exists, .env doesn't
        if (path.includes("routers.yaml")) return true;
        if (path.includes("Application Support/Claude")) return true;
        if (path === ".env" || path === ".env.local") return false;
        return false;
      });
      MockRouterRegistry.mockImplementation(() => fakeRegistry([], "none"));
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: {} }));

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/⚠️.*not registered/);
      expect(allOutput).toMatch(/mikromcp/);
    });
  });

  describe("Default router check", () => {
    function setupRouters(routers: ReturnType<typeof makeRouter>[]) {
      mockExistsSync.mockReturnValue(true);
      MockRouterRegistry.mockImplementation(() => fakeRegistry(routers));
      mockGetCredentials.mockReturnValue({ username: "admin", password: "pass" });
      const mockClient = {
        get: vi.fn().mockResolvedValue([{ version: "7.14" }]),
        close: vi.fn(),
      };
      MockRouterOSRestClient.mockImplementation(() => mockClient as unknown as RouterOSRestClient);
      mockCreateConnection.mockReturnValue(makeTcpSocket(true) as unknown as net.Socket);
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: { mikromcp: {} } }));
    }

    it("passes when MIKROMCP_DEFAULT_ROUTER matches a configured router", async () => {
      mockLoadAppConfig.mockReturnValue({
        ...makeAppConfig(),
        defaultRouter: "core-01",
      } as ReturnType<typeof loadAppConfig>);
      setupRouters([makeRouter({ id: "core-01" })]);

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/✅.*Default router: core-01/);
    });

    it("fails when MIKROMCP_DEFAULT_ROUTER does not match any router", async () => {
      mockLoadAppConfig.mockReturnValue({
        ...makeAppConfig(),
        defaultRouter: "ghost",
      } as ReturnType<typeof loadAppConfig>);
      setupRouters([makeRouter({ id: "core-01" })]);

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/❌.*MIKROMCP_DEFAULT_ROUTER="ghost" does not match/);
      expect(process.exitCode).toBe(1);
    });

    it("notes the sole router as implicit default when none is set", async () => {
      mockLoadAppConfig.mockReturnValue(makeAppConfig() as ReturnType<typeof loadAppConfig>);
      setupRouters([makeRouter({ id: "only-one" })]);

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/✅.*Default router: only-one \(sole configured router/);
    });

    it("warns when multiple routers exist and no default is set", async () => {
      mockLoadAppConfig.mockReturnValue(makeAppConfig() as ReturnType<typeof loadAppConfig>);
      setupRouters([
        makeRouter({ id: "core-01" }),
        makeRouter({ id: "core-02", host: "10.0.0.9" }),
      ]);

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/⚠️.*No MIKROMCP_DEFAULT_ROUTER set and 2 routers configured/);
    });
  });

  describe("SSH key check", () => {
    function tempKey(mode: number): string {
      const dir = fsModule.mkdtempSync(join(tmpdir(), "mikromcp-doctor-key-"));
      const path = join(dir, "id_test");
      fsModule.writeFileSync(path, "test-private-key", { mode });
      fsModule.chmodSync(path, mode);
      return path;
    }

    async function runWithKey(keyPath: string): Promise<string> {
      const router = makeRouter({ sshPrivateKeyPath: keyPath });
      mockExistsSync.mockImplementation(() => true);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([router]));
      mockGetCredentials.mockReturnValue({ username: "admin", password: "secret" });
      const mockClient = {
        get: vi.fn().mockResolvedValue([{ version: "7.14" }]),
        close: vi.fn(),
      };
      MockRouterOSRestClient.mockImplementation(() => mockClient as unknown as RouterOSRestClient);
      mockCreateConnection.mockReturnValue(
        makeTcpSocket(true) as unknown as ReturnType<typeof netModule.createConnection>,
      );
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ mcpServers: { "mikrotik-mcp-server": {} } }),
      );

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();
      return consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    }

    it("reports an owner-only private key as ok", async () => {
      const out = await runWithKey(tempKey(0o600));
      expect(out).toMatch(/✅.*SSH key for core-01/);
    });

    it.skipIf(process.platform === "win32")(
      "warns when the private key is readable by group or others",
      async () => {
        const out = await runWithKey(tempKey(0o644));
        expect(out).toMatch(/⚠️.*SSH key for core-01.*0600/);
      },
    );
  });

  describe("Usage skill check", () => {
    it("reports installed when the skill exists in ~/.claude/skills", async () => {
      mockLoadAppConfig.mockReturnValue(makeAppConfig() as ReturnType<typeof loadAppConfig>);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([], "none"));
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockExistsSync.mockImplementation((p: unknown) =>
        String(p).includes(".claude/skills/mikromcp/SKILL.md"),
      );

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/✅.*Usage skill: installed/);
    });

    it("warns when the skill is not installed", async () => {
      mockLoadAppConfig.mockReturnValue(makeAppConfig() as ReturnType<typeof loadAppConfig>);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([], "none"));
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockExistsSync.mockReturnValue(false);

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/⚠️.*Usage skill not installed/);
    });
  });

  describe("Update check", () => {
    it("reports up to date when versions match", async () => {
      mockExistsSync.mockReturnValue(false);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([], "none"));
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );

      // Respond with same version as local (from package.json)
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      const { version: pkgVersion } = req("../../../package.json") as { version: string };

      globalFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ version: pkgVersion }),
      });

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/✅.*Up to date/);
    });

    it("is non-fatal when update fetch fails", async () => {
      mockExistsSync.mockReturnValue(false);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([], "none"));
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );

      globalFetchMock.mockRejectedValue(new Error("Network unreachable"));

      const { runDoctor } = await import("../../../src/cli/doctor.js");

      // Should not throw
      await expect(runDoctor()).resolves.toBeUndefined();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/⚠️.*Could not check for updates/);
    });

    it("warns when update is available", async () => {
      mockExistsSync.mockReturnValue(false);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([], "none"));
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );

      globalFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "99.0.0" }),
      });

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/⚠️.*Update available/);
      expect(allOutput).toMatch(/99\.0\.0/);
    });
  });

  describe("tool catalogue", () => {
    async function outputWith(over: Record<string, unknown>) {
      mockLoadAppConfig.mockReturnValue({
        ...makeAppConfig(),
        ...over,
      } as ReturnType<typeof loadAppConfig>);
      mockExistsSync.mockReturnValue(false);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([], "none"));
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: {} }));
      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();
      return consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    }

    it("reports a reduced catalogue", async () => {
      const out = await outputWith({ readOnly: true, toolsets: ["firewall"] });
      expect(out).toMatch(/Tool catalogue: \d+ of \d+ tools \(read-only; toolsets firewall\)/);
    });

    it("fails on an unknown toolset", async () => {
      const out = await outputWith({ toolsets: ["nope"] });
      expect(out).toMatch(/unknown toolsets: nope/);
    });
  });

  describe("HTTP mode checks", () => {
    it("warns when MIKROMCP_CONFIRMATION_SECRET not set in HTTP mode", async () => {
      mockLoadAppConfig.mockReturnValue(
        makeAppConfig({ transport: "http", confirmationSecret: undefined }) as ReturnType<
          typeof loadAppConfig
        >,
      );
      const router = makeRouter();
      mockExistsSync.mockReturnValue(true);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([router]));
      // Set env vars so they pass
      process.env.ROUTER_CORE01_USER = "admin";
      process.env.ROUTER_CORE01_PASS = "pass";
      mockGetCredentials.mockReturnValue({ username: "admin", password: "pass" });

      const mockClient = {
        get: vi.fn().mockResolvedValue([{ version: "7.14" }]),
        close: vi.fn(),
      };
      MockRouterOSRestClient.mockImplementation(() => mockClient as unknown as RouterOSRestClient);
      mockCreateConnection.mockReturnValue(makeTcpSocket(true) as unknown as net.Socket);

      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: {} }));

      // Unset confirmation secret from env
      delete process.env.MIKROMCP_CONFIRMATION_SECRET;

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/MIKROMCP_CONFIRMATION_SECRET not set/);

      // cleanup
      delete process.env.ROUTER_CORE01_USER;
      delete process.env.ROUTER_CORE01_PASS;
    });

    async function doctorOutputWith(http: Record<string, unknown>, bindHost: string) {
      const base = makeAppConfig({ transport: "http", confirmationSecret: "s" });
      mockLoadAppConfig.mockReturnValue({
        ...base,
        bindHost,
        http: { ...base.http, ...http },
      } as ReturnType<typeof loadAppConfig>);
      mockExistsSync.mockReturnValue(false);
      MockRouterRegistry.mockImplementation(() => fakeRegistry([], "none"));
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: {} }));
      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();
      return consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    }

    it("warns when bound to a non-loopback address without a host allow list", async () => {
      const out = await doctorOutputWith({}, "0.0.0.0");
      expect(out).toMatch(/without MIKROMCP_HTTP_ALLOWED_HOSTS/);
    });

    it("reports the allow lists when they are set", async () => {
      const out = await doctorOutputWith(
        { allowedHosts: ["mcp.example.com"], allowedIps: ["10.0.0.0/8"] },
        "0.0.0.0",
      );
      expect(out).toMatch(/Host allow list: mcp\.example\.com/);
      expect(out).toMatch(/Client IP allow list: 10\.0\.0\.0\/8/);
    });

    it("fails on a malformed client IP entry", async () => {
      const out = await doctorOutputWith({ allowedIps: ["10.0.0.0/99"] }, "127.0.0.1");
      expect(out).toMatch(/MIKROMCP_HTTP_ALLOWED_IPS/);
    });
  });
});
