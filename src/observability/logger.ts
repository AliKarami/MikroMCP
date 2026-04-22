// ---------------------------------------------------------------------------
// MikroMCP - Structured logging with pino
// ---------------------------------------------------------------------------

import pino from "pino";

const isDevelopment = process.env.NODE_ENV === "development";
const level = process.env.MIKROMCP_LOG_LEVEL ?? "info";

const baseOptions: pino.LoggerOptions = {
  level,
  redact: ["password", "authorization", "credentials", "secret"],
  base: { service: "mikromcp" },
};

const transport: pino.TransportSingleOptions | undefined = isDevelopment
  ? { target: "pino-pretty" }
  : undefined;

// Always write to stderr (fd 2) -- stdout is reserved for MCP stdio transport
const rootLogger: pino.Logger = transport
  ? pino(baseOptions, pino.transport({ ...transport, options: { ...transport.options, destination: 2 } }))
  : pino(baseOptions, pino.destination(2));

/**
 * Create a child logger bound with the given component name.
 */
export function createLogger(component: string): pino.Logger {
  return rootLogger.child({ component });
}

/** Default application logger. */
export const logger = createLogger("main");
