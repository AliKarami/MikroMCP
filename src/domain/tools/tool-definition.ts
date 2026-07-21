import { z } from "zod";
import { enrichError } from "../errors/error-enricher.js";
import type { MikroMCPError } from "../errors/error-types.js";
import type { RouterOSRestClient } from "../../adapter/rest-client.js";
import type { RouterConfig } from "../../types.js";
import type { Identity } from "../../types.js";
import type { SshClient } from "../../adapter/ssh-client.js";
import type { FtpClient } from "../../adapter/ftp-client.js";
import type { SftpClient } from "../../adapter/sftp-client.js";
import type { RouterRegistry } from "../../config/router-registry.js";
import type { ConnectionPool } from "../../adapter/connection-pool.js";
import type { CircuitBreaker } from "../../adapter/circuit-breaker.js";
import type { AppConfig } from "../../config/app-config.js";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
  annotations: ToolAnnotations;
  /**
   * When false, a read-only tool is NOT auto-retried by the executor. Use for
   * read tools whose call has side effects or cost that make a silent retry
   * undesirable (e.g. an external HTTP request or a timed saturation test).
   * Defaults to true (retry enabled) for read tools.
   */
  retryable?: boolean;
  snapshotPaths?: string[];
  /** When true, tool-registry skips per-router setup (routerId, circuit breaker, client). Use for fleet tools that manage their own router contexts. */
  skipRouterContext?: boolean;
  handler: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  routerClient: RouterOSRestClient;
  routerId: string;
  correlationId: string;
  routerConfig: RouterConfig;
  sshClient: SshClient;
  ftpClient: FtpClient;
  sftpClient: SftpClient;
  identity: Identity;
  routerRegistry?: RouterRegistry;
  connectionPool?: ConnectionPool;
  /** Per-router circuit breaker — set for router-context calls; used by apply_plan to gate sub-steps. */
  circuitBreaker?: CircuitBreaker;
  /** Registry of per-router circuit breakers — set for fleet tools so bulk_execute can gate each router. */
  circuitBreakers?: Map<string, CircuitBreaker>;
  /** Server-wide configuration. Use this instead of reading process.env in tool handlers. */
  appConfig: AppConfig;
}

export interface ToolResult {
  content: string;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

/** Enrich a caught error with router/tool context for a handler catch block. */
export function toolError(err: unknown, context: ToolContext, tool: string): MikroMCPError {
  return enrichError(err, { routerId: context.routerId, tool });
}
