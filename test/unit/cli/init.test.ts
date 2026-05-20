import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { parse as yamlParse } from "yaml";

// ---------------------------------------------------------------------------
// We test the internal helper logic extracted from init.ts by re-implementing
// minimal versions here, and test the full runInit() flow by mocking all I/O.
// ---------------------------------------------------------------------------

// Mock @inquirer/prompts before importing init
vi.mock("@inquirer/prompts", () => ({
  input: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
}));

// Mock chalk to be transparent (no ANSI codes in test output)
vi.mock("chalk", () => {
  const noop = (s: unknown) => String(s);
  const tagged = new Proxy(noop, {
    get: (_t, _p) => tagged,
  }) as unknown as typeof import("chalk").default;
  return { default: tagged };
});

// Mock bcryptjs
vi.mock("bcryptjs", () => ({
  default: {
    hash: vi.fn().mockResolvedValue("$2a$12$mockhash"),
  },
}));

// Mock node:crypto
vi.mock("node:crypto", () => ({
  randomBytes: vi.fn().mockReturnValue(Buffer.from("a".repeat(32))),
}));

// node:os — mock homedir so the Claude Desktop test can redirect it to a tmpDir
const mockHomedirRef = vi.hoisted(() => ({ value: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomedirRef.value };
});

// node:fs is NOT mocked globally — we use a real tmpdir for file operations.
// Individual tests control paths via the tmpdir.

import * as inquirer from "@inquirer/prompts";
import bcrypt from "bcryptjs";

// We can't easily mock node:fs at module-level without affecting everything.
// Instead we test the module with real FS in a temp directory, and redirect
// process.cwd() via a spy.

const mockInput = vi.mocked(inquirer.input);
const mockConfirm = vi.mocked(inquirer.confirm);
const mockSelect = vi.mocked(inquirer.select);

// Helper: create a temp project directory
function makeTempProject() {
  return mkdtempSync(join(tmpdir(), "mikromcp-test-"));
}

// configDir and envPath are always derived from homedir() → ~/.mikromcp/
// Tests set mockHomedirRef.value = tmpDir so all paths land in the temp directory.

function setupRouterOnlyPrompts() {
  mockInput
    .mockResolvedValueOnce("core-01")
    .mockResolvedValueOnce("192.168.1.1")
    .mockResolvedValueOnce("80")
    .mockResolvedValueOnce("ROUTER_CORE_01")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("7");

  mockConfirm
    .mockResolvedValueOnce(false)  // tls
    .mockResolvedValueOnce(false)  // createIdentity
    .mockResolvedValueOnce(false)  // writeEnv
    .mockResolvedValueOnce(false); // claudeDesktop
}

describe("runInit — router-only flow", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = makeTempProject();
    mockHomedirRef.value = tmpDir;
    setupRouterOnlyPrompts();
  });

  it("writes ~/.mikromcp/routers.yaml with correct structure", async () => {
    const { runInit } = await import("../../../src/cli/init.js");
    await runInit();

    const routersPath = join(tmpDir, ".mikromcp", "routers.yaml");
    expect(existsSync(routersPath)).toBe(true);

    const parsed = yamlParse(readFileSync(routersPath, "utf-8")) as {
      routers: Record<string, unknown>;
    };
    expect(parsed.routers["core-01"]).toMatchObject({
      host: "192.168.1.1",
      port: 80,
      tls: { enabled: false, rejectUnauthorized: true },
      credentials: { source: "env", envPrefix: "ROUTER_CORE_01" },
      tags: [],
      rosVersion: "7",
    });
  });

  it("does not create identities.yaml when identity not requested", async () => {
    const { runInit } = await import("../../../src/cli/init.js");
    await runInit();

    expect(existsSync(join(tmpDir, ".mikromcp", "identities.yaml"))).toBe(false);
  });

  it("does not create .env when writeEnv is declined", async () => {
    const { runInit } = await import("../../../src/cli/init.js");
    await runInit();

    expect(existsSync(join(tmpDir, ".mikromcp", ".env"))).toBe(false);
  });
});

describe("runInit — identity creation", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = makeTempProject();
    mockHomedirRef.value = tmpDir;

    mockInput
      .mockResolvedValueOnce("edge-01")
      .mockResolvedValueOnce("10.0.0.1")
      .mockResolvedValueOnce("443")
      .mockResolvedValueOnce("ROUTER_EDGE01")
      .mockResolvedValueOnce("edge")
      .mockResolvedValueOnce("7.14")
      .mockResolvedValueOnce("claude")
      .mockResolvedValueOnce("*")
      .mockResolvedValueOnce("*");

    mockSelect.mockResolvedValueOnce("operator");

    mockConfirm
      .mockResolvedValueOnce(true)   // tlsEnabled
      .mockResolvedValueOnce(true)   // rejectUnauthorized
      .mockResolvedValueOnce(true)   // createIdentity
      .mockResolvedValueOnce(false)  // writeEnv
      .mockResolvedValueOnce(false); // claudeDesktop
  });

  it("writes ~/.mikromcp/identities.yaml with bcrypt hash", async () => {
    const { runInit } = await import("../../../src/cli/init.js");
    await runInit();

    const identitiesPath = join(tmpDir, ".mikromcp", "identities.yaml");
    expect(existsSync(identitiesPath)).toBe(true);

    const parsed = yamlParse(readFileSync(identitiesPath, "utf-8")) as {
      identities: Record<string, { token: string; role: string }>;
    };
    expect(parsed.identities["claude"]).toMatchObject({
      token: "$2a$12$mockhash",
      role: "operator",
      allowedRouters: ["*"],
      allowedToolPatterns: ["*"],
    });
  });

  it("calls bcrypt.hash with the generated token and cost 12", async () => {
    const { runInit } = await import("../../../src/cli/init.js");
    await runInit();

    expect(bcrypt.hash).toHaveBeenCalledWith(expect.any(String), 12);
  });
});

describe("runInit — .env write path", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = makeTempProject();
    mockHomedirRef.value = tmpDir;

    mockInput
      .mockResolvedValueOnce("home-gw")
      .mockResolvedValueOnce("192.168.88.1")
      .mockResolvedValueOnce("80")
      .mockResolvedValueOnce("ROUTER_HOME_GW")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("7");

    mockConfirm
      .mockResolvedValueOnce(false)  // tls
      .mockResolvedValueOnce(false)  // createIdentity
      .mockResolvedValueOnce(true)   // writeEnv → YES
      .mockResolvedValueOnce(false); // claudeDesktop
  });

  it("writes ~/.mikromcp/.env with USER and PASS placeholders", async () => {
    const { runInit } = await import("../../../src/cli/init.js");
    await runInit();

    const envPath = join(tmpDir, ".mikromcp", ".env");
    expect(existsSync(envPath)).toBe(true);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("ROUTER_HOME_GW_USER=");
    expect(content).toContain("ROUTER_HOME_GW_PASS=");
  });
});

describe("runInit — Claude Desktop registration", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = makeTempProject();
    mockHomedirRef.value = tmpDir;

    mockInput
      .mockResolvedValueOnce("wan-01")
      .mockResolvedValueOnce("10.1.1.1")
      .mockResolvedValueOnce("80")
      .mockResolvedValueOnce("ROUTER_WAN_01")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("7");

    mockConfirm
      .mockResolvedValueOnce(false)  // tls
      .mockResolvedValueOnce(false)  // createIdentity
      .mockResolvedValueOnce(false)  // writeEnv
      .mockResolvedValueOnce(true);  // claudeDesktop → YES
  });

  it("patches claude_desktop_config.json and creates a backup", async () => {
    // Create the expected Claude Desktop config path under the fake homedir
    const fakeConfigDir = join(tmpDir, "Library", "Application Support", "Claude");
    const { mkdirSync: fsMkdir, writeFileSync: fsWrite } = await import("node:fs");
    fsMkdir(fakeConfigDir, { recursive: true });
    const fakeConfigPath = join(fakeConfigDir, "claude_desktop_config.json");
    fsWrite(fakeConfigPath, JSON.stringify({ mcpServers: {} }, null, 2));

    const { runInit } = await import("../../../src/cli/init.js");
    await runInit();

    // Config should have been patched
    const updatedRaw = readFileSync(fakeConfigPath, "utf-8");
    const updated = JSON.parse(updatedRaw) as {
      mcpServers: Record<string, unknown>;
    };
    expect(updated.mcpServers["mikromcp"]).toMatchObject({
      command: "mikromcp",
      args: ["serve"],
    });

    // A backup file should exist
    const files = (await import("node:fs")).readdirSync(fakeConfigDir);
    const backups = files.filter((f) =>
      f.startsWith("claude_desktop_config.json.backup-"),
    );
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });
});

describe("runInit — existing routers.yaml merge", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = makeTempProject();
    mockHomedirRef.value = tmpDir;

    mockInput
      .mockResolvedValueOnce("new-router")
      .mockResolvedValueOnce("10.0.0.2")
      .mockResolvedValueOnce("80")
      .mockResolvedValueOnce("ROUTER_NEW")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("7");

    mockConfirm
      .mockResolvedValueOnce(false)  // tls
      .mockResolvedValueOnce(false)  // createIdentity
      .mockResolvedValueOnce(false)  // writeEnv
      .mockResolvedValueOnce(true)   // merge into existing? → YES
      .mockResolvedValueOnce(false); // claudeDesktop
  });

  it("adds new router to existing routers.yaml without overwriting existing entry", async () => {
    const configDir = join(tmpDir, ".mikromcp");
    const { mkdirSync: fsMkdir, writeFileSync: fsWrite } = await import("node:fs");
    fsMkdir(configDir, { recursive: true });
    const existingYaml = `routers:\n  old-router:\n    host: "1.2.3.4"\n    port: 443\n    tls:\n      enabled: true\n      rejectUnauthorized: true\n    credentials:\n      source: env\n      envPrefix: ROUTER_OLD\n    tags: []\n    rosVersion: "7"\n`;
    fsWrite(join(configDir, "routers.yaml"), existingYaml);

    const { runInit } = await import("../../../src/cli/init.js");
    await runInit();

    const routersPath = join(configDir, "routers.yaml");
    const parsed = yamlParse(readFileSync(routersPath, "utf-8")) as {
      routers: Record<string, unknown>;
    };

    expect(parsed.routers["old-router"]).toBeDefined();
    expect((parsed.routers["old-router"] as { host: string }).host).toBe("1.2.3.4");

    // New router added
    expect(parsed.routers["new-router"]).toBeDefined();
    expect((parsed.routers["new-router"] as { host: string }).host).toBe("10.0.0.2");
  });
});
