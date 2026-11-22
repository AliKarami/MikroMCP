import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";
import bcrypt from "bcryptjs";
import type { Identity, Role } from "../types.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("identity-registry");

const IdentityConfigSchema = z
  .object({
    token: z.string().min(1, "token hash is required"),
    role: z.enum(["readonly", "operator", "admin", "superadmin"]),
    allowedRouters: z.array(z.string()).default([]),
    allowedToolPatterns: z.array(z.string()).default([]),
  })
  .strict();

const ConfigFileSchema = z
  .object({
    identities: z.record(z.string(), IdentityConfigSchema),
  })
  .strict();

interface StoredIdentity {
  id: string;
  tokenHash: string;
  role: Role;
  allowedRouters: string[];
  allowedToolPatterns: string[];
}

/** What a reload would do to the identities, by id. */
export interface IdentityChanges {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

export class IdentityRegistry {
  private identities: StoredIdentity[];
  // Maps sha256(token) → resolved identity id. Avoids a bcrypt compare against
  // every identity on each authenticated request after the first match.
  private readonly tokenCache = new Map<string, string>();

  // A file that was there when loaded and is gone now is more likely a mistake
  // than a decision; one that never existed (stdio setups) stays optional.
  private fileExisted: boolean;

  constructor(private readonly configPath: string) {
    this.fileExisted = existsSync(configPath);
    this.identities = IdentityRegistry.load(configPath, true);
  }

  /**
   * Read and validate the identity file again and report which identities differ
   * from what is loaded. Nothing changes until `commit()`; a missing or invalid
   * file throws here, so the identities in force stay in force.
   */
  prepareReload(): {
    changes: IdentityChanges;
    hasLimitedRoles: boolean;
    commit: () => void;
  } {
    const next = IdentityRegistry.load(this.configPath, !this.fileExisted);
    const current = new Map(this.identities.map((i) => [i.id, i]));
    const changes: IdentityChanges = { added: [], removed: [], changed: [], unchanged: [] };
    for (const identity of next) {
      const before = current.get(identity.id);
      if (!before) changes.added.push(identity.id);
      else if (JSON.stringify(before) !== JSON.stringify(identity)) {
        changes.changed.push(identity.id);
      } else changes.unchanged.push(identity.id);
    }
    const kept = new Set(next.map((i) => i.id));
    for (const id of current.keys()) if (!kept.has(id)) changes.removed.push(id);
    return {
      changes,
      hasLimitedRoles: next.some((i) => i.role === "readonly" || i.role === "operator"),
      commit: () => {
        this.identities = next;
        this.fileExisted = existsSync(this.configPath);
        // A token revoked or re-roled by the new file must not stay cached.
        this.tokenCache.clear();
      },
    };
  }

  private static load(configPath: string, missingIsEmpty: boolean): StoredIdentity[] {
    const identities: StoredIdentity[] = [];
    if (!existsSync(configPath)) {
      if (!missingIsEmpty) {
        throw new Error(`Identity config file not found at ${configPath}`);
      }
      log.warn(
        { configPath },
        "Identity config file not found; starting with empty registry (stdio callers do not require it)",
      );
      return identities;
    }

    const raw = readFileSync(configPath, "utf-8");
    const parsed = parse(raw) as unknown;

    const result = ConfigFileSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.errors
        .map((e) => `  ${e.path.join(".")}: ${e.message}`)
        .join("\n");
      throw new Error(`Invalid identity config at ${configPath}:\n${issues}`);
    }

    for (const [id, config] of Object.entries(result.data.identities)) {
      identities.push({
        id,
        tokenHash: config.token,
        role: config.role as Role,
        allowedRouters: config.allowedRouters,
        allowedToolPatterns: config.allowedToolPatterns,
      });
    }

    log.info({ count: identities.length }, "Loaded identities from config");
    return identities;
  }

  getIdentities(): Identity[] {
    return this.identities.map(({ id, role, allowedRouters, allowedToolPatterns }) => ({
      id,
      role,
      allowedRouters,
      allowedToolPatterns,
    }));
  }

  async findIdentityByToken(token: string): Promise<Identity | null> {
    const cacheKey = createHash("sha256").update(token).digest("hex");
    const toIdentity = (stored: StoredIdentity): Identity => ({
      id: stored.id,
      role: stored.role,
      allowedRouters: stored.allowedRouters,
      allowedToolPatterns: stored.allowedToolPatterns,
    });

    const cachedId = this.tokenCache.get(cacheKey);
    if (cachedId !== undefined) {
      const stored = this.identities.find((i) => i.id === cachedId);
      if (stored) return toIdentity(stored);
      this.tokenCache.delete(cacheKey);
    }

    const loaded = this.identities;
    for (const stored of loaded) {
      const match = await bcrypt.compare(token, stored.tokenHash);
      if (match) {
        // A reload during the compare may have revoked this identity: look the
        // token up again in the list now in force instead of caching the old answer.
        if (loaded !== this.identities) return this.findIdentityByToken(token);
        this.tokenCache.set(cacheKey, stored.id);
        return toIdentity(stored);
      }
    }
    if (loaded !== this.identities) return this.findIdentityByToken(token);
    return null;
  }
}
