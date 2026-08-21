import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, chrConnection, liveResource, ITEST_ROUTER_ID } from "./helpers/harness.js";
import { executeToolCall, type ToolExecutorDeps } from "../../src/mcp/tool-executor.js";
import { allTools } from "../../src/domain/tools/index.js";
import { RouterRegistry } from "../../src/config/router-registry.js";
import { IdentityRegistry } from "../../src/config/identity-registry.js";
import { ConnectionPool } from "../../src/adapter/connection-pool.js";
import type { ToolDefinition } from "../../src/domain/tools/tool-definition.js";

const harness = createHarness();

const NAME = "executor.mikromcp.invalid";

function tool(name: string): ToolDefinition {
  const found = allTools.find((t) => t.name === name);
  if (!found) throw new Error(`Unknown tool: ${name}`);
  return found;
}

let deps: ToolExecutorDeps;

const { removeLeftover } = liveResource(harness.context, "ip/dns/static", { name: NAME });

beforeAll(async () => {
  await removeLeftover();

  const configDir = mkdtempSync(join(tmpdir(), "mikromcp-itest-executor-"));
  const configPath = join(configDir, "routers.yaml");
  writeFileSync(
    configPath,
    [
      "routers:",
      `  ${ITEST_ROUTER_ID}:`,
      `    host: "${chrConnection.host}"`,
      `    port: ${chrConnection.httpPort}`,
      "    tls: { enabled: false, rejectUnauthorized: true }",
      `    credentials: { source: "env", envPrefix: "ROUTER_ITEST" }`,
      `    tags: ["itest"]`,
      `    rosVersion: "7"`,
      `    sshPort: ${chrConnection.sshPort}`,
      "",
    ].join("\n"),
  );

  deps = {
    registry: new RouterRegistry(configPath),
    pool: new ConnectionPool(),
    circuitBreakers: new Map(),
    config: harness.context.appConfig,
    identityRegistry: new IdentityRegistry(join(configDir, "identities.yaml")),
  };
});

afterAll(async () => {
  await removeLeftover();
  deps.pool.closeAll();
  harness.close();
});

describe("tool executor against live CHR", () => {
  it("runs a read tool through the full stack (retry + circuit breaker)", async () => {
    const response = await executeToolCall(tool("get_system_status"), {}, deps);

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text.length).toBeGreaterThan(0);
    expect(deps.circuitBreakers.has(ITEST_ROUTER_ID)).toBe(true);
  });

  it("runs a write tool, taking a snapshot and journaling the attempt", async () => {
    const response = await executeToolCall(
      tool("manage_dns_entry"),
      { action: "add", name: NAME, address: "192.0.2.77" },
      deps,
    );

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toContain(NAME);

    const { snapshotDir, journalPath } = harness.context.appConfig;
    expect(readdirSync(snapshotDir).length).toBeGreaterThan(0);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("returns a typed NOT_FOUND error for an unknown router", async () => {
    const response = await executeToolCall(
      tool("get_system_status"),
      { routerId: "no-such-router" },
      deps,
    );

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("no-such-router");
    const error = response.structuredContent as Record<string, unknown>;
    expect(error.code).toBe("ROUTER_NOT_FOUND");
    expect(error.category).toBe("NOT_FOUND");
    expect((error.details as Record<string, unknown>).availableRouters).toContain(ITEST_ROUTER_ID);
  });
});
