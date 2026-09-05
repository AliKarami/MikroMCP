import { readFileSync, existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { DeviceType, RouterConfig } from "../types.js";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";
import { createLogger } from "../observability/logger.js";
import { privateKeyIsShared, privateKeyReadError } from "./ssh-key.js";

const log = createLogger("router-registry");

/**
 * Accepted `deviceType` spellings mapped to the canonical platform. Switches
 * running full SwOS and SwOS Lite speak the same API, so both resolve to
 * "swos"; "swos-lite" stays accepted because it names a real firmware edition
 * and is the spelling most users will reach for.
 */
const DEVICE_TYPE_ALIASES: Record<string, DeviceType> = {
  routeros: "routeros",
  swos: "swos",
  "swos-lite": "swos",
};

const RouterConfigSchema = z
  .object({
    host: z.string().min(1, "host is required"),
    port: z.number().int().min(1).max(65535),
    deviceType: z.enum(Object.keys(DEVICE_TYPE_ALIASES) as [string, ...string[]]).optional(),
    tls: z
      .object({
        enabled: z.boolean(),
        rejectUnauthorized: z.boolean(),
        ca: z.string().optional(),
        fingerprint: z.string().optional(),
      })
      .strict()
      .optional(),
    credentials: z
      .object({
        source: z.enum(["env", "vault"]),
        envPrefix: z.string().optional(),
        vaultPath: z.string().optional(),
      })
      .strict(),
    tags: z.array(z.string()).default([]),
    rosVersion: z.string().min(1).optional(),
    sshPort: z.number().int().min(1).max(65535).optional(),
    sshUsername: z.string().min(1).optional(),
    sshPrivateKeyPath: z
      .string()
      .min(1)
      .refine(isAbsolute, "sshPrivateKeyPath must be absolute")
      .optional(),
    sshFingerprint: z.string().optional(),
    cmdAllow: z.array(z.string()).optional(),
    cmdDeny: z.array(z.string()).optional(),
    maintenanceWindows: z
      .array(
        z
          .object({
            days: z.array(z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])),
            startTime: z.string().regex(/^\d{2}:\d{2}$/, "startTime must be HH:MM"),
            endTime: z.string().regex(/^\d{2}:\d{2}$/, "endTime must be HH:MM"),
            timezone: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  // `tls` and `rosVersion` are only optional for SwOS switches, which have
  // neither (plain HTTP, no RouterOS version). Keeping them mandatory for
  // RouterOS prevents a missing/mistyped block from silently downgrading a
  // router to unencrypted HTTP or guessing the wrong REST paths.
  .superRefine((config, ctx) => {
    if (deviceTypeOf(config.deviceType) === "routeros") {
      if (!config.tls) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tls"],
          message: "tls is required for RouterOS devices",
        });
      }
      if (!config.rosVersion) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rosVersion"],
          message: "rosVersion is required for RouterOS devices",
        });
      }
      return;
    }
    if (config.tls?.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tls", "enabled"],
        message: "SwOS devices speak plain HTTP only; tls.enabled must be false",
      });
    }
  });

/** Resolve a configured `deviceType` spelling to its canonical platform. */
function deviceTypeOf(configured: string | undefined): DeviceType {
  return configured ? DEVICE_TYPE_ALIASES[configured] : "routeros";
}

const ConfigFileSchema = z
  .object({
    routers: z.record(z.string(), RouterConfigSchema),
  })
  .strict();

export class RouterRegistry {
  private routers: Map<string, RouterConfig>;

  constructor(configPath: string) {
    this.routers = new Map();

    if (!existsSync(configPath)) {
      log.warn({ configPath }, "Router config file not found; starting with empty registry");
      return;
    }

    const raw = readFileSync(configPath, "utf-8");
    const parsed = parse(raw) as unknown;

    const result = ConfigFileSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.errors
        .map((e) => `  ${e.path.join(".")}: ${e.message}`)
        .join("\n");
      throw new Error(`Invalid router config at ${configPath}:\n${issues}`);
    }

    // A key path that passed the schema can still be unusable — a typo, or a
    // Docker mount that was never made. Check it here so the mistake fails at
    // startup rather than surfacing as INTERNAL_ERROR on the first SSH call.
    const keyIssues: string[] = [];
    for (const [id, config] of Object.entries(result.data.routers)) {
      if (config.sshPrivateKeyPath === undefined) continue;
      const problem = privateKeyReadError(config.sshPrivateKeyPath);
      if (problem !== null) {
        keyIssues.push(
          `  ${id}.sshPrivateKeyPath: not readable (${problem}) — ${config.sshPrivateKeyPath}`,
        );
      }
    }
    if (keyIssues.length > 0) {
      throw new Error(`Invalid router config at ${configPath}:\n${keyIssues.join("\n")}`);
    }

    for (const [id, config] of Object.entries(result.data.routers)) {
      const deviceType = deviceTypeOf(config.deviceType);
      // The schema guarantees tls and rosVersion for RouterOS devices, so these
      // fallbacks only ever apply to SwOS switches: plain HTTP, no ROS version.
      const routerConfig: RouterConfig = {
        ...config,
        id,
        deviceType,
        tls: config.tls ?? { enabled: false, rejectUnauthorized: true },
        rosVersion: config.rosVersion ?? "swos",
      };
      if (routerConfig.tls.enabled && !routerConfig.tls.rejectUnauthorized) {
        log.warn(
          { routerId: id },
          "TLS certificate validation is DISABLED (rejectUnauthorized=false). " +
            "Set tls.fingerprint to pin the server certificate instead.",
        );
      }
      if (
        routerConfig.sshPrivateKeyPath !== undefined &&
        privateKeyIsShared(routerConfig.sshPrivateKeyPath)
      ) {
        log.warn(
          { routerId: id, sshPrivateKeyPath: routerConfig.sshPrivateKeyPath },
          "SSH private key is readable by group or others — restrict it to the owner (chmod 0600).",
        );
      }
      this.routers.set(id, routerConfig);
    }
    log.info({ count: this.routers.size }, "Loaded routers from config");
  }

  getRouter(id: string): RouterConfig {
    const router = this.routers.get(id);
    if (!router) {
      const available = this.routerIds();
      throw new MikroMCPError({
        category: ErrorCategory.NOT_FOUND,
        code: "ROUTER_NOT_FOUND",
        message:
          available.length > 0
            ? `Router not found: ${id}. Available: ${available.join(", ")}.`
            : `Router not found: ${id}. No routers are configured.`,
        details: { routerId: id, availableRouters: available },
        recoverability: {
          retryable: false,
          suggestedAction: "Check the routerId, or use list_routers to see the configured routers.",
          alternativeTools: ["list_routers"],
        },
      });
    }
    return router;
  }

  listRouters(tags?: string[]): RouterConfig[] {
    const all = Array.from(this.routers.values());
    if (!tags || tags.length === 0) return all;
    return all.filter((r) => tags.some((t) => r.tags.includes(t)));
  }

  hasRouter(id: string): boolean {
    return this.routers.has(id);
  }

  /** The id of the only configured router, or undefined when zero or more than one exist. */
  soleRouterId(): string | undefined {
    return this.routers.size === 1 ? this.routers.keys().next().value : undefined;
  }

  /** All configured router ids, for error messages and discovery. */
  routerIds(): string[] {
    return Array.from(this.routers.keys());
  }
}
