import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { RouterConfig } from "../types.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("router-registry");

const RouterConfigSchema = z.object({
  host: z.string().min(1, "host is required"),
  port: z.number().int().min(1).max(65535),
  tls: z.object({
    enabled: z.boolean(),
    rejectUnauthorized: z.boolean(),
    ca: z.string().optional(),
  }),
  credentials: z.object({
    source: z.enum(["env", "vault"]),
    envPrefix: z.string().optional(),
    vaultPath: z.string().optional(),
  }),
  tags: z.array(z.string()).default([]),
  rosVersion: z.string().min(1),
  sshPort: z.number().int().min(1).max(65535).optional(),
  cmdAllow: z.array(z.string()).optional(),
  cmdDeny: z.array(z.string()).optional(),
});

const ConfigFileSchema = z.object({
  routers: z.record(z.string(), RouterConfigSchema),
});

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
      this.routers.set(id, { ...config, id } as RouterConfig);
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
}
