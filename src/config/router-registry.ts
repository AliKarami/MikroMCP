// ---------------------------------------------------------------------------
// MikroMCP - Multi-router registry loaded from YAML
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import type { RouterConfig } from "../types.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("router-registry");

export class RouterRegistry {
  private routers: Map<string, RouterConfig>;

  constructor(configPath: string) {
    this.routers = new Map();

    if (!existsSync(configPath)) {
      log.warn({ configPath }, "Router config file not found; starting with empty registry");
      return;
    }

    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = parse(raw) as { routers?: RouterConfig[] } | null;

      if (parsed?.routers && Array.isArray(parsed.routers)) {
        for (const router of parsed.routers) {
          this.routers.set(router.id, router);
        }
        log.info({ count: this.routers.size }, "Loaded routers from config");
      }
    } catch (err) {
      log.error({ configPath, err }, "Failed to parse router config");
    }
  }

  /**
   * Retrieve a router by ID. Throws if not found.
   */
  getRouter(id: string): RouterConfig {
    const router = this.routers.get(id);
    if (!router) {
      throw new Error(`Router not found: ${id}`);
    }
    return router;
  }

  /**
   * List routers, optionally filtered by tags. Returns all routers when no
   * tags are provided.
   */
  listRouters(tags?: string[]): RouterConfig[] {
    const all = Array.from(this.routers.values());
    if (!tags || tags.length === 0) {
      return all;
    }
    return all.filter((r) => tags.some((t) => r.tags.includes(t)));
  }

  /**
   * Check whether a router with the given ID exists.
   */
  hasRouter(id: string): boolean {
    return this.routers.has(id);
  }
}
