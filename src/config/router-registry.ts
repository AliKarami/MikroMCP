import { readFileSync, existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parse, YAMLError } from "yaml";
import { z } from "zod";
import type { DeviceType, RouterConfig } from "../types.js";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";
import { createLogger } from "../observability/logger.js";
import { privateKeyIsShared, privateKeyReadError, sshFingerprintHex } from "./ssh-key.js";

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
    // Stored as lowercase hex, the form SshClient compares. A malformed value can
    // never match a host key, so it fails here instead of on every SSH call.
    sshFingerprint: z
      .string()
      .transform((value, ctx) => {
        const hex = sshFingerprintHex(value);
        if (hex !== null) return hex;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "sshFingerprint must be a SHA-256 host-key fingerprint: 64 hex characters " +
            "(colons allowed) or SHA256:<base64> as ssh-keygen -l prints it",
        });
        return z.NEVER;
      })
      .optional(),
    cmdAllow: z.array(z.string()).optional(),
    cmdDeny: z.array(z.string()).optional(),
    // The MIKROMCP_SECRET_<NAME> values this device may use: a switch config
    // applied to a SwOS switch, create_backup's passwordSecret on RouterOS.
    // Without the list it may use none.
    secrets: z
      .array(
        z.string().regex(/^[A-Z0-9_]+$/, "a secret name is the NAME of MIKROMCP_SECRET_<NAME>"),
      )
      .optional(),
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

/**
 * Where the registry's routers came from, highest precedence first:
 * `inline` (MIKROMCP_ROUTERS), `file` (routers.yaml), `env` (the flat
 * MIKROMCP_ROUTER_* variables), or `none`.
 */
export type RouterSource = "inline" | "file" | "env" | "none";

export const INLINE_ROUTERS_VAR = "MIKROMCP_ROUTERS";
export const ENV_ROUTER_PREFIX = "MIKROMCP_ROUTER";
const ENV_ROUTER_HOST_VAR = `${ENV_ROUTER_PREFIX}_HOST`;
const ENV_ROUTER_DEFAULT_ID = "default";

/** Router field -> the flat variable that sets it; `_USER` and `_PASS` are read by secrets.ts. */
const ENV_ROUTER_FIELDS: Record<string, string> = {
  host: "HOST",
  port: "PORT",
  "tls.enabled": "TLS",
  "tls.rejectUnauthorized": "TLS_INSECURE",
  "tls.fingerprint": "TLS_FINGERPRINT",
  tags: "TAGS",
  rosVersion: "ROS_VERSION",
};
const ENV_ROUTER_SETTINGS = [
  "ID",
  "HOST",
  "PORT",
  "TLS",
  "TLS_INSECURE",
  "TLS_FINGERPRINT",
  "ROS_VERSION",
  "TAGS",
].map((name) => `${ENV_ROUTER_PREFIX}_${name}`);

type ConfigFile = z.infer<typeof ConfigFileSchema>;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function issueLines(error: z.ZodError, pathName: (path: (string | number)[]) => string): string {
  return error.errors.map((e) => `  ${pathName(e.path)}: ${e.message}`).join("\n");
}

function dottedPath(path: (string | number)[]): string {
  return path.length > 0 ? path.join(".") : "(root)";
}

/** `routers.<id>.port` -> `MIKROMCP_ROUTER_PORT`, so an error names the variable to fix. */
function envVarPath(path: (string | number)[]): string {
  const field = ENV_ROUTER_FIELDS[path.slice(2).join(".")] ?? ENV_ROUTER_FIELDS[String(path[2])];
  return field ? `${ENV_ROUTER_PREFIX}_${field}` : dottedPath(path);
}

function envBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return undefined;
  const value = raw.toLowerCase();
  if (["true", "yes", "1"].includes(value)) return true;
  if (["false", "no", "0"].includes(value)) return false;
  throw new Error(`${name} must be true or false, got "${raw}".`);
}

function envPort(env: NodeJS.ProcessEnv, fallback: number): number {
  const name = `${ENV_ROUTER_PREFIX}_PORT`;
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535, got "${raw}".`);
  }
  return value;
}

/**
 * Parse MIKROMCP_ROUTERS (YAML, or JSON, which YAML accepts). The parser's own
 * message quotes the offending source line, which could hold anything the user
 * pasted, so only its position and code are reported.
 */
function parseInlineRouters(raw: string): unknown {
  try {
    return parse(raw) as unknown;
  } catch (err) {
    if (err instanceof YAMLError) {
      const pos = err.linePos?.[0];
      const where = pos ? `line ${pos.line}, column ${pos.col}` : `offset ${err.pos[0]}`;
      throw new Error(
        `Invalid router config in ${INLINE_ROUTERS_VAR}: not valid YAML or JSON (${err.code} at ${where}).`,
      );
    }
    throw err;
  }
}

/** Build a one-router config file from the flat MIKROMCP_ROUTER_* variables. */
function routersFromEnv(env: NodeJS.ProcessEnv, host: string): unknown {
  const id = nonEmpty(env[`${ENV_ROUTER_PREFIX}_ID`]) ?? ENV_ROUTER_DEFAULT_ID;
  const tlsVar = `${ENV_ROUTER_PREFIX}_TLS`;
  const insecureVar = `${ENV_ROUTER_PREFIX}_TLS_INSECURE`;
  const fingerprintVar = `${ENV_ROUTER_PREFIX}_TLS_FINGERPRINT`;
  const tlsEnabled = envBoolean(env, tlsVar) ?? true;
  const insecure = envBoolean(env, insecureVar) ?? false;
  const fingerprint = nonEmpty(env[fingerprintVar]);

  if (!tlsEnabled && (insecure || fingerprint !== undefined)) {
    throw new Error(
      `${tlsVar}=false turns TLS off, so ${insecure ? insecureVar : fingerprintVar} cannot apply. ` +
        `Unset one of them.`,
    );
  }
  if (!tlsEnabled) {
    log.warn(
      { routerId: id },
      `TLS is DISABLED (${tlsVar}=false): the router password is sent over plain HTTP.`,
    );
  }

  const tags = (env[`${ENV_ROUTER_PREFIX}_TAGS`] ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  return {
    routers: {
      [id]: {
        host,
        port: envPort(env, tlsEnabled ? 443 : 80),
        tls: {
          enabled: tlsEnabled,
          rejectUnauthorized: !insecure,
          ...(fingerprint !== undefined ? { fingerprint } : {}),
        },
        credentials: { source: "env", envPrefix: ENV_ROUTER_PREFIX },
        tags,
        rosVersion: nonEmpty(env[`${ENV_ROUTER_PREFIX}_ROS_VERSION`]) ?? "7",
      },
    },
  };
}

/** What a reload would do to the registry, by router id. Field names only, never values. */
export interface RouterChanges {
  added: string[];
  removed: string[];
  changed: { id: string; fields: string[] }[];
  unchanged: string[];
}

interface ResolvedRouters {
  routers: Map<string, RouterConfig>;
  source: RouterSource;
  ignored: string[];
}

export class RouterRegistry {
  private routers: Map<string, RouterConfig>;
  private routerSource: RouterSource = "none";
  private ignored: string[] = [];

  /**
   * Routers come from the first source that is set: MIKROMCP_ROUTERS (inline
   * YAML/JSON), the file at `configPath`, then the flat MIKROMCP_ROUTER_*
   * variables. `env` is injectable so tests need not touch process.env.
   */
  constructor(
    private readonly configPath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    const resolved = RouterRegistry.resolve(configPath, env, true);
    this.routers = resolved.routers;
    this.routerSource = resolved.source;
    this.ignored = resolved.ignored;
  }

  /**
   * Resolve the routers again from the same sources and report what differs
   * from what is loaded. Nothing changes until `commit()`; a file that is
   * invalid, or that was loaded at startup and is gone now, throws here, so
   * the loaded routers stay in force. The environment is the one the server
   * started with, so MIKROMCP_ROUTERS and MIKROMCP_ROUTER_* are not re-read.
   */
  prepareReload(): { changes: RouterChanges; commit: () => void } {
    const resolved = RouterRegistry.resolve(this.configPath, this.env, false);
    if (this.routerSource === "file" && resolved.source !== "file") {
      throw new Error(`Router config file not found at ${this.configPath}`);
    }
    const next = resolved.routers;
    const changes: RouterChanges = { added: [], removed: [], changed: [], unchanged: [] };
    for (const [id, config] of next) {
      const current = this.routers.get(id);
      if (!current) {
        changes.added.push(id);
        continue;
      }
      const fields = [...new Set([...Object.keys(current), ...Object.keys(config)])].filter(
        (key) =>
          JSON.stringify((current as unknown as Record<string, unknown>)[key]) !==
          JSON.stringify((config as unknown as Record<string, unknown>)[key]),
      );
      if (fields.length > 0) changes.changed.push({ id, fields });
      else changes.unchanged.push(id);
    }
    for (const id of this.routers.keys()) if (!next.has(id)) changes.removed.push(id);
    return {
      changes,
      commit: () => {
        this.routers = next;
        this.routerSource = resolved.source;
        this.ignored = resolved.ignored;
      },
    };
  }

  /** Where the routers came from; see {@link RouterSource}. */
  get source(): RouterSource {
    return this.routerSource;
  }

  /** Lower-precedence router sources that were set but ignored, e.g. `MIKROMCP_ROUTER_* variables`. */
  get ignoredSources(): readonly string[] {
    return this.ignored;
  }

  private static describeSource(source: RouterSource, configPath: string): string {
    switch (source) {
      case "inline":
        return INLINE_ROUTERS_VAR;
      case "file":
        return `config file ${configPath}`;
      default:
        return `${ENV_ROUTER_PREFIX}_* variables`;
    }
  }

  /** Pick the source, read and validate it. `announce` is false on a reload, which would only repeat the startup warnings. */
  private static resolve(
    configPath: string,
    env: NodeJS.ProcessEnv,
    announce: boolean,
  ): ResolvedRouters {
    const routers = new Map<string, RouterConfig>();
    const ignored: string[] = [];
    let source: RouterSource = "none";

    const inline = nonEmpty(env[INLINE_ROUTERS_VAR]);
    const fileExists = existsSync(configPath);
    const envHost = nonEmpty(env[ENV_ROUTER_HOST_VAR]);

    if (inline !== undefined) {
      source = "inline";
      if (fileExists) ignored.push(`config file ${configPath}`);
      if (envHost !== undefined) ignored.push(`${ENV_ROUTER_PREFIX}_* variables`);
    } else if (fileExists) {
      source = "file";
      if (envHost !== undefined) ignored.push(`${ENV_ROUTER_PREFIX}_* variables`);
    } else if (envHost !== undefined) {
      source = "env";
    }

    if (announce && ignored.length > 0) {
      log.warn(
        { source, ignored },
        `Routers come from ${RouterRegistry.describeSource(source, configPath)}; ignoring ${ignored.join(" and ")}`,
      );
    }
    if (announce && envHost === undefined) {
      const stray = ENV_ROUTER_SETTINGS.filter((name) => nonEmpty(env[name]) !== undefined);
      if (stray.length > 0) {
        log.warn(
          { variables: stray },
          `${stray.join(", ")} set without ${ENV_ROUTER_HOST_VAR}; they are ignored`,
        );
      }
    }

    if (inline !== undefined) {
      RouterRegistry.load(
        routers,
        parseInlineRouters(inline),
        `in ${INLINE_ROUTERS_VAR}`,
        dottedPath,
      );
    } else if (fileExists) {
      RouterRegistry.load(
        routers,
        parse(readFileSync(configPath, "utf-8")) as unknown,
        `at ${configPath}`,
        dottedPath,
      );
    } else if (envHost !== undefined) {
      RouterRegistry.load(
        routers,
        routersFromEnv(env, envHost),
        `from ${ENV_ROUTER_PREFIX}_* variables`,
        envVarPath,
      );
    } else {
      if (announce) {
        log.warn(
          { configPath },
          `Router config file not found and neither ${INLINE_ROUTERS_VAR} nor ` +
            `${ENV_ROUTER_HOST_VAR} is set; starting with empty registry`,
        );
      }
      return { routers, source, ignored };
    }

    if (announce) {
      log.info(
        {
          source,
          ...(source === "file" ? { configPath } : {}),
          count: routers.size,
        },
        "Loaded routers",
      );
    }
    return { routers, source, ignored };
  }

  private static load(
    routers: Map<string, RouterConfig>,
    data: unknown,
    origin: string,
    pathName: (path: (string | number)[]) => string,
  ): void {
    const result = ConfigFileSchema.safeParse(data);
    if (!result.success) {
      throw new Error(`Invalid router config ${origin}:\n${issueLines(result.error, pathName)}`);
    }
    const file: ConfigFile = result.data;

    // A key path that passed the schema can still be unusable — a typo, or a
    // Docker mount that was never made. Check it here so the mistake fails at
    // startup rather than surfacing as INTERNAL_ERROR on the first SSH call.
    const keyIssues: string[] = [];
    for (const [id, config] of Object.entries(file.routers)) {
      if (config.sshPrivateKeyPath === undefined) continue;
      const problem = privateKeyReadError(config.sshPrivateKeyPath);
      if (problem !== null) {
        keyIssues.push(
          `  ${id}.sshPrivateKeyPath: not readable (${problem}) — ${config.sshPrivateKeyPath}`,
        );
      }
    }
    if (keyIssues.length > 0) {
      throw new Error(`Invalid router config ${origin}:\n${keyIssues.join("\n")}`);
    }

    for (const [id, config] of Object.entries(file.routers)) {
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
      routers.set(id, routerConfig);
    }
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
