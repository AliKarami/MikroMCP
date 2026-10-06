import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diagnosticTools, formatBps } from "../../../src/domain/tools/diagnostic-tools.js";
import { withRetry } from "../../../src/adapter/retry-engine.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import { HttpError, type RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { lastSection } from "../../../src/adapter/response-parser.js";
import type { RouterConfig } from "../../../src/types.js";
import { enrichError } from "../../../src/domain/errors/error-enricher.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";

const pingTool = diagnosticTools[0];
const tracerouteTool = diagnosticTools[1];
const torchTool = diagnosticTools[2];

type RestRecord = Record<string, string>;

// Real RouterOS REST responses; see the `_comment` in each file.
function restFixture(name: string): { request: RestRecord; response: RestRecord[] } {
  const path = join(import.meta.dirname, "../../fixtures/routeros-rest", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as { request: RestRecord; response: RestRecord[] };
}

function sessionClosedError(): HttpError {
  return new HttpError(
    400,
    JSON.stringify({ detail: "Session closed", error: 400, message: "Bad Request" }),
  );
}

function makeRouterConfig(): RouterConfig {
  return {
    id: "test-router",
    host: "192.168.1.1",
    port: 443,
    tls: { enabled: true, rejectUnauthorized: false },
    credentials: { source: "env", envPrefix: "ROUTER_TEST" },
    tags: [],
    rosVersion: "7",
  };
}

function makeContext(sshOutput = "", restResult: unknown = []): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: makeRouterConfig(),
    identity: {
      id: "superadmin-builtin",
      role: "superadmin" as const,
      allowedRouters: [],
      allowedToolPatterns: [],
    },
    sshClient: { execute: vi.fn().mockResolvedValue(sshOutput) } as unknown as SshClient,
    ftpClient: {
      upload: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
    } as unknown as FtpClient,
    routerClient: {
      // Progress-reporting commands must go through executeFinal, never raw execute.
      execute: vi.fn().mockRejectedValue(new Error("unexpected raw execute() call")),
      executeFinal: vi.fn(async () => lastSection(restResult as RestRecord[])),
      get: vi.fn().mockResolvedValue([]),
    } as unknown as RouterOSRestClient,
  };
}

const pingInputSchema = pingTool.inputSchema;

describe("diagnostic tools", () => {
  describe("control character validation", () => {
    it.each([
      ["ping address", pingTool, { routerId: "test-router", address: "host\n:put owned" }],
      [
        "ping routing table",
        pingTool,
        { routerId: "test-router", address: "127.0.0.1", routingTable: "main\towned" },
      ],
      [
        "traceroute address",
        tracerouteTool,
        { routerId: "test-router", address: "host\r:put owned" },
      ],
      [
        "torch interface",
        diagnosticTools[2],
        { routerId: "test-router", interface: "ether1\n:put owned" },
      ],
      [
        "torch source address",
        diagnosticTools[2],
        { routerId: "test-router", interface: "ether1", srcAddress: "10.0.0.0/8\towned" },
      ],
      [
        "torch destination address",
        diagnosticTools[2],
        { routerId: "test-router", interface: "ether1", dstAddress: "10.0.0.1\u007fowned" },
      ],
    ])("classifies %s as validation before any router call", async (_label, tool, params) => {
      const ctx = makeContext();
      let thrown: unknown;

      try {
        await tool.handler(params, ctx);
      } catch (err) {
        thrown = err;
      }

      expect(enrichError(thrown)).toMatchObject({
        category: ErrorCategory.VALIDATION,
        code: "VALIDATION_ERROR",
      });
      expect(ctx.sshClient.execute).not.toHaveBeenCalled();
      expect(ctx.routerClient.executeFinal).not.toHaveBeenCalled();
    });
  });

  describe("metadata", () => {
    it("exports at least 2 tools: ping and traceroute as first two", () => {
      expect(diagnosticTools.length).toBeGreaterThanOrEqual(2);
      expect(pingTool.name).toBe("ping");
      expect(tracerouteTool.name).toBe("traceroute");
    });

    it("ping has correct annotations", () => {
      expect(pingTool.annotations.readOnlyHint).toBe(true);
      expect(pingTool.annotations.destructiveHint).toBe(false);
      expect(pingTool.annotations.idempotentHint).toBe(true);
    });

    it("traceroute has correct annotations", () => {
      expect(tracerouteTool.annotations.readOnlyHint).toBe(true);
      expect(tracerouteTool.annotations.destructiveHint).toBe(false);
    });

    it("traceroute and torch opt out of auto-retry (each run can take up to a minute)", () => {
      expect(tracerouteTool.retryable).toBe(false);
      expect(torchTool.retryable).toBe(false);
    });
  });

  describe("ping input schema", () => {
    it("accepts minimal input with defaults", () => {
      const r = pingInputSchema.parse({ routerId: "r", address: "8.8.8.8" });
      expect(r.count).toBe(4);
      expect(r.size).toBe(56);
    });

    it("rejects count > 20", () => {
      expect(() =>
        pingInputSchema.parse({ routerId: "r", address: "8.8.8.8", count: 21 }),
      ).toThrow();
    });

    it("rejects size < 14", () => {
      expect(() =>
        pingInputSchema.parse({ routerId: "r", address: "8.8.8.8", size: 13 }),
      ).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() =>
        pingInputSchema.parse({ routerId: "r", address: "8.8.8.8", unknown: true }),
      ).toThrow();
    });
  });

  describe("traceroute input schema (the tool's real schema)", () => {
    const schema = tracerouteTool.inputSchema;
    const base = { routerId: "r", address: "8.8.8.8" };

    it("defaults count to 3 and maxHops to 15", () => {
      expect(schema.parse(base)).toMatchObject({ count: 3, maxHops: 15 });
    });

    it.each([
      ["count", 1],
      ["count", 5],
      ["maxHops", 1],
      ["maxHops", 30],
    ])("accepts %s = %i (inclusive bound)", (field, value) => {
      expect(schema.safeParse({ ...base, [field]: value }).success).toBe(true);
    });

    it.each([
      ["count", 0],
      ["count", 6],
      ["count", 2.5],
      ["maxHops", 0],
      ["maxHops", 31],
    ])("rejects %s = %s", (field, value) => {
      expect(schema.safeParse({ ...base, [field]: value }).success).toBe(false);
    });

    it("rejects extra fields", () => {
      expect(schema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    });
  });

  describe("ping handler", () => {
    const PING_SSH_OUTPUT =
      "SEQ HOST                SIZE TTL TIME   STATUS\n" +
      "  0 8.8.8.8               56  56 10ms  echo reply\n" +
      "  1 8.8.8.8               56  56 14ms  echo reply\n" +
      "    sent=4 received=4 packet-loss=0% min-rtt=10ms avg-rtt=12ms max-rtt=15ms\n";

    it("returns RTT stats on successful ping", async () => {
      const ctx = makeContext(PING_SSH_OUTPUT);
      const result = await pingTool.handler({ routerId: "test-router", address: "8.8.8.8" }, ctx);
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("8.8.8.8");
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.routerId).toBe("test-router");
      expect(sc.avgRtt).toBe("12ms");
    });

    it("sends address, count, and size in the SSH command", async () => {
      const ctx = makeContext(PING_SSH_OUTPUT);
      await pingTool.handler(
        { routerId: "test-router", address: "10.0.0.1", count: 10, size: 128 },
        ctx,
      );
      expect(ctx.sshClient.execute).toHaveBeenCalledWith(
        '/tool ping address="10.0.0.1" count=10 size=128',
      );
    });

    it("keeps an injected routing table inside one quoted parameter", async () => {
      const ctx = makeContext(PING_SSH_OUTPUT);
      await pingTool.handler(
        {
          routerId: "test-router",
          address: "10.0.0.1",
          routingTable: 'main\"; /user add name=owned; :put $identity',
        },
        ctx,
      );

      expect(ctx.sshClient.execute).toHaveBeenCalledWith(
        '/tool ping address="10.0.0.1" count=4 size=56 routing-table="main\\\"; /user add name=owned; :put \\$identity"',
      );
    });

    it("treats 100% packet loss as a valid (non-error) response", async () => {
      const ctx = makeContext("    sent=4 received=0 packet-loss=100%\n");
      const result = await pingTool.handler(
        { routerId: "test-router", address: "10.255.255.1" },
        ctx,
      );
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("100%");
    });
  });

  describe("traceroute handler", () => {
    const redrawn = restFixture("traceroute-redrawn");
    const tooManyHops = restFixture("traceroute-too-many-hops");

    async function trace(result: unknown, params: Record<string, unknown> = {}) {
      const ctx = makeContext("", result);
      const out = await tracerouteTool.handler(
        { routerId: "test-router", address: "1.1.1.1", ...params },
        ctx,
      );
      const hops = (out.structuredContent as Record<string, unknown>).hops as Record<
        string,
        unknown
      >[];
      return { ctx, out, hops };
    }

    it("returns each hop of the final redraw once, numbered from 1", async () => {
      const { hops, out } = await trace(redrawn.response);
      // 99 records over 9 sections; the last section has the 13 final hops.
      expect(hops).toHaveLength(13);
      expect(hops.map((h) => h.hop)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
      expect(hops[12]).toMatchObject({ hop: 13, address: "1.1.1.1", loss: 0, last: 49.2 });
      expect(out.content).not.toContain("was not reached");
    });

    it('parses metrics as numbers and keeps a lost probe as "timeout"', async () => {
      const { hops } = await trace(redrawn.response);
      expect(hops[0]).toMatchObject({ address: "192.168.88.1", last: 0.3, loss: 0, sent: 2 });
      expect(hops[1]).toMatchObject({ address: null, last: "timeout", loss: 100 });
      // A partly answering hop: RouterOS keeps its address and averages, last is a timeout.
      expect(hops[7]).toMatchObject({ address: "10.0.0.5", last: "timeout", loss: 50 });
      expect(hops.every((h) => !(".section" in h))).toBe(true);
    });

    it("renders each hop with units and reports an unreached target", async () => {
      const { out } = await trace(tooManyHops.response, { maxHops: 4 });
      expect(out.content).toContain("  1  192.168.88.1  0.4ms  loss=0%");
      expect(out.content).toContain("  2  ???  timeout  loss=100%");
      expect(out.content).toContain("RouterOS: Too many hops — 1.1.1.1 was not reached");
    });

    it("POSTs address, count and max-hops with a timeout past RouterOS's 60 s limit", async () => {
      const { ctx } = await trace(redrawn.response, {
        address: "one.one.one.one",
        count: 2,
        maxHops: 10,
      });
      expect(ctx.routerClient.executeFinal).toHaveBeenCalledWith(
        "tool/traceroute",
        { address: "one.one.one.one", count: "2", "max-hops": "10" },
        { timeoutMs: 65_000 },
      );
      expect(ctx.sshClient.execute).not.toHaveBeenCalled();
    });

    it.each([
      ["missing address key", { ".section": "0", last: "1", loss: "0" }, "  1  ???  1ms  loss=0%"],
      [
        "missing last and loss",
        { ".section": "0", address: "192.0.2.1" },
        "  1  192.0.2.1  ?  loss=?",
      ],
      [
        "a RouterOS status",
        { ".section": "0", address: "192.0.2.1", last: "1", loss: "0", status: "<MPLS:L=16>" },
        "  1  192.0.2.1  1ms  loss=0%  <MPLS:L=16>",
      ],
    ])("renders a hop with %s", async (_label, record, line) => {
      const { out } = await trace([record]);
      expect(out.content.split("\n")).toContain(line);
    });

    it("reports any RouterOS error on the final hops, not only Too many hops", async () => {
      const { out } = await trace([
        { ".section": "0", address: "", last: "timeout", loss: "100", error: "no route to host" },
      ]);
      expect(out.content).toContain("RouterOS: no route to host — 1.1.1.1 was not reached");
    });

    it("returns no hops for an empty result", async () => {
      const { hops } = await trace([]);
      expect(hops).toEqual([]);
    });

    it("fails once, without retries, when RouterOS closes the 60 s REST session", async () => {
      const ctx = makeContext();
      const executeFinal = ctx.routerClient.executeFinal as ReturnType<typeof vi.fn>;
      executeFinal.mockRejectedValue(sessionClosedError());
      await expect(
        withRetry(
          () => tracerouteTool.handler({ routerId: "test-router", address: "192.0.2.1" }, ctx),
          { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 },
        ),
      ).rejects.toMatchObject({
        category: ErrorCategory.ROUTER_TIMEOUT,
        code: "REST_SESSION_CLOSED",
      });
      expect(executeFinal).toHaveBeenCalledTimes(1);
    });
  });

  describe("torch metadata and schema", () => {
    it("torch is the third tool", () => {
      expect(torchTool.name).toBe("torch");
    });

    it("torch has readOnlyHint true", () => {
      expect(torchTool.annotations.readOnlyHint).toBe(true);
    });
  });

  describe("torch input schema (the tool's real schema)", () => {
    const schema = torchTool.inputSchema;
    const base = { routerId: "r", interface: "ether1" };

    it("defaults duration to 5", () => {
      expect(schema.parse(base)).toMatchObject({ duration: 5 });
    });

    it.each([1, 30])("accepts duration = %i (inclusive bound)", (duration) => {
      expect(schema.safeParse({ ...base, duration }).success).toBe(true);
    });

    it.each([0, 31, 2.5])("rejects duration = %s", (duration) => {
      expect(schema.safeParse({ ...base, duration }).success).toBe(false);
    });

    it("rejects a missing interface and extra fields", () => {
      expect(schema.safeParse({ routerId: "r" }).success).toBe(false);
      expect(schema.safeParse({ ...base, unknown: 1 }).success).toBe(false);
    });
  });

  describe("torch handler", () => {
    const wan = restFixture("torch-wan-two-sections");
    const lan = restFixture("torch-lan-two-sections");

    async function capture(result: unknown, params: Record<string, unknown> = {}) {
      const ctx = makeContext("", result);
      const out = await torchTool.handler(
        { routerId: "test-router", interface: "ether1", ...params },
        ctx,
      );
      const flows = (out.structuredContent as Record<string, unknown>).flows as Record<
        string,
        unknown
      >[];
      return { ctx, out, flows };
    }

    it("returns the flows of the final section only", async () => {
      // Real capture: section 1 holds 6 flows, the final section 2 holds 16.
      const { flows } = await capture(wan.response);
      expect(flows).toHaveLength(16);
      expect(flows.every((f) => !(".section" in f))).toBe(true);
    });

    it("parses rates, packet rates, DSCP, VLAN and plain ports as numbers", async () => {
      const { flows } = await capture(wan.response);
      expect(flows[0]).toEqual({
        dscp: 0,
        dstAddress: "192.168.88.10",
        dstPort: 48595,
        ipProtocol: "udp",
        macProtocol: "ip",
        rx: 0,
        rxPackets: 0,
        srcAddress: "224.0.0.224",
        srcPort: 7447,
        tx: 584,
        txPackets: 1,
        vlanId: 99,
      });
    });

    it("keeps a port that RouterOS names as a string", async () => {
      const { flows, out } = await capture([
        {
          ".section": "0",
          "dst-address": "1.1.1.1",
          "dst-port": "443 (https)",
          "ip-protocol": "tcp",
          rx: "1000000",
          tx: "0",
        },
      ]);
      expect(flows[0]).toMatchObject({ dstPort: "443 (https)", rx: 1000000 });
      expect(out.content).toContain("tcp  * → 1.1.1.1:443 (https)  tx=0bps  rx=1Mbps");
    });

    it.each([
      ["IPv6 with a port", "fe80::1", "5353", "[fe80::1]:5353"],
      ["IPv6 without a port", "ff02::16", undefined, "ff02::16"],
      ["IPv4 without a port", "192.0.2.1", undefined, "192.0.2.1"],
    ])("formats an endpoint: %s", async (_label, address, port, rendered) => {
      const record: RestRecord = {
        ".section": "0",
        "ip-protocol": "udp",
        "dst-address": address,
        tx: "0",
        rx: "0",
      };
      if (port !== undefined) record["dst-port"] = port;
      const { out } = await capture([record]);
      expect(out.content).toContain(`→ ${rendered}  tx=`);
    });

    it("lists ten flows in the text but returns all of them", async () => {
      const { flows, out } = await capture(wan.response);
      expect(out.content).toContain(": 16 flows");
      expect(out.content.split("\n").filter((l) => l.includes(" → "))).toHaveLength(10);
      expect(flows).toHaveLength(16);
    });

    it("handles a LAN capture from RouterOS 7.23", async () => {
      const { flows } = await capture(lan.response);
      expect(flows).toHaveLength(3);
    });

    it.each([
      [1, 6_000],
      [10, 15_000],
      [30, 35_000],
    ])("asks RouterOS for %is and waits %i ms", async (duration, timeoutMs) => {
      const { ctx } = await capture(wan.response, {
        duration,
        srcAddress: "192.168.88.0/24",
        dstAddress: "8.8.8.8",
      });
      expect(ctx.routerClient.executeFinal).toHaveBeenCalledWith(
        "tool/torch",
        {
          interface: "ether1",
          duration: `${duration}s`,
          "src-address": "192.168.88.0/24",
          "dst-address": "8.8.8.8",
        },
        { timeoutMs },
      );
      expect(ctx.sshClient.execute).not.toHaveBeenCalled();
    });

    it("returns empty flows for an empty result (no traffic)", async () => {
      const { flows } = await capture([]);
      expect(flows).toEqual([]);
    });

    it.each([
      [
        "an unknown interface",
        new HttpError(
          400,
          JSON.stringify({ error: 400, detail: "input does not match any value of interface" }),
        ),
        { category: ErrorCategory.VALIDATION, code: "HTTP_400" },
      ],
      [
        "a missing sniff policy",
        new HttpError(500, JSON.stringify({ error: 500, detail: "not enough permissions (9)" })),
        { category: ErrorCategory.PERMISSION_DENIED, code: "HTTP_500" },
      ],
      [
        "RouterOS closing the REST session",
        sessionClosedError(),
        { category: ErrorCategory.ROUTER_TIMEOUT, code: "REST_SESSION_CLOSED" },
      ],
    ])("surfaces %s as a typed error", async (_label, error, expected) => {
      const ctx = makeContext();
      (ctx.routerClient.executeFinal as ReturnType<typeof vi.fn>).mockRejectedValue(error);
      await expect(
        torchTool.handler({ routerId: "test-router", interface: "ether9" }, ctx),
      ).rejects.toMatchObject(expected);
    });
  });

  describe("formatBps", () => {
    it.each([
      [0, "0bps"],
      [999, "999bps"],
      [1000, "1kbps"],
      [1050, "1.1kbps"],
      [999_949, "999.9kbps"],
      [999_950, "1Mbps"],
      [10_800, "10.8kbps"],
      [1_000_000_000, "1Gbps"],
      [2_500_000_000_000, "2500Gbps"],
    ])("%i bps → %s", (bps, expected) => {
      expect(formatBps(bps)).toBe(expected);
    });
  });

  describe("get_log metadata and schema", () => {
    const getLogTool = diagnosticTools[3];

    it("get_log is the fourth tool", () => {
      expect(getLogTool.name).toBe("get_log");
    });

    it("get_log has readOnlyHint true", () => {
      expect(getLogTool.annotations.readOnlyHint).toBe(true);
    });
  });

  describe("get_log input schema", () => {
    const getLogInputSchema = diagnosticTools[3].inputSchema;

    it("accepts minimal input with defaults", () => {
      const r = getLogInputSchema.parse({ routerId: "r" });
      expect(r.limit).toBe(100);
      expect(r.offset).toBe(0);
    });

    it("rejects limit > 500", () => {
      expect(() => getLogInputSchema.parse({ routerId: "r", limit: 501 })).toThrow();
    });

    it("rejects sinceMinutes > 1440", () => {
      expect(() => getLogInputSchema.parse({ routerId: "r", sinceMinutes: 1441 })).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() => getLogInputSchema.parse({ routerId: "r", unknown: 1 })).toThrow();
    });
  });

  describe("get_log handler", () => {
    const sampleEntries = [
      { ".id": "*1", time: "12:00:00", topics: "firewall,info", message: "input dropped" },
      { ".id": "*2", time: "12:01:00", topics: "dhcp,info", message: "assigned 192.168.1.10" },
      { ".id": "*3", time: "12:02:00", topics: "firewall,warning", message: "port scan detected" },
    ];

    it("returns all entries when no filters applied", async () => {
      const getLogTool = diagnosticTools[3];
      const ctx = makeContext();
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(sampleEntries);
      const result = await getLogTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(3);
    });

    it("filters by topic substring", async () => {
      const getLogTool = diagnosticTools[3];
      const ctx = makeContext();
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(sampleEntries);
      const result = await getLogTool.handler(
        { routerId: "test-router", topics: ["firewall"] },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(2);
    });

    it("filters by prefix substring in message", async () => {
      const getLogTool = diagnosticTools[3];
      const ctx = makeContext();
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(sampleEntries);
      const result = await getLogTool.handler(
        { routerId: "test-router", prefix: "port scan" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(1);
    });

    it("includes entry with unparseable timestamp when sinceMinutes is set (conservative)", async () => {
      const getLogTool = diagnosticTools[3];
      const entriesWithBadTs = [
        { ".id": "*1", time: "INVALID_TS", topics: "info", message: "something happened" },
      ];
      const ctx = makeContext();
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(entriesWithBadTs);
      const result = await getLogTool.handler({ routerId: "test-router", sinceMinutes: 5 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(1);
    });

    it("filters by sinceMinutes using hh:mm:ss time-of-day format", async () => {
      const now = new Date();
      const recentDate = new Date(now.getTime() - 60_000);
      const pad = (n: number) => String(n).padStart(2, "0");
      const recentTs = `${pad(recentDate.getHours())}:${pad(recentDate.getMinutes())}:${pad(recentDate.getSeconds())}`;
      const oldDate = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const oldTs = `${pad(oldDate.getHours())}:${pad(oldDate.getMinutes())}:${pad(oldDate.getSeconds())}`;

      const entries = [
        { ".id": "*1", time: recentTs, topics: "info", message: "recent event" },
        { ".id": "*2", time: oldTs, topics: "info", message: "old event" },
      ];
      const getLogTool = diagnosticTools[3];
      const ctx = makeContext();
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(entries);
      const result = await getLogTool.handler({ routerId: "test-router", sinceMinutes: 30 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(1);
      expect(((sc.entries as Record<string, unknown>[])[0] as Record<string, string>).message).toBe(
        "recent event",
      );
    });

    it("filters by sinceMinutes using YYYY-MM-DD HH:MM:SS full-date format", async () => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const fmt = (d: Date) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const recentTs = fmt(new Date(now.getTime() - 60_000));
      const oldTs = fmt(new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000));

      const entries = [
        { ".id": "*1", time: recentTs, topics: "info", message: "recent event" },
        { ".id": "*2", time: oldTs, topics: "interface,warning", message: "old event" },
      ];
      const getLogTool = diagnosticTools[3];
      const ctx = makeContext();
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(entries);
      const result = await getLogTool.handler({ routerId: "test-router", sinceMinutes: 30 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(1);
      expect(((sc.entries as Record<string, unknown>[])[0] as Record<string, string>).message).toBe(
        "recent event",
      );
    });

    it("filters relative to the router clock, not the server clock", async () => {
      // Router reports a wall-clock time unrelated to the test machine's real
      // "now". Entries are timestamped relative to the router clock; the filter
      // must use the router's time as the reference frame.
      const clock = [{ date: "2020-01-01", time: "12:00:00", "time-zone-name": "Asia/Tehran" }];
      const entries = [
        { ".id": "*1", time: "2020-01-01 11:59:30", topics: "info", message: "recent event" },
        { ".id": "*2", time: "2020-01-01 09:00:00", topics: "info", message: "old event" },
      ];
      const getLogTool = diagnosticTools[3];
      const ctx = makeContext();
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) =>
        Promise.resolve(path === "system/clock" ? clock : entries),
      );
      const result = await getLogTool.handler({ routerId: "test-router", sinceMinutes: 30 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(1);
      expect(((sc.entries as Record<string, unknown>[])[0] as Record<string, string>).message).toBe(
        "recent event",
      );
    });

    it("does not fetch the router clock when sinceMinutes is omitted", async () => {
      const getLogTool = diagnosticTools[3];
      const ctx = makeContext();
      const getMock = ctx.routerClient.get as ReturnType<typeof vi.fn>;
      getMock.mockResolvedValue([
        { ".id": "*1", time: "12:00:00", topics: "info", message: "event" },
      ]);
      await getLogTool.handler({ routerId: "test-router" }, ctx);
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(getMock).not.toHaveBeenCalledWith("system/clock");
    });

    it("falls back to the server clock when the router clock is unreadable", async () => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const recentTs = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      const getLogTool = diagnosticTools[3];
      const ctx = makeContext();
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (path === "system/clock") return Promise.reject(new Error("clock unavailable"));
        return Promise.resolve([
          { ".id": "*1", time: recentTs, topics: "info", message: "recent event" },
        ]);
      });
      const result = await getLogTool.handler({ routerId: "test-router", sinceMinutes: 30 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(1);
    });
  });
});
