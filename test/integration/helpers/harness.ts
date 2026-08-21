import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionPool } from "../../../src/adapter/connection-pool.js";
import { buildRouterToolContext } from "../../../src/mcp/tool-context.js";
import { allTools } from "../../../src/domain/tools/index.js";
import type { ToolContext, ToolResult } from "../../../src/domain/tools/tool-definition.js";
import type { AppConfig } from "../../../src/config/app-config.js";
import type { Identity, RouterConfig, RouterOSRecord } from "../../../src/types.js";

import { chrConnection } from "./targets.js";

export { chrConnection, pairConnection, pairEnabled } from "./targets.js";

export const ITEST_ROUTER_ID = "itest";
export const ITEST_PAIR_ROUTER_ID = "itest2";

export interface IntegrationHarness {
  context: ToolContext;
  close: () => void;
}

export interface HarnessTarget {
  routerId: string;
  host: string;
  httpPort: number;
  sshPort: number;
}

/**
 * Assemble a real per-router ToolContext against the live CHR container, going
 * through the same `buildRouterToolContext` path the tool executor uses —
 * credentials resolved from env, REST client from the connection pool.
 */
export function createHarness(
  target: HarnessTarget = { routerId: ITEST_ROUTER_ID, ...chrConnection },
): IntegrationHarness {
  process.env.ROUTER_ITEST_USER = "admin";
  process.env.ROUTER_ITEST_PASS = chrConnection.password;

  const dataDir = mkdtempSync(join(tmpdir(), "mikromcp-itest-"));
  const appConfig: AppConfig = {
    transport: "stdio",
    port: 3000,
    bindHost: "127.0.0.1",
    logLevel: "error",
    configPath: "",
    defaultRouter: ITEST_ROUTER_ID,
    dataDir,
    snapshotDir: join(dataDir, "snapshots"),
    journalPath: join(dataDir, "write-journal.ndjson"),
    cmdAllow: [],
    cmdDeny: [],
    identitiesPath: "",
    stdioIdentity: undefined,
    confirmationSecret: undefined,
    auditLogPath: undefined,
    http: { maxBodyBytes: 1024 * 1024, rateLimitRpm: 0 },
    ssh: { commandTimeoutMs: 30_000, maxOutputBytes: 512 * 1024 },
    retry: { maxRetries: 3, baseDelayMs: 200, maxDelayMs: 5_000 },
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000 },
    retention: { snapshotMaxAgeDays: 30 },
  };

  const routerConfig: RouterConfig = {
    id: target.routerId,
    host: target.host,
    port: target.httpPort,
    tls: { enabled: false, rejectUnauthorized: true },
    credentials: { source: "env", envPrefix: "ROUTER_ITEST" },
    tags: ["itest"],
    rosVersion: "7",
    sshPort: target.sshPort,
  };

  const identity: Identity = {
    id: "integration-test",
    role: "superadmin",
    allowedRouters: [],
    allowedToolPatterns: [],
  };

  const pool = new ConnectionPool();
  const context = buildRouterToolContext({
    routerConfig,
    correlationId: "itest",
    identity,
    pool,
    config: appConfig,
  });

  return {
    context,
    close: () => {
      pool.closeAll();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Find/cleanup pair for the one live resource a suite creates: `find` locates
 * it on the router, `removeLeftover` deletes it if a previous run left it
 * behind — every write suite runs `removeLeftover` in beforeAll and afterAll.
 */
export function liveResource(
  context: ToolContext,
  path: string,
  filter: Record<string, string>,
  match?: (record: RouterOSRecord) => boolean,
): { find: () => Promise<RouterOSRecord | undefined>; removeLeftover: () => Promise<void> } {
  const find = async (): Promise<RouterOSRecord | undefined> => {
    const records = await context.routerClient.get<RouterOSRecord>(path, { filter });
    return match ? records.find(match) : records[0];
  };
  const removeLeftover = async (): Promise<void> => {
    const existing = await find();
    if (existing) {
      await context.routerClient.remove(path, existing[".id"]);
    }
  };
  return { find, removeLeftover };
}

/** Invoke a tool handler by name, the way the executor does after validation. */
export async function runTool(
  context: ToolContext,
  name: string,
  params: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = allTools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.handler({ ...params }, context);
}
