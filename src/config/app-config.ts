export interface AppConfig {
  transport: "stdio" | "http";
  port: number;
  bindHost: string;
  logLevel: string;
  configPath: string;
  dataDir: string;
  cmdAllow: string[];
  cmdDeny: string[];
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
  pagination: {
    defaultLimit: number;
    maxLimit: number;
  };
}

export function loadAppConfig(): AppConfig {
  const env = process.env;

  return {
    transport: env.MIKROMCP_TRANSPORT === "http" ? "http" : "stdio",
    port: parseInt(env.MIKROMCP_PORT ?? "3000", 10),
    bindHost: env.MIKROMCP_BIND_HOST ?? "127.0.0.1",
    logLevel: env.MIKROMCP_LOG_LEVEL ?? "info",
    configPath: env.MIKROMCP_CONFIG_PATH ?? "config/routers.yaml",
    dataDir: env.MIKROMCP_DATA_DIR ?? "data",
    cmdAllow: (env.MIKROMCP_CMD_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    cmdDeny: (env.MIKROMCP_CMD_DENY ?? "").split(",").map((s) => s.trim()).filter(Boolean),
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
    pagination: {
      defaultLimit: 100,
      maxLimit: 500,
    },
  };
}
