import { describe, it, expect, vi } from "vitest";

vi.mock("basic-ftp", () => {
  const mockClient = {
    access: vi.fn().mockResolvedValue(undefined),
    uploadFrom: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
  return { Client: vi.fn().mockImplementation(() => mockClient) };
});

import { FtpClient } from "../../../src/adapter/ftp-client.js";
import { Client } from "basic-ftp";

function getMockInstance() {
  return new (Client as ReturnType<typeof vi.fn>)();
}

describe("FtpClient", () => {
  it("upload calls access then uploadFrom then close", async () => {
    const ftp = new FtpClient("192.168.1.1", 21, "admin", "secret");
    const instance = getMockInstance();
    await ftp.upload("test.rsc", "content here");
    expect(instance.access).toHaveBeenCalledWith({
      host: "192.168.1.1",
      port: 21,
      user: "admin",
      password: "secret",
    });
    expect(instance.uploadFrom).toHaveBeenCalled();
    expect(instance.close).toHaveBeenCalled();
  });

  it("upload calls close even when uploadFrom throws", async () => {
    const ftp = new FtpClient("192.168.1.1", 21, "admin", "secret");
    const instance = getMockInstance();
    instance.uploadFrom.mockRejectedValueOnce(new Error("ftp error"));
    await expect(ftp.upload("test.rsc", "content")).rejects.toThrow("ftp error");
    expect(instance.close).toHaveBeenCalled();
  });

  it("connect calls access then close", async () => {
    const ftp = new FtpClient("192.168.1.1", 21, "admin", "secret");
    const instance = getMockInstance();
    await ftp.connect();
    expect(instance.access).toHaveBeenCalledWith({
      host: "192.168.1.1",
      port: 21,
      user: "admin",
      password: "secret",
    });
    expect(instance.close).toHaveBeenCalled();
  });

  it("does not expose credentials as public properties", () => {
    const ftp = new FtpClient("192.168.1.1", 21, "admin", "secret") as unknown as Record<string, unknown>;
    expect(ftp["user"]).toBeUndefined();
    expect(ftp["password"]).toBeUndefined();
    expect(ftp["host"]).toBeUndefined();
  });
});
