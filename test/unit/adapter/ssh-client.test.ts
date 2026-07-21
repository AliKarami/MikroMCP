import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { RouterConfig } from "../../../src/types.js";

vi.mock("ssh2", () => ({
  Client: vi.fn(),
}));

import { Client } from "ssh2";
import { SshClient } from "../../../src/adapter/ssh-client.js";

const MockClient = Client as unknown as ReturnType<typeof vi.fn>;

const routerConfig: RouterConfig = {
  id: "test-router",
  host: "192.168.1.1",
  port: 443,
  tls: { enabled: true, rejectUnauthorized: true },
  credentials: { source: "env", envPrefix: "TEST" },
  tags: [],
  rosVersion: "7",
};
const credentials = { username: "admin", password: "pass" };

type MockStream = EventEmitter & {
  stderr: EventEmitter;
  close: ReturnType<typeof vi.fn>;
};

type MockConn = EventEmitter & {
  exec: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
};

function buildMocks(): { conn: MockConn; stream: MockStream } {
  const stream = new EventEmitter() as MockStream;
  stream.stderr = new EventEmitter();
  stream.close = vi.fn(() => setImmediate(() => stream.emit("close")));

  const conn = new EventEmitter() as MockConn;
  conn.end = vi.fn();
  conn.exec = vi.fn((_cmd: string, cb: (err: null, s: MockStream) => void) => cb(null, stream));
  conn.connect = vi.fn(() => setImmediate(() => conn.emit("ready")));

  MockClient.mockImplementation(() => conn);

  return { conn, stream };
}

describe("SshClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("happy path", () => {
    it("resolves with output from stream data", async () => {
      const { stream } = buildMocks();
      const client = new SshClient(routerConfig, credentials);

      const promise = client.execute("test command");
      await new Promise((r) => setImmediate(r));
      stream.emit("data", Buffer.from("hello world"));
      stream.emit("close");

      expect(await promise).toBe("hello world");
    });

    it("calls conn.end() after successful execute", async () => {
      const { conn, stream } = buildMocks();
      const client = new SshClient(routerConfig, credentials);

      const promise = client.execute("test command");
      await new Promise((r) => setImmediate(r));
      stream.emit("close");
      await promise;

      expect(conn.end).toHaveBeenCalled();
    });
  });

  describe("resource cleanup", () => {
    it("calls conn.end() on connection error", async () => {
      const { conn } = buildMocks();
      conn.connect = vi.fn(() => setImmediate(() => conn.emit("error", new Error("ECONNREFUSED"))));
      const client = new SshClient(routerConfig, credentials);

      await expect(client.execute("test command")).rejects.toThrow("ECONNREFUSED");
      expect(conn.end).toHaveBeenCalled();
    });

    it("does not reject twice when error fires after stream close", async () => {
      const { conn, stream } = buildMocks();
      const client = new SshClient(routerConfig, credentials);

      const promise = client.execute("test command");
      await new Promise((r) => setImmediate(r));
      stream.emit("close");
      await new Promise((r) => setImmediate(r));
      conn.emit("error", new Error("late error"));

      await expect(promise).resolves.toBeDefined();
    });
  });

  describe("output cap", () => {
    it("truncates output at maxOutputBytes and appends [OUTPUT TRUNCATED] marker", async () => {
      const { stream } = buildMocks();
      const client = new SshClient(routerConfig, credentials, { maxOutputBytes: 5 });

      const promise = client.execute("test command");
      await new Promise((r) => setImmediate(r));
      stream.emit("data", Buffer.from("hello world this is too long"));
      stream.emit("close");

      const result = await promise;
      expect(result).toContain("[OUTPUT TRUNCATED]");
      expect(result.startsWith("hello")).toBe(true);
    });

    it("closes the stream immediately when cap is exceeded", async () => {
      const { stream } = buildMocks();
      const client = new SshClient(routerConfig, credentials, { maxOutputBytes: 3 });

      const promise = client.execute("test command");
      await new Promise((r) => setImmediate(r));
      stream.emit("data", Buffer.from("hello"));
      await promise;

      expect(stream.close).toHaveBeenCalled();
    });
  });

  describe("timeout", () => {
    it("closes the stream after commandTimeoutMs with no output", async () => {
      const { stream } = buildMocks();
      const client = new SshClient(routerConfig, credentials, { commandTimeoutMs: 20 });

      const promise = client.execute("hanging command");
      await new Promise((r) => setImmediate(r));
      // No close emitted — let the 20ms timeout fire naturally
      await expect(promise).rejects.toMatchObject({ code: "ETIMEDOUT" });

      expect(stream.close).toHaveBeenCalled();
    }, 1000);

    it("rejects with ETIMEDOUT instead of returning partial output on timeout", async () => {
      const { stream } = buildMocks();
      const client = new SshClient(routerConfig, credentials, { commandTimeoutMs: 20 });

      const promise = client.execute("hanging command");
      await new Promise((r) => setImmediate(r));
      stream.emit("data", Buffer.from("partial output before hang"));
      // Timeout fires; the mock's close() then emits "close".
      await expect(promise).rejects.toMatchObject({
        code: "ETIMEDOUT",
        message: expect.stringContaining("timed out"),
      });
    }, 1000);
  });

  describe("utf-8 decoding", () => {
    it("decodes a multi-byte character split across stream chunks", async () => {
      const { stream } = buildMocks();
      const client = new SshClient(routerConfig, credentials);

      const promise = client.execute("test command");
      await new Promise((r) => setImmediate(r));
      const full = Buffer.from("a…b", "utf-8"); // U+2026 is 3 bytes
      const cut = full.indexOf(0xe2) + 1;
      stream.emit("data", full.subarray(0, cut));
      stream.emit("data", full.subarray(cut));
      stream.emit("close");

      expect(await promise).toBe("a…b");
    });
  });

  describe("SSH fingerprint pinning", () => {
    it("sets hostVerifier in connect options when sshFingerprint is configured", () => {
      const { conn } = buildMocks();
      const cfgWithFp = { ...routerConfig, sshFingerprint: "abc123fingerprint" };
      const client = new SshClient(cfgWithFp, credentials);

      client.execute("test command");

      const connectArg = (conn.connect as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(connectArg.hostVerifier).toBeTypeOf("function");
    });

    it("does not set hostVerifier when sshFingerprint is not configured", () => {
      const { conn } = buildMocks();
      const client = new SshClient(routerConfig, credentials);

      client.execute("test command");

      const connectArg = (conn.connect as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(connectArg.hostVerifier).toBeUndefined();
    });

    it("hostVerifier returns false when SHA256 of key does not match expected fingerprint", () => {
      const { conn } = buildMocks();
      const cfgWithFp = { ...routerConfig, sshFingerprint: "expectedhex" };
      const client = new SshClient(cfgWithFp, credentials);

      client.execute("test command");

      const connectArg = (conn.connect as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      const hostVerifier = connectArg.hostVerifier as (key: Buffer) => boolean;
      // SHA256("wrongkey") !== "expectedhex"
      expect(hostVerifier(Buffer.from("wrongkey"))).toBe(false);
    });
  });
});
