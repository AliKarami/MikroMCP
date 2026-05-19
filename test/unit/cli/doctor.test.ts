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

vi.mock("../../../src/config/router-registry.js", () => ({
  RouterRegistry: vi.fn(),
}));

vi.mock("../../../src/config/secrets.js", () => ({
  getCredentials: vi.fn(),
}));

vi.mock("../../../src/adapter/rest-client.js", () => ({
  RouterOSRestClient: vi.fn(),
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

vi.mock("node:net", () => ({
  createConnection: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock/home"),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import * as fsModule from "node:fs";
import * as netModule from "node:net";
import { RouterRegistry } from "../../../src/config/router-registry.js";
import { getCredentials } from "../../../src/config/secrets.js";
import { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { IdentityRegistry } from "../../../src/config/identity-registry.js";
import { loadAppConfig } from "../../../src/config/app-config.js";

const MockRouterRegistry = vi.mocked(RouterRegistry);
const mockGetCredentials = vi.mocked(getCredentials);
const MockRouterOSRestClient = vi.mocked(RouterOSRestClient);
const MockIdentityRegistry = vi.mocked(IdentityRegistry);
const mockLoadAppConfig = vi.mocked(loadAppConfig);
const mockExistsSync = vi.mocked(fsModule.existsSync);
const mockReadFileSync = vi.mocked(fsModule.readFileSync);
const mockCreateConnection = vi.mocked(netModule.createConnection);

// ─── Test router fixture ─────────────────────────────────────────────────────

function makeRouter(overrides: Partial<{ id: string; host: string; sshPort?: number }> = {}) {
  return {
    id: overrides.id ?? "core-01",
    host: overrides.host ?? "192.168.1.1",
    port: 443,
    tls: { enabled: true, rejectUnauthorized: false },
    credentials: { source: "env" as const, envPrefix: "ROUTER_CORE01" },
    tags: [],
    rosVersion: "7.14",
    sshPort: overrides.sshPort,
  };
}

function makeAppConfig(overrides: Partial<{ transport: "stdio" | "http"; configPath: string; identitiesPath: string; confirmationSecret?: string }> = {}) {
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
    http: { maxBodyBytes: 1048576, rateLimitRpm: 60 },
    ssh: { commandTimeoutMs: 30000, maxOutputBytes: 524288 },
    retry: { maxRetries: 3, baseDelayMs: 200, maxDelayMs: 5000 },
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30000 },
    pagination: { defaultLimit: 100, maxLimit: 500 },
  };
}

// TCP probe returns connected socket mock
function makeTcpSocket(connectImmediately = true) {
  const socket: Record<string, unknown> = {
    on: vi.fn(),
    destroy: vi.fn(),
  };
  if (connectImmediately) {
    (socket.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: () => void) => {
        if (event === "connect") setTimeout(cb, 0);
        return socket;
      },
    );
  } else {
    (socket.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: () => void) => {
        if (event === "error") setTimeout(cb, 0);
        return socket;
      },
    );
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
      MockRouterRegistry.mockImplementation(() => ({ listRouters: () => [] } as unknown as RouterRegistry));

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
      MockRouterRegistry.mockImplementation(() => ({ listRouters: () => [] } as unknown as RouterRegistry));

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/❌.*Config file not found/);
      expect(process.exitCode).toBe(1);
    });

    it("reports success with router count when config is valid", async () => {
      const router = makeRouter();
      mockExistsSync.mockImplementation(() => true);
      MockRouterRegistry.mockImplementation(
        () =>
          ({
            listRouters: () => [router],
          }) as unknown as RouterRegistry,
      );
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

      mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: { "mikrotik-mcp-server": {} } }));

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/✅.*Config.*1 router/);
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

  describe("Router connectivity", () => {
    it("reports success for reachable router with read policy", async () => {
      const router = makeRouter({ host: "10.0.0.1" });
      mockExistsSync.mockReturnValue(true);
      MockRouterRegistry.mockImplementation(
        () =>
          ({
            listRouters: () => [router],
          }) as unknown as RouterRegistry,
      );
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
      mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: { "mikrotik-mcp-server": {} } }));

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
      MockRouterRegistry.mockImplementation(
        () =>
          ({
            listRouters: () => [router],
          }) as unknown as RouterRegistry,
      );
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
      MockRouterRegistry.mockImplementation(
        () =>
          ({
            listRouters: () => [router],
          }) as unknown as RouterRegistry,
      );
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
      mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: { "mikrotik-mcp-server": {} } }));

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/⚠️.*SSH not reachable on port 2222/);
    });
  });

  describe("Claude Desktop check", () => {
    it("reports registered when mikrotik-mcp-server key present", async () => {
      mockExistsSync.mockReturnValue(true);
      MockRouterRegistry.mockImplementation(
        () => ({ listRouters: () => [] }) as unknown as RouterRegistry,
      );
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
      MockRouterRegistry.mockImplementation(
        () => ({ listRouters: () => [] }) as unknown as RouterRegistry,
      );
      MockIdentityRegistry.mockImplementation(
        () => ({ getIdentities: () => [] }) as unknown as IdentityRegistry,
      );
      mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: {} }));

      const { runDoctor } = await import("../../../src/cli/doctor.js");
      await runDoctor();

      const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/⚠️.*not registered/);
      expect(allOutput).toMatch(/mikrotik-mcp-server/);
    });
  });

  describe("Update check", () => {
    it("reports up to date when versions match", async () => {
      mockExistsSync.mockReturnValue(false);
      MockRouterRegistry.mockImplementation(
        () => ({ listRouters: () => [] }) as unknown as RouterRegistry,
      );
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
      MockRouterRegistry.mockImplementation(
        () => ({ listRouters: () => [] }) as unknown as RouterRegistry,
      );
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
      MockRouterRegistry.mockImplementation(
        () => ({ listRouters: () => [] }) as unknown as RouterRegistry,
      );
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

  describe("HTTP mode checks", () => {
    it("warns when MIKROMCP_CONFIRMATION_SECRET not set in HTTP mode", async () => {
      mockLoadAppConfig.mockReturnValue(
        makeAppConfig({ transport: "http", confirmationSecret: undefined }) as ReturnType<typeof loadAppConfig>,
      );
      const router = makeRouter();
      mockExistsSync.mockReturnValue(true);
      MockRouterRegistry.mockImplementation(
        () => ({ listRouters: () => [router] }) as unknown as RouterRegistry,
      );
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
  });
});
