export interface AppConfig {
  transport: "stdio" | "http";
  port: number;
  bindHost: string;
  logLevel: string;
  configPath: string;
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
}

import { join } from "node:path";
import { homedir } from "node:os";

function mikromcpDir(): string {
  return join(homedir(), ".mikromcp");
}

export function loadAppConfig(): AppConfig {
  const env = process.env;
  const dataDir = env.MIKROMCP_DATA_DIR ?? join(mikromcpDir(), "data");

  return {
    transport: env.MIKROMCP_TRANSPORT === "http" ? "http" : "stdio",
    port: parseInt(env.MIKROMCP_PORT ?? "3000", 10),
    bindHost: env.MIKROMCP_BIND_HOST ?? "127.0.0.1",
    logLevel: env.MIKROMCP_LOG_LEVEL ?? "info",
    configPath: env.MIKROMCP_CONFIG_PATH ?? join(mikromcpDir(), "routers.yaml"),
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
      maxBodyBytes: parseInt(env.MIKROMCP_HTTP_MAX_BODY_BYTES ?? String(1024 * 1024), 10),
      rateLimitRpm: parseInt(env.MIKROMCP_HTTP_RATE_LIMIT_RPM ?? "60", 10),
    },
    ssh: {
      commandTimeoutMs: parseInt(env.MIKROMCP_SSH_COMMAND_TIMEOUT_MS ?? "30000", 10),
      maxOutputBytes: parseInt(env.MIKROMCP_SSH_MAX_OUTPUT_BYTES ?? String(512 * 1024), 10),
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
  };
}
