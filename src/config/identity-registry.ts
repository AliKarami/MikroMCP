import { readFileSync, existsSync } from "node:fs";
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

export class IdentityRegistry {
  private identities: StoredIdentity[] = [];

  constructor(configPath: string) {
    if (!existsSync(configPath)) {
      log.warn(
        { configPath },
        "Identity config file not found; starting with empty registry (stdio callers do not require it)",
      );
      return;
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
      this.identities.push({
        id,
        tokenHash: config.token,
        role: config.role as Role,
        allowedRouters: config.allowedRouters,
        allowedToolPatterns: config.allowedToolPatterns,
      });
    }

    log.info({ count: this.identities.length }, "Loaded identities from config");
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
    for (const stored of this.identities) {
      const match = await bcrypt.compare(token, stored.tokenHash);
      if (match) {
        return {
          id: stored.id,
          role: stored.role,
          allowedRouters: stored.allowedRouters,
          allowedToolPatterns: stored.allowedToolPatterns,
        };
      }
    }
    return null;
  }
}
