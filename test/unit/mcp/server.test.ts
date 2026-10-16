import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerFactory, SERVER_INSTRUCTIONS } from "../../../src/mcp/server.js";
import type { AppConfig } from "../../../src/config/app-config.js";
import type { IdentityRegistry } from "../../../src/config/identity-registry.js";

function makeConfig(): AppConfig {
  return {
    transport: "stdio",
    port: 3000,
    bindHost: "127.0.0.1",
    logLevel: "info",
    configPath: join(tmpdir(), "mikromcp-nonexistent-routers.yaml"),
    defaultRouter: undefined,
    dataDir: "data",
    snapshotDir: "data/snapshots",
    journalPath: "data/write-journal.ndjson",
    cmdAllow: [],
    cmdDeny: [],
    identitiesPath: join(tmpdir(), "mikromcp-nonexistent-identities.yaml"),
    stdioIdentity: undefined,
    confirmationSecret: undefined,
    auditLogPath: undefined,
    http: { maxBodyBytes: 1048576, rateLimitRpm: 60 },
    ssh: { commandTimeoutMs: 30000, maxOutputBytes: 524288 },
    retry: { maxRetries: 3, baseDelayMs: 200, maxDelayMs: 5000 },
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30000 },
    retention: { snapshotMaxAgeDays: 30 },
    configSecrets: {},
    passwordSecrets: {},
  };
}

const identityRegistry = { getIdentities: () => [] } as unknown as IdentityRegistry;

describe("SERVER_INSTRUCTIONS", () => {
  it("is a non-empty, concise always-on nudge", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(0);
    // Keep it small — it is sent on every session.
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(700);
  });

  it("covers the core safety guidance", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/dryRun/);
    expect(SERVER_INSTRUCTIONS).toMatch(/confirmation token/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/run_command/);
    expect(SERVER_INSTRUCTIONS).toMatch(/skill/i);
  });
});

describe("createServerFactory", () => {
  it("passes SERVER_INSTRUCTIONS to the McpServer initialize options", () => {
    const factory = createServerFactory(makeConfig(), identityRegistry);
    const server = factory.makeServer();

    // The underlying low-level Server stores instructions privately; assert it
    // received our string rather than reaching into SDK internals by name.
    const instructions = (server.server as unknown as { _instructions?: string })._instructions;
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it("registers the WireGuard peer object schema with native confirmation support", () => {
    const register = vi.spyOn(McpServer.prototype, "registerTool");
    try {
      const factory = createServerFactory(makeConfig(), identityRegistry);
      const server = factory.makeServer();
      const registration = register.mock.calls.find(([name]) => name === "manage_wireguard_peer");
      expect(registration).toBeDefined();
      const schema = registration?.[1].inputSchema;
      expect(schema).toBeInstanceOf(z.ZodObject);
      expect(
        (schema as z.ZodObject<z.ZodRawShape>).parse({
          routerId: "test-router",
          action: "remove",
          interface: "wg0",
          publicKey: "test-key",
          endpoint: "https://old.invalid",
          confirmationToken: "test-confirmation",
        }),
      ).toMatchObject({ confirmationToken: "test-confirmation" });
      void server.close();
    } finally {
      register.mockRestore();
    }
  });

  it("builds a server without throwing when config paths are absent", () => {
    const factory = createServerFactory(makeConfig(), identityRegistry);
    expect(() => factory.makeServer()).not.toThrow();
  });
});
