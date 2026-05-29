import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { RouterConfig } from "../types.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("router-registry");

const RouterConfigSchema = z
  .object({
    host: z.string().min(1, "host is required"),
    port: z.number().int().min(1).max(65535),
    tls: z
      .object({
        enabled: z.boolean(),
        rejectUnauthorized: z.boolean(),
        ca: z.string().optional(),
        fingerprint: z.string().optional(),
      })
      .strict(),
    credentials: z
      .object({
        source: z.enum(["env", "vault"]),
        envPrefix: z.string().optional(),
        vaultPath: z.string().optional(),
      })
      .strict(),
    tags: z.array(z.string()).default([]),
    rosVersion: z.string().min(1),
    sshPort: z.number().int().min(1).max(65535).optional(),
    sshFingerprint: z.string().optional(),
    cmdAllow: z.array(z.string()).optional(),
    cmdDeny: z.array(z.string()).optional(),
    maintenanceWindows: z
      .array(
        z.object({
          days: z.array(
            z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
          ),
          startTime: z.string().regex(/^\d{2}:\d{2}$/, "startTime must be HH:MM"),
          endTime: z.string().regex(/^\d{2}:\d{2}$/, "endTime must be HH:MM"),
          timezone: z.string().min(1),
        }).strict(),
      )
      .optional(),
  })
  .strict();

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

    for (const [id, config] of Object.entries(result.data.routers)) {
      const routerConfig = { ...config, id } as RouterConfig;
      if (routerConfig.tls.enabled && !routerConfig.tls.rejectUnauthorized) {
        log.warn(
          { routerId: id },
          "TLS certificate validation is DISABLED (rejectUnauthorized=false). " +
            "Set tls.fingerprint to pin the server certificate instead.",
        );
      }
      this.routers.set(id, routerConfig);
    }
    log.info({ count: this.routers.size }, "Loaded routers from config");
  }

  getRouter(id: string): RouterConfig {
    const router = this.routers.get(id);
    if (!router) {
      throw new Error(`Router not found: ${id}`);
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
