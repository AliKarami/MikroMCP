import { describe, it, expect, afterEach } from "vitest";
import { loadAppConfig } from "../../../src/config/app-config.js";

afterEach(() => {
  delete process.env.MIKROMCP_BIND_HOST;
  delete process.env.MIKROMCP_HTTP_MAX_BODY_BYTES;
  delete process.env.MIKROMCP_HTTP_RATE_LIMIT_RPM;
  delete process.env.MIKROMCP_SSH_COMMAND_TIMEOUT_MS;
  delete process.env.MIKROMCP_SSH_MAX_OUTPUT_BYTES;
  delete process.env.MIKROMCP_IDENTITIES_PATH;
  delete process.env.MIKROMCP_STDIO_IDENTITY;
  delete process.env.MIKROMCP_CONFIRMATION_SECRET;
  delete process.env.MIKROMCP_AUDIT_LOG_PATH;
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

  describe("v0.7 auth/audit env vars", () => {
    it("identitiesPath defaults to config/identities.yaml", () => {
      expect(loadAppConfig().identitiesPath).toBe("config/identities.yaml");
    });

    it("stdioIdentity defaults to undefined", () => {
      expect(loadAppConfig().stdioIdentity).toBeUndefined();
    });

    it("confirmationSecret defaults to undefined", () => {
      expect(loadAppConfig().confirmationSecret).toBeUndefined();
    });

    it("auditLogPath defaults to undefined", () => {
      expect(loadAppConfig().auditLogPath).toBeUndefined();
    });

    it("reads MIKROMCP_IDENTITIES_PATH", () => {
      process.env.MIKROMCP_IDENTITIES_PATH = "/etc/identities.yaml";
      expect(loadAppConfig().identitiesPath).toBe("/etc/identities.yaml");
    });

    it("reads MIKROMCP_STDIO_IDENTITY", () => {
      process.env.MIKROMCP_STDIO_IDENTITY = "admin-ali";
      expect(loadAppConfig().stdioIdentity).toBe("admin-ali");
    });

    it("reads MIKROMCP_CONFIRMATION_SECRET", () => {
      process.env.MIKROMCP_CONFIRMATION_SECRET = "supersecret";
      expect(loadAppConfig().confirmationSecret).toBe("supersecret");
    });

    it("reads MIKROMCP_AUDIT_LOG_PATH", () => {
      process.env.MIKROMCP_AUDIT_LOG_PATH = "/var/log/mikromcp-audit.ndjson";
      expect(loadAppConfig().auditLogPath).toBe("/var/log/mikromcp-audit.ndjson");
    });
  });
});
