import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClient = {
  access: vi.fn().mockResolvedValue(undefined),
  uploadFrom: vi.fn().mockResolvedValue(undefined),
  close: vi.fn(),
};

vi.mock("basic-ftp", () => ({
  Client: vi.fn().mockImplementation(() => mockClient),
}));

import { FtpClient } from "../../../src/adapter/ftp-client.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("FtpClient", () => {
  it("upload calls access then uploadFrom then close", async () => {
    const ftp = new FtpClient("192.168.1.1", 21, "admin", "secret");
    await ftp.upload("test.rsc", "content here");
    expect(mockClient.access).toHaveBeenCalledWith({
      host: "192.168.1.1",
      port: 21,
      user: "admin",
      password: "secret",
    });
    expect(mockClient.uploadFrom).toHaveBeenCalled();
    expect(mockClient.close).toHaveBeenCalled();
  });

  it("upload calls close even when uploadFrom throws", async () => {
    mockClient.uploadFrom.mockRejectedValueOnce(new Error("ftp error"));
    const ftp = new FtpClient("192.168.1.1", 21, "admin", "secret");
    await expect(ftp.upload("test.rsc", "content")).rejects.toThrow("ftp error");
    expect(mockClient.close).toHaveBeenCalled();
  });

  it("connect calls access then close", async () => {
    const ftp = new FtpClient("192.168.1.1", 21, "admin", "secret");
    await ftp.connect();
    expect(mockClient.access).toHaveBeenCalledWith({
      host: "192.168.1.1",
      port: 21,
      user: "admin",
      password: "secret",
    });
    expect(mockClient.close).toHaveBeenCalled();
  });

  it("does not expose credentials as public properties", () => {
    const ftp = new FtpClient("192.168.1.1", 21, "admin", "secret") as unknown as Record<string, unknown>;
    expect(ftp["user"]).toBeUndefined();
    expect(ftp["password"]).toBeUndefined();
    expect(ftp["host"]).toBeUndefined();
    expect(ftp["port"]).toBeUndefined();
  });
});
