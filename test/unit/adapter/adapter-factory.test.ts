import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/config/secrets.js", () => ({
  getCredentials: vi.fn().mockReturnValue({ username: "admin", password: "secret" }),
}));

import { createSshClient, createFtpClient } from "../../../src/adapter/adapter-factory.js";
import { SshClient } from "../../../src/adapter/ssh-client.js";
import { FtpClient } from "../../../src/adapter/ftp-client.js";
import type { RouterConfig } from "../../../src/types.js";

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

describe("createSshClient", () => {
  it("returns an SshClient instance", () => {
    const client = createSshClient(makeRouterConfig(), {
      commandTimeoutMs: 30000,
      maxOutputBytes: 524288,
    });
    expect(client).toBeInstanceOf(SshClient);
  });
});

describe("createFtpClient", () => {
  it("returns a FtpClient instance", () => {
    const client = createFtpClient(makeRouterConfig());
    expect(client).toBeInstanceOf(FtpClient);
  });
});
