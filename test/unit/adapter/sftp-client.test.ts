import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouterConfig } from "../../../src/types.js";

vi.mock("ssh2", () => ({
  Client: vi.fn(),
}));

import { Client } from "ssh2";
import { SftpClient } from "../../../src/adapter/sftp-client.js";

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
const credentials = { username: "rest-user", password: "rest-password" };
const tempDirs: string[] = [];

function tempPrivateKey(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mikromcp-sftp-key-"));
  tempDirs.push(dir);
  const path = join(dir, "id_test");
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

type MockSftp = {
  writeFile: ReturnType<typeof vi.fn>;
};

type MockConn = EventEmitter & {
  sftp: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
};

function buildMocks(): { conn: MockConn; sftp: MockSftp } {
  const sftp: MockSftp = {
    writeFile: vi.fn((_name: string, _content: Buffer, callback: (error: null) => void) =>
      callback(null),
    ),
  };

  const conn = new EventEmitter() as MockConn;
  conn.end = vi.fn();
  conn.sftp = vi.fn((callback: (error: null, client: MockSftp) => void) => callback(null, sftp));
  conn.connect = vi.fn(() => setImmediate(() => conn.emit("ready")));
  MockClient.mockImplementation(() => conn);

  return { conn, sftp };
}

describe("SftpClient authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("uses the SSH username and private key without the REST password", async () => {
    const { conn } = buildMocks();
    const keyPath = tempPrivateKey("test-private-key");
    const client = new SftpClient(
      { ...routerConfig, sshUsername: "automation", sshPrivateKeyPath: keyPath },
      credentials,
    );

    const promise = client.upload("test.rsc", ":log info");

    const options = conn.connect.mock.calls[0][0] as Record<string, unknown>;
    expect(options.username).toBe("automation");
    expect(options.privateKey).toEqual(Buffer.from("test-private-key"));
    expect(options.password).toBeUndefined();
    await promise;
  });

  it("fails closed instead of using the REST password when the key is unreadable", async () => {
    const { conn } = buildMocks();
    const client = new SftpClient(
      { ...routerConfig, sshPrivateKeyPath: "/tmp/mikromcp-sftp-key-that-does-not-exist" },
      credentials,
    );

    await expect(client.upload("test.rsc", ":log info")).rejects.toMatchObject({ code: "ENOENT" });
    expect(conn.connect).not.toHaveBeenCalled();
  });

  it("keeps password authentication when no private key is configured", async () => {
    const { conn } = buildMocks();
    const client = new SftpClient(routerConfig, credentials);

    const promise = client.upload("test.rsc", ":log info");

    const options = conn.connect.mock.calls[0][0] as Record<string, unknown>;
    expect(options).toMatchObject({ username: "rest-user", password: "rest-password" });
    expect(options.privateKey).toBeUndefined();
    await promise;
  });
});
