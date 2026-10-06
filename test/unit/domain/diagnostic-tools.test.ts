import { describe, it, expect, vi } from "vitest";
import { diagnosticTools } from "../../../src/domain/tools/diagnostic-tools.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import { HttpError, type RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { lastSection } from "../../../src/adapter/response-parser.js";
import type { RouterConfig } from "../../../src/types.js";
import { enrichError } from "../../../src/domain/errors/error-enricher.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";
import { z } from "zod";

const pingTool = diagnosticTools[0];
const tracerouteTool = diagnosticTools[1];

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
      execute: vi.fn().mockResolvedValue(restResult),
      executeFinal: vi.fn(async () => lastSection(restResult as Record<string, string>[])),
      get: vi.fn().mockResolvedValue([]),
    } as unknown as RouterOSRestClient,
  };
}

const pingInputSchema = z
  .object({
    routerId: z.string(),
    address: z.string(),
    count: z.number().int().min(1).max(20).default(4),
    size: z.number().int().min(14).max(65535).default(56),
    routingTable: z.string().optional(),
  })
  .strict();

const tracerouteInputSchema = z
  .object({
    routerId: z.string(),
    address: z.string(),
    count: z.number().int().min(1).max(5).default(3),
    maxHops: z.number().int().min(1).max(30).default(15),
  })
  .strict();

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

  describe("traceroute input schema", () => {
    it("accepts minimal input with defaults", () => {
      const r = tracerouteInputSchema.parse({ routerId: "r", address: "8.8.8.8" });
      expect(r.count).toBe(3);
      expect(r.maxHops).toBe(15);
    });

    it("rejects maxHops > 30", () => {
      expect(() =>
        tracerouteInputSchema.parse({ routerId: "r", address: "8.8.8.8", maxHops: 31 }),
      ).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() =>
        tracerouteInputSchema.parse({ routerId: "r", address: "8.8.8.8", extra: 1 }),
      ).toThrow();
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
    // POST /rest/tool/traceroute on RouterOS 7.24.2 (count=1, max-hops=4): one
    // `.section` per screen update; only the last one is final.
    const TRACE_REST_RESULT = [
      {
        ".section": "0",
        address: "192.168.1.1",
        avg: "0.3",
        best: "0.3",
        last: "0.3",
        loss: "0",
        sent: "1",
        status: "",
        "std-dev": "0",
        worst: "0.3",
      },
      { ".section": "0", address: "", last: "0", loss: "0", sent: "1", status: "" },
      {
        ".section": "1",
        address: "192.168.1.1",
        avg: "0.3",
        best: "0.3",
        error: "Too many hops",
        last: "0.3",
        loss: "0",
        sent: "1",
        status: "",
        "std-dev": "0",
        worst: "0.3",
      },
      {
        ".section": "1",
        address: "",
        error: "Too many hops",
        last: "timeout",
        loss: "100",
        sent: "1",
        status: "",
      },
      {
        ".section": "1",
        address: "10.196.39.1",
        avg: "30.8",
        best: "30.8",
        error: "Too many hops",
        last: "30.8",
        loss: "0",
        sent: "1",
        status: "",
        "std-dev": "0",
        worst: "30.8",
      },
      {
        ".section": "1",
        address: "203.0.113.237",
        avg: "29.9",
        best: "29.9",
        error: "Too many hops",
        last: "29.9",
        loss: "0",
        sent: "1",
        status: "",
        "std-dev": "0",
        worst: "29.9",
      },
    ];

    it("returns the hops of the final section once, numbered from 1", async () => {
      const ctx = makeContext("", TRACE_REST_RESULT);
      const result = await tracerouteTool.handler(
        { routerId: "test-router", address: "1.1.1.1" },
        ctx,
      );
      expect(result.isError).toBeFalsy();
      const hops = (result.structuredContent as Record<string, unknown>).hops as Record<
        string,
        unknown
      >[];
      expect(hops.map((h) => [h.hop, h.address])).toEqual([
        [1, "192.168.1.1"],
        [2, null],
        [3, "10.196.39.1"],
        [4, "203.0.113.237"],
      ]);
      expect(hops[2]).toEqual({
        hop: 3,
        address: "10.196.39.1",
        avg: 30.8,
        best: 30.8,
        error: "Too many hops",
        last: 30.8,
        loss: 0,
        sent: 1,
        status: "",
        stdDev: 0,
        worst: 30.8,
      });
      expect(hops[1]).toMatchObject({ address: null, last: "timeout", loss: 100 });
      expect(result.content).toContain("  2  ???  timeout  loss=100%");
      expect(result.content).toContain("  3  10.196.39.1  30.8ms  loss=0%");
      expect(result.content).toContain("RouterOS: Too many hops — 1.1.1.1 was not reached");
    });

    it("POSTs address, count, and max-hops to tool/traceroute", async () => {
      const ctx = makeContext("", TRACE_REST_RESULT);
      await tracerouteTool.handler(
        { routerId: "test-router", address: "8.8.8.8", count: 2, maxHops: 10 },
        ctx,
      );
      expect(ctx.routerClient.executeFinal).toHaveBeenCalledWith(
        "tool/traceroute",
        { address: "8.8.8.8", count: "2", "max-hops": "10" },
        { timeoutMs: 65_000 },
      );
      expect(ctx.sshClient.execute).not.toHaveBeenCalled();
    });

    it("does not report an error when RouterOS reached the target", async () => {
      const ctx = makeContext("", [
        {
          ".section": "0",
          address: "1.1.1.1",
          avg: "48",
          last: "48",
          loss: "0",
          sent: "1",
          status: "",
        },
      ]);
      const result = await tracerouteTool.handler(
        { routerId: "test-router", address: "one.one.one.one" },
        ctx,
      );
      expect(result.content).not.toContain("was not reached");
      expect(ctx.routerClient.executeFinal).toHaveBeenCalledWith(
        "tool/traceroute",
        expect.objectContaining({ address: "one.one.one.one" }),
        expect.anything(),
      );
    });

    it("returns no hops for an empty result", async () => {
      const ctx = makeContext("", []);
      const result = await tracerouteTool.handler(
        { routerId: "test-router", address: "8.8.8.8" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).hops).toEqual([]);
    });
  });

  describe("torch metadata and schema", () => {
    const torchTool = diagnosticTools[2];

    it("torch is the third tool", () => {
      expect(torchTool.name).toBe("torch");
    });

    it("torch has readOnlyHint true", () => {
      expect(torchTool.annotations.readOnlyHint).toBe(true);
    });
  });

  describe("torch input schema", () => {
    const torchInputSchema = z
      .object({
        routerId: z.string(),
        interface: z.string(),
        duration: z.number().int().min(1).max(30).default(5),
        srcAddress: z.string().optional(),
        dstAddress: z.string().optional(),
      })
      .strict();

    it("accepts minimal input with defaults", () => {
      const r = torchInputSchema.parse({ routerId: "r", interface: "ether1" });
      expect(r.duration).toBe(5);
    });

    it("rejects duration > 30", () => {
      expect(() =>
        torchInputSchema.parse({ routerId: "r", interface: "ether1", duration: 31 }),
      ).toThrow();
    });

    it("rejects duration < 1", () => {
      expect(() =>
        torchInputSchema.parse({ routerId: "r", interface: "ether1", duration: 0 }),
      ).toThrow();
    });

    it("rejects missing interface", () => {
      expect(() => torchInputSchema.parse({ routerId: "r" })).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() =>
        torchInputSchema.parse({ routerId: "r", interface: "ether1", unknown: 1 }),
      ).toThrow();
    });
  });

  describe("torch handler", () => {
    // POST /rest/tool/torch on RouterOS 7.24.2; rates are bits/s and packets/s.
    const TORCH_REST_RESULT = [
      {
        ".section": "0",
        dscp: "0",
        "dst-address": "224.0.0.224",
        "dst-port": "7447",
        "ip-protocol": "udp",
        "mac-protocol": "ip",
        rx: "552",
        "rx-packets": "1",
        "src-address": "192.168.1.114",
        "src-port": "48595",
        tx: "0",
        "tx-packets": "0",
      },
      {
        ".section": "1",
        dscp: "0",
        "dst-address": "255.255.255.255",
        "dst-port": "20561",
        "ip-protocol": "udp",
        "mac-protocol": "ip",
        rx: "10800",
        "rx-packets": "17",
        "src-address": "192.168.1.55",
        "src-port": "56457",
        tx: "0",
        "tx-packets": "0",
      },
      {
        ".section": "1",
        dscp: "0",
        "dst-address": "ff02::fb",
        "dst-port": "5353",
        "ip-protocol": "udp",
        "mac-protocol": "ipv6",
        rx: "7600",
        "rx-packets": "4",
        "src-address": "fe80::aaaa:bbbb:cccc:1",
        "src-port": "5353",
        tx: "999950",
        "tx-packets": "120",
      },
    ];

    it("returns the flows of the final section with numeric rates", async () => {
      const torchTool = diagnosticTools[2];
      const ctx = makeContext("", TORCH_REST_RESULT);
      const result = await torchTool.handler({ routerId: "test-router", interface: "ether1" }, ctx);
      expect(result.isError).toBeFalsy();
      const flows = (result.structuredContent as Record<string, unknown>).flows;
      expect(flows).toEqual([
        {
          dscp: 0,
          dstAddress: "255.255.255.255",
          dstPort: 20561,
          ipProtocol: "udp",
          macProtocol: "ip",
          rx: 10800,
          rxPackets: 17,
          srcAddress: "192.168.1.55",
          srcPort: 56457,
          tx: 0,
          txPackets: 0,
        },
        {
          dscp: 0,
          dstAddress: "ff02::fb",
          dstPort: 5353,
          ipProtocol: "udp",
          macProtocol: "ipv6",
          rx: 7600,
          rxPackets: 4,
          srcAddress: "fe80::aaaa:bbbb:cccc:1",
          srcPort: 5353,
          tx: 999950,
          txPackets: 120,
        },
      ]);
      expect(result.content).toContain(
        "udp  192.168.1.55:56457 → 255.255.255.255:20561  tx=0bps  rx=10.8kbps",
      );
      expect(result.content).toContain(
        "udp  [fe80::aaaa:bbbb:cccc:1]:5353 → [ff02::fb]:5353  tx=1Mbps  rx=7.6kbps",
      );
    });

    it("keeps a port that RouterOS names as a string", async () => {
      const torchTool = diagnosticTools[2];
      const ctx = makeContext("", [
        {
          ".section": "0",
          "dst-address": "1.1.1.1",
          "dst-port": "443 (https)",
          "ip-protocol": "tcp",
          rx: "1000000",
          tx: "0",
        },
      ]);
      const result = await torchTool.handler({ routerId: "test-router", interface: "ether1" }, ctx);
      const [flow] = (result.structuredContent as Record<string, unknown>).flows as Record<
        string,
        unknown
      >[];
      expect(flow).toMatchObject({ dstPort: "443 (https)", rx: 1000000 });
      expect(result.content).toContain("tcp  * → 1.1.1.1:443 (https)  tx=0bps  rx=1Mbps");
    });

    it("lets RouterOS end the capture and waits longer than duration", async () => {
      const torchTool = diagnosticTools[2];
      const ctx = makeContext("", TORCH_REST_RESULT);
      await torchTool.handler(
        {
          routerId: "test-router",
          interface: "ether1",
          duration: 10,
          srcAddress: "192.168.1.0/24",
          dstAddress: "8.8.8.8",
        },
        ctx,
      );
      expect(ctx.routerClient.executeFinal).toHaveBeenCalledWith(
        "tool/torch",
        {
          interface: "ether1",
          duration: "10s",
          "src-address": "192.168.1.0/24",
          "dst-address": "8.8.8.8",
        },
        { timeoutMs: 15_000 },
      );
      expect(ctx.sshClient.execute).not.toHaveBeenCalled();
    });

    it("returns empty flows for an empty result", async () => {
      const torchTool = diagnosticTools[2];
      const ctx = makeContext("", []);
      const result = await torchTool.handler({ routerId: "test-router", interface: "ether1" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).flows).toEqual([]);
    });

    it("surfaces a RouterOS error instead of reporting zero flows", async () => {
      const torchTool = diagnosticTools[2];
      const ctx = makeContext();
      (ctx.routerClient.executeFinal as ReturnType<typeof vi.fn>).mockRejectedValue(
        new HttpError(
          400,
          JSON.stringify({
            error: 400,
            message: "Bad Request",
            detail: "input does not match any value of interface",
          }),
        ),
      );
      await expect(
        torchTool.handler({ routerId: "test-router", interface: "ether9" }, ctx),
      ).rejects.toThrow(/input does not match any value of interface/);
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
    const getLogInputSchema = z
      .object({
        routerId: z.string(),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
        topics: z.array(z.string()).optional(),
        prefix: z.string().optional(),
        sinceMinutes: z.number().int().min(1).max(1440).optional(),
      })
      .strict();

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
