import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RouterRegistry } from "../../../src/config/router-registry.js";

const { warnSpy, infoSpy } = vi.hoisted(() => ({ warnSpy: vi.fn(), infoSpy: vi.fn() }));
vi.mock("../../../src/observability/logger.js", () => ({
  createLogger: () => ({ warn: warnSpy, info: infoSpy, debug: vi.fn(), error: vi.fn() }),
}));

const FILE_CONFIG = `
routers:
  from-file:
    host: 10.0.0.1
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: true
    credentials:
      source: env
      envPrefix: ROUTER_FILE
    tags: []
    rosVersion: "7"
`;

const INLINE_YAML = `
routers:
  from-inline:
    host: 10.0.0.2
    port: 8443
    tls: { enabled: true, rejectUnauthorized: true }
    credentials: { source: env, envPrefix: ROUTER_INLINE }
    rosVersion: "7"
`;

const INLINE_JSON = JSON.stringify({
  routers: {
    a: {
      host: "10.0.0.3",
      port: 443,
      tls: { enabled: true, rejectUnauthorized: true },
      credentials: { source: "env", envPrefix: "ROUTER_A" },
      rosVersion: "7",
    },
    b: {
      host: "10.0.0.4",
      port: 80,
      deviceType: "swos",
      credentials: { source: "env", envPrefix: "SWITCH_B" },
    },
  },
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mikromcp-sources-"));
}

function existingFile(): string {
  const path = join(tempDir(), "routers.yaml");
  writeFileSync(path, FILE_CONFIG);
  return path;
}

function missingFile(): string {
  return join(tempDir(), "routers.yaml");
}

function warnings(): string[] {
  return warnSpy.mock.calls.map((call) => String(call[1]));
}

beforeEach(() => {
  warnSpy.mockReset();
  infoSpy.mockReset();
});

describe("RouterRegistry router sources", () => {
  describe("precedence", () => {
    it("reports none and stays empty when no source is set", () => {
      const registry = new RouterRegistry(missingFile(), {});
      expect(registry.source).toBe("none");
      expect(registry.listRouters()).toEqual([]);
      expect(warnings().join("\n")).toMatch(/neither MIKROMCP_ROUTERS nor MIKROMCP_ROUTER_HOST/);
    });

    it("uses the config file when it exists (backwards compatible)", () => {
      const registry = new RouterRegistry(existingFile(), {});
      expect(registry.source).toBe("file");
      expect(registry.routerIds()).toEqual(["from-file"]);
      expect(registry.ignoredSources).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ source: "file", count: 1 }),
        "Loaded routers",
      );
    });

    it("uses the flat variables when no file exists", () => {
      const registry = new RouterRegistry(missingFile(), { MIKROMCP_ROUTER_HOST: "192.0.2.1" });
      expect(registry.source).toBe("env");
      expect(registry.routerIds()).toEqual(["default"]);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ source: "env", count: 1 }),
        "Loaded routers",
      );
    });

    it("prefers the file over the flat variables and warns that they are ignored", () => {
      const path = existingFile();
      const registry = new RouterRegistry(path, {
        MIKROMCP_ROUTER_HOST: "192.0.2.1",
        MIKROMCP_ROUTER_PASS: "s3cret-value",
      });
      expect(registry.source).toBe("file");
      expect(registry.routerIds()).toEqual(["from-file"]);
      expect(registry.ignoredSources).toEqual(["MIKROMCP_ROUTER_* variables"]);
      expect(warnings()).toContain(
        `Routers come from config file ${path}; ignoring MIKROMCP_ROUTER_* variables`,
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("s3cret-value");
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("192.0.2.1");
    });

    it("prefers MIKROMCP_ROUTERS over the file and the flat variables", () => {
      const path = existingFile();
      const registry = new RouterRegistry(path, {
        MIKROMCP_ROUTERS: INLINE_YAML,
        MIKROMCP_ROUTER_HOST: "192.0.2.1",
      });
      expect(registry.source).toBe("inline");
      expect(registry.routerIds()).toEqual(["from-inline"]);
      expect(registry.ignoredSources).toEqual([
        `config file ${path}`,
        "MIKROMCP_ROUTER_* variables",
      ]);
      expect(warnings()).toContain(
        `Routers come from MIKROMCP_ROUTERS; ignoring config file ${path} and MIKROMCP_ROUTER_* variables`,
      );
    });

    it("does not warn about a config file that does not exist", () => {
      const registry = new RouterRegistry(missingFile(), { MIKROMCP_ROUTERS: INLINE_YAML });
      expect(registry.source).toBe("inline");
      expect(registry.ignoredSources).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("treats empty or blank variables as unset", () => {
      const registry = new RouterRegistry(existingFile(), {
        MIKROMCP_ROUTERS: "  ",
        MIKROMCP_ROUTER_HOST: "",
      });
      expect(registry.source).toBe("file");
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns when router variables are set without MIKROMCP_ROUTER_HOST", () => {
      const registry = new RouterRegistry(missingFile(), {
        MIKROMCP_ROUTER_PORT: "8443",
        MIKROMCP_ROUTER_TAGS: "lab",
      });
      expect(registry.source).toBe("none");
      expect(warnings()).toContain(
        "MIKROMCP_ROUTER_PORT, MIKROMCP_ROUTER_TAGS set without MIKROMCP_ROUTER_HOST; they are ignored",
      );
    });

    it("reads process.env when no env is passed", () => {
      vi.stubEnv("MIKROMCP_ROUTERS", "");
      vi.stubEnv("MIKROMCP_ROUTER_HOST", "192.0.2.9");
      try {
        const registry = new RouterRegistry(missingFile());
        expect(registry.source).toBe("env");
        expect(registry.getRouter("default").host).toBe("192.0.2.9");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("MIKROMCP_ROUTERS", () => {
    it("accepts YAML with the config-file shape", () => {
      const router = new RouterRegistry(missingFile(), {
        MIKROMCP_ROUTERS: INLINE_YAML,
      }).getRouter("from-inline");
      expect(router).toMatchObject({
        id: "from-inline",
        host: "10.0.0.2",
        port: 8443,
        deviceType: "routeros",
        tags: [],
        credentials: { source: "env", envPrefix: "ROUTER_INLINE" },
      });
    });

    it("accepts JSON, including SwOS switches", () => {
      const registry = new RouterRegistry(missingFile(), { MIKROMCP_ROUTERS: INLINE_JSON });
      expect(registry.routerIds()).toEqual(["a", "b"]);
      expect(registry.getRouter("b")).toMatchObject({
        deviceType: "swos",
        tls: { enabled: false },
        rosVersion: "swos",
      });
    });

    it("fails with one message naming the variable on bad YAML, without echoing the input", () => {
      const raw = "routers:\n  x: [unclosed hunter2-password";
      let message = "";
      try {
        new RouterRegistry(missingFile(), { MIKROMCP_ROUTERS: raw });
        expect.unreachable("bad YAML should have thrown");
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(
        /^Invalid router config in MIKROMCP_ROUTERS: not valid YAML or JSON \([A-Z_]+ at line \d+, column \d+\)\.$/,
      );
      expect(message).not.toContain("hunter2");
    });

    it("validates through the router schema and names the variable", () => {
      const bad = INLINE_YAML.replace("port: 8443", "port: 99999");
      expect(() => new RouterRegistry(missingFile(), { MIKROMCP_ROUTERS: bad })).toThrow(
        /^Invalid router config in MIKROMCP_ROUTERS:\n {2}routers\.from-inline\.port: /,
      );
    });

    it("rejects a value that is not a config object", () => {
      expect(
        () => new RouterRegistry(missingFile(), { MIKROMCP_ROUTERS: "/etc/routers.yaml" }),
      ).toThrow(/Invalid router config in MIKROMCP_ROUTERS:\n {2}\(root\): Expected object/);
    });

    it("rejects extra top-level keys like the file does", () => {
      expect(
        () =>
          new RouterRegistry(missingFile(), {
            MIKROMCP_ROUTERS: `${INLINE_YAML}\nextra: 1\n`,
          }),
      ).toThrow(/Unrecognized key/);
    });

    it("runs the SSH key check on inline routers", () => {
      const withKey = `${INLINE_YAML}    sshPrivateKeyPath: ${join(tempDir(), "missing-key")}\n`;
      expect(() => new RouterRegistry(missingFile(), { MIKROMCP_ROUTERS: withKey })).toThrow(
        /Invalid router config in MIKROMCP_ROUTERS:\n {2}from-inline\.sshPrivateKeyPath: not readable/,
      );
    });
  });

  describe("flat MIKROMCP_ROUTER_* variables", () => {
    function envRouter(env: Record<string, string>) {
      const registry = new RouterRegistry(missingFile(), {
        MIKROMCP_ROUTER_HOST: "192.0.2.1",
        ...env,
      });
      const [router] = registry.listRouters();
      return router;
    }

    it("synthesises one HTTPS router with safe defaults", () => {
      expect(envRouter({})).toEqual({
        id: "default",
        host: "192.0.2.1",
        port: 443,
        deviceType: "routeros",
        tls: { enabled: true, rejectUnauthorized: true },
        credentials: { source: "env", envPrefix: "MIKROMCP_ROUTER" },
        tags: [],
        rosVersion: "7",
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("is the sole router, so tool calls may omit routerId", () => {
      const registry = new RouterRegistry(missingFile(), { MIKROMCP_ROUTER_HOST: "192.0.2.1" });
      expect(registry.soleRouterId()).toBe("default");
    });

    it("trims the host", () => {
      expect(envRouter({ MIKROMCP_ROUTER_HOST: "  router.lan  " }).host).toBe("router.lan");
    });

    it("takes the id from MIKROMCP_ROUTER_ID", () => {
      expect(envRouter({ MIKROMCP_ROUTER_ID: "home" }).id).toBe("home");
    });

    it("takes the port from MIKROMCP_ROUTER_PORT", () => {
      expect(envRouter({ MIKROMCP_ROUTER_PORT: "8443" }).port).toBe(8443);
    });

    it.each(["0", "65536", "abc", "443.5", "-1", "1e3"])(
      "rejects MIKROMCP_ROUTER_PORT=%s with a message naming the variable",
      (port) => {
        expect(() => envRouter({ MIKROMCP_ROUTER_PORT: port })).toThrow(
          `MIKROMCP_ROUTER_PORT must be an integer from 1 to 65535, got "${port}".`,
        );
      },
    );

    it("pins the certificate with MIKROMCP_ROUTER_TLS_FINGERPRINT", () => {
      expect(envRouter({ MIKROMCP_ROUTER_TLS_FINGERPRINT: "AA:BB:CC" }).tls).toEqual({
        enabled: true,
        rejectUnauthorized: true,
        fingerprint: "AA:BB:CC",
      });
    });

    it("disables certificate validation with MIKROMCP_ROUTER_TLS_INSECURE=true and warns", () => {
      expect(envRouter({ MIKROMCP_ROUTER_TLS_INSECURE: "true" }).tls).toEqual({
        enabled: true,
        rejectUnauthorized: false,
      });
      expect(warnings().join("\n")).toMatch(/TLS certificate validation is DISABLED/);
    });

    it("keeps validation on with MIKROMCP_ROUTER_TLS_INSECURE=false", () => {
      expect(envRouter({ MIKROMCP_ROUTER_TLS_INSECURE: "false" }).tls.rejectUnauthorized).toBe(
        true,
      );
    });

    it("switches to plain HTTP on port 80 with MIKROMCP_ROUTER_TLS=false and warns", () => {
      const router = envRouter({ MIKROMCP_ROUTER_TLS: "false" });
      expect(router.tls).toEqual({ enabled: false, rejectUnauthorized: true });
      expect(router.port).toBe(80);
      expect(warnings().join("\n")).toMatch(/TLS is DISABLED \(MIKROMCP_ROUTER_TLS=false\)/);
    });

    it("keeps an explicit port with MIKROMCP_ROUTER_TLS=false", () => {
      expect(envRouter({ MIKROMCP_ROUTER_TLS: "no", MIKROMCP_ROUTER_PORT: "8080" }).port).toBe(
        8080,
      );
    });

    it.each(["TRUE", "yes", "1"])("accepts %s as true", (value) => {
      expect(envRouter({ MIKROMCP_ROUTER_TLS: value }).tls.enabled).toBe(true);
    });

    it("rejects a boolean variable that is not true or false", () => {
      expect(() => envRouter({ MIKROMCP_ROUTER_TLS_INSECURE: "maybe" })).toThrow(
        'MIKROMCP_ROUTER_TLS_INSECURE must be true or false, got "maybe".',
      );
    });

    it.each([
      ["MIKROMCP_ROUTER_TLS_FINGERPRINT", "AA:BB"],
      ["MIKROMCP_ROUTER_TLS_INSECURE", "true"],
    ])("refuses %s together with MIKROMCP_ROUTER_TLS=false", (name, value) => {
      expect(() => envRouter({ MIKROMCP_ROUTER_TLS: "false", [name]: value })).toThrow(
        `MIKROMCP_ROUTER_TLS=false turns TLS off, so ${name} cannot apply.`,
      );
    });

    it("takes rosVersion from MIKROMCP_ROUTER_ROS_VERSION", () => {
      expect(envRouter({ MIKROMCP_ROUTER_ROS_VERSION: "6" }).rosVersion).toBe("6");
    });

    it("splits MIKROMCP_ROUTER_TAGS on commas", () => {
      expect(envRouter({ MIKROMCP_ROUTER_TAGS: "home, edge,,lab " }).tags).toEqual([
        "home",
        "edge",
        "lab",
      ]);
    });

    it("never puts credentials into the router config", () => {
      const router = envRouter({ MIKROMCP_ROUTER_USER: "mcp", MIKROMCP_ROUTER_PASS: "pw-123" });
      expect(JSON.stringify(router)).not.toContain("pw-123");
      expect(JSON.stringify(router)).not.toContain('"mcp"');
    });
  });
});
