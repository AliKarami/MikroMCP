// ---------------------------------------------------------------------------
// MikroMCP - Centralized application configuration
// ---------------------------------------------------------------------------

export interface AppConfig {
  transport: "stdio" | "http";
  port: number;
  logLevel: string;
  configPath: string;
  dataDir: string;
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

/**
 * Load application configuration from environment variables (MIKROMCP_ prefix)
 * with sensible defaults.
 */
export function loadAppConfig(): AppConfig {
  const env = process.env;

  const transport = env.MIKROMCP_TRANSPORT === "http" ? "http" : "stdio";
  const port = parseInt(env.MIKROMCP_PORT ?? "3000", 10);
  const logLevel = env.MIKROMCP_LOG_LEVEL ?? "info";
  const configPath = env.MIKROMCP_CONFIG_PATH ?? "config/routers.yaml";
  const dataDir = env.MIKROMCP_DATA_DIR ?? "data";

  return {
    transport,
    port,
    logLevel,
    configPath,
    dataDir,
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
