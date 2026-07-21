export interface AppConfig {
  transport: "stdio" | "http";
  port: number;
  bindHost: string;
  logLevel: string;
  configPath: string;
  defaultRouter: string | undefined;
  dataDir: string;
  snapshotDir: string;
  journalPath: string;
  cmdAllow: string[];
  cmdDeny: string[];
  identitiesPath: string;
  stdioIdentity: string | undefined;
  confirmationSecret: string | undefined;
  auditLogPath: string | undefined;
  http: {
    maxBodyBytes: number;
    rateLimitRpm: number;
  };
  ssh: {
    commandTimeoutMs: number;
    maxOutputBytes: number;
  };
  retry: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  circuitBreaker: {
    failureThreshold: number;
    cooldownMs: number;
  };
  retention: {
    snapshotMaxAgeDays: number;
  };
}

import { join } from "node:path";
import { homedir } from "node:os";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";

function mikromcpDir(): string {
  return join(homedir(), ".mikromcp");
}

/** Parse an integer env var, throwing a CONFIGURATION error on a non-numeric value. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new MikroMCPError({
      category: ErrorCategory.CONFIGURATION,
      code: "INVALID_ENV_INT",
      message: `Environment variable ${name} must be an integer, got "${raw}".`,
      details: { variable: name, value: raw },
      recoverability: {
        retryable: false,
        suggestedAction: `Set ${name} to an integer, or unset it to use the default (${fallback}).`,
      },
    });
  }
  return value;
}

export function loadAppConfig(): AppConfig {
  const env = process.env;
  const dataDir = env.MIKROMCP_DATA_DIR ?? join(mikromcpDir(), "data");

  return {
    transport: env.MIKROMCP_TRANSPORT === "http" ? "http" : "stdio",
    port: intEnv("MIKROMCP_PORT", 3000),
    bindHost: env.MIKROMCP_BIND_HOST ?? "127.0.0.1",
    logLevel: env.MIKROMCP_LOG_LEVEL ?? "info",
    configPath: env.MIKROMCP_CONFIG_PATH ?? join(mikromcpDir(), "routers.yaml"),
    defaultRouter: env.MIKROMCP_DEFAULT_ROUTER || undefined,
    dataDir,
    snapshotDir: `${dataDir}/snapshots`,
    journalPath: `${dataDir}/write-journal.ndjson`,
    cmdAllow: (env.MIKROMCP_CMD_ALLOW ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    cmdDeny: (env.MIKROMCP_CMD_DENY ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    identitiesPath: env.MIKROMCP_IDENTITIES_PATH ?? join(mikromcpDir(), "identities.yaml"),
    stdioIdentity: env.MIKROMCP_STDIO_IDENTITY || undefined,
    confirmationSecret: env.MIKROMCP_CONFIRMATION_SECRET || undefined,
    auditLogPath: env.MIKROMCP_AUDIT_LOG_PATH || undefined,
    http: {
      maxBodyBytes: intEnv("MIKROMCP_HTTP_MAX_BODY_BYTES", 1024 * 1024),
      rateLimitRpm: intEnv("MIKROMCP_HTTP_RATE_LIMIT_RPM", 60),
    },
    ssh: {
      commandTimeoutMs: intEnv("MIKROMCP_SSH_COMMAND_TIMEOUT_MS", 30000),
      maxOutputBytes: intEnv("MIKROMCP_SSH_MAX_OUTPUT_BYTES", 512 * 1024),
    },
    retry: {
      maxRetries: 3,
      baseDelayMs: 200,
      maxDelayMs: 5_000,
    },
    circuitBreaker: {
      failureThreshold: 5,
      cooldownMs: 30_000,
    },
    retention: {
      snapshotMaxAgeDays: intEnv("MIKROMCP_SNAPSHOT_RETENTION_DAYS", 30),
    },
  };
}
