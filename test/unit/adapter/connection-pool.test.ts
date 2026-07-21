import { describe, it, expect, vi, beforeEach } from "vitest";

const closeSpy = vi.fn();
const ctorSpy = vi.fn();

vi.mock("../../../src/adapter/rest-client.js", () => ({
  RouterOSRestClient: vi.fn().mockImplementation((config: unknown, creds: unknown) => {
    ctorSpy(config, creds);
    return { close: closeSpy, get: vi.fn().mockResolvedValue([]) };
  }),
}));

import { ConnectionPool } from "../../../src/adapter/connection-pool.js";
import type { RouterConfig } from "../../../src/types.js";

const config: RouterConfig = {
  id: "edge-01",
  host: "192.168.1.1",
  port: 443,
  tls: { enabled: true, rejectUnauthorized: false },
  credentials: { source: "env", envPrefix: "EDGE" },
  tags: [],
  rosVersion: "7",
};

describe("ConnectionPool", () => {
  beforeEach(() => {
    closeSpy.mockClear();
    ctorSpy.mockClear();
  });

  it("returns the same client for identical credentials", () => {
    const pool = new ConnectionPool();
    const a = pool.getClient(config, { username: "admin", password: "p1" });
    const b = pool.getClient(config, { username: "admin", password: "p1" });
    expect(a).toBe(b);
    expect(ctorSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("rebuilds and closes the old client when credentials change", () => {
    const pool = new ConnectionPool();
    const a = pool.getClient(config, { username: "admin", password: "old" });
    const b = pool.getClient(config, { username: "admin", password: "new" });
    expect(a).not.toBe(b);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(ctorSpy).toHaveBeenCalledTimes(2);
  });
});
