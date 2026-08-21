import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHarness,
  chrConnection,
  pairConnection,
  pairEnabled,
  ITEST_ROUTER_ID,
  ITEST_PAIR_ROUTER_ID,
} from "./helpers/harness.js";
import { executeToolCall, type ToolExecutorDeps } from "../../src/mcp/tool-executor.js";
import { allTools } from "../../src/domain/tools/index.js";
import { RouterRegistry } from "../../src/config/router-registry.js";
import { IdentityRegistry } from "../../src/config/identity-registry.js";
import { ConnectionPool } from "../../src/adapter/connection-pool.js";
import type { ToolDefinition } from "../../src/domain/tools/tool-definition.js";

// Requires the second CHR: docker compose --profile pair up -d, then run with
// MIKROMCP_ITEST_PAIR=1. Without it, this whole file is skipped.
describe.skipIf(!pairEnabled)("fleet operations across two live CHRs", () => {
  // Created in beforeAll so a skipped suite allocates nothing at collection time.
  let harness: ReturnType<typeof createHarness> | undefined;
  let pairHarness: ReturnType<typeof createHarness> | undefined;

  function tool(name: string): ToolDefinition {
    const found = allTools.find((t) => t.name === name);
    if (!found) throw new Error(`Unknown tool: ${name}`);
    return found;
  }

  let deps: ToolExecutorDeps | undefined;

  beforeAll(() => {
    if (!pairEnabled) return; // Guard: don't allocate resources if suite is skipped
    harness = createHarness();
    pairHarness = createHarness({ routerId: ITEST_PAIR_ROUTER_ID, ...pairConnection });
    const configDir = mkdtempSync(join(tmpdir(), "mikromcp-itest-pair-"));
    const configPath = join(configDir, "routers.yaml");
    const routerYaml = (id: string, conn: { host: string; httpPort: number; sshPort: number }) =>
      [
        `  ${id}:`,
        `    host: "${conn.host}"`,
        `    port: ${conn.httpPort}`,
        "    tls: { enabled: false, rejectUnauthorized: true }",
        `    credentials: { source: "env", envPrefix: "ROUTER_ITEST" }`,
        `    tags: ["itest", "pair"]`,
        `    rosVersion: "7"`,
        `    sshPort: ${conn.sshPort}`,
      ].join("\n");
    writeFileSync(
      configPath,
      [
        "routers:",
        routerYaml(ITEST_ROUTER_ID, chrConnection),
        routerYaml(ITEST_PAIR_ROUTER_ID, pairConnection),
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

  afterAll(() => {
    // Guarded: a beforeAll failure must not be masked by a teardown TypeError.
    deps?.pool.closeAll();
    pairHarness?.close();
    harness?.close();
  });

  it("the second router answers on its own identity", async () => {
    if (!pairHarness) throw new Error("pairHarness not initialized");
    const result = await tool("get_system_status").handler({}, pairHarness.context);

    expect(result.structuredContent.routerId).toBe(ITEST_PAIR_ROUTER_ID);
  });

  it("list_routers reports both routers", async () => {
    const response = await executeToolCall(tool("list_routers"), {}, deps!);

    expect(response.isError).toBeUndefined();
    const routers = (response.structuredContent as { routers: Array<{ id: string }> }).routers;
    expect(routers.map((r) => r.id).sort()).toEqual([ITEST_ROUTER_ID, ITEST_PAIR_ROUTER_ID]);
  });

  it("bulk_execute fans a read tool out to both routers by tag", async () => {
    const response = await executeToolCall(
      tool("bulk_execute"),
      { toolName: "get_system_status", tags: ["pair"], params: {} },
      deps!,
    );

    expect(response.isError).toBeUndefined();
    const sc = response.structuredContent as {
      succeeded: number;
      failed: number;
      results: Array<{ routerId: string; status: string }>;
    };
    expect(sc.succeeded).toBe(2);
    expect(sc.failed).toBe(0);
    expect(sc.results.map((r) => r.routerId).sort()).toEqual([
      ITEST_ROUTER_ID,
      ITEST_PAIR_ROUTER_ID,
    ]);
  });
});
