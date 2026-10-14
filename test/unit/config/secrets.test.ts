import { describe, it, expect, afterEach } from "vitest";
import { getCredentials } from "../../../src/config/secrets.js";
import type { RouterConfig } from "../../../src/types.js";

const router = {
  id: "switch-01",
  host: "192.168.88.1",
  credentials: { source: "env", envPrefix: "SECRETS_TEST" },
} as unknown as RouterConfig;

describe("getCredentials", () => {
  afterEach(() => {
    delete process.env.SECRETS_TEST_USER;
    delete process.env.SECRETS_TEST_PASS;
  });

  it("returns the user and password from the environment", () => {
    process.env.SECRETS_TEST_USER = "admin";
    process.env.SECRETS_TEST_PASS = "s3cret";
    expect(getCredentials(router)).toEqual({ username: "admin", password: "s3cret" });
  });

  it("accepts an explicitly empty password, the factory default of a SwOS switch", () => {
    process.env.SECRETS_TEST_USER = "admin";
    process.env.SECRETS_TEST_PASS = "";
    expect(getCredentials(router)).toEqual({ username: "admin", password: "" });
  });

  it("names the password variable when it is not set at all", () => {
    process.env.SECRETS_TEST_USER = "admin";
    expect(() => getCredentials(router)).toThrow(
      expect.objectContaining({
        code: "MISSING_CREDENTIALS",
        details: { missing: ["SECRETS_TEST_PASS"] },
      }),
    );
  });

  it("still refuses an empty user name", () => {
    process.env.SECRETS_TEST_USER = "";
    process.env.SECRETS_TEST_PASS = "";
    expect(() => getCredentials(router)).toThrow(
      expect.objectContaining({
        code: "MISSING_CREDENTIALS",
        details: { missing: ["SECRETS_TEST_USER"] },
      }),
    );
  });
});
