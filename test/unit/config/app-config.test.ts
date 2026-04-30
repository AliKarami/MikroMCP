import { describe, it, expect, afterEach } from "vitest";
import { loadAppConfig } from "../../../src/config/app-config.js";

afterEach(() => {
  delete process.env.MIKROMCP_BIND_HOST;
  delete process.env.MIKROMCP_HTTP_MAX_BODY_BYTES;
  delete process.env.MIKROMCP_HTTP_RATE_LIMIT_RPM;
  delete process.env.MIKROMCP_SSH_COMMAND_TIMEOUT_MS;
  delete process.env.MIKROMCP_SSH_MAX_OUTPUT_BYTES;
});

describe("loadAppConfig", () => {
  describe("defaults", () => {
    it("bindHost defaults to 127.0.0.1", () => {
      expect(loadAppConfig().bindHost).toBe("127.0.0.1");
    });

    it("http.maxBodyBytes defaults to 1048576 (1 MB)", () => {
      expect(loadAppConfig().http.maxBodyBytes).toBe(1_048_576);
    });

    it("http.rateLimitRpm defaults to 60", () => {
      expect(loadAppConfig().http.rateLimitRpm).toBe(60);
    });

    it("ssh.commandTimeoutMs defaults to 30000", () => {
      expect(loadAppConfig().ssh.commandTimeoutMs).toBe(30_000);
    });

    it("ssh.maxOutputBytes defaults to 524288 (512 KB)", () => {
      expect(loadAppConfig().ssh.maxOutputBytes).toBe(524_288);
    });
  });

  describe("env var overrides", () => {
    it("reads MIKROMCP_BIND_HOST", () => {
      process.env.MIKROMCP_BIND_HOST = "0.0.0.0";
      expect(loadAppConfig().bindHost).toBe("0.0.0.0");
    });

    it("reads MIKROMCP_HTTP_MAX_BODY_BYTES", () => {
      process.env.MIKROMCP_HTTP_MAX_BODY_BYTES = "2097152";
      expect(loadAppConfig().http.maxBodyBytes).toBe(2_097_152);
    });

    it("reads MIKROMCP_HTTP_RATE_LIMIT_RPM=0 to disable rate limiting", () => {
      process.env.MIKROMCP_HTTP_RATE_LIMIT_RPM = "0";
      expect(loadAppConfig().http.rateLimitRpm).toBe(0);
    });

    it("reads MIKROMCP_SSH_COMMAND_TIMEOUT_MS", () => {
      process.env.MIKROMCP_SSH_COMMAND_TIMEOUT_MS = "10000";
      expect(loadAppConfig().ssh.commandTimeoutMs).toBe(10_000);
    });

    it("reads MIKROMCP_SSH_MAX_OUTPUT_BYTES", () => {
      process.env.MIKROMCP_SSH_MAX_OUTPUT_BYTES = "131072";
      expect(loadAppConfig().ssh.maxOutputBytes).toBe(131_072);
    });
  });
});
