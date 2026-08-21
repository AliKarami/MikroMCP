import { z } from "zod";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import type { RouterOSRestClient } from "../../adapter/rest-client.js";
import type { SwosClient } from "../../adapter/swos-client.js";
import type { DeviceClient } from "../../adapter/connection-pool.js";
import type { DeviceType, RouterConfig } from "../../types.js";
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
  /**
   * Paths whose state is captured before the write, so `rollback_change` can
   * restore it. A function when the target depends on the call's arguments
   * (e.g. the SwOS endpoint being written).
   */
  snapshotPaths?: string[] | ((params: Record<string, unknown>) => string[]);
  /** When true, tool-registry skips per-router setup (routerId, circuit breaker, client). Use for fleet tools that manage their own router contexts. */
  skipRouterContext?: boolean;
  /**
   * Device platform this tool runs on. Defaults to "routeros"; the executor
   * refuses to run a tool against a device whose platform does not match.
   * Use "any" for tools that handle every platform themselves.
   */
  platform?: ToolPlatform;
  handler: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

/** Platform a tool targets: a concrete device type, or "any" for platform-aware tools. */
export type ToolPlatform = DeviceType | "any";

/** Snapshot paths for one call, resolving the argument-derived form. */
export function snapshotPathsFor(tool: ToolDefinition, params: Record<string, unknown>): string[] {
  return typeof tool.snapshotPaths === "function"
    ? tool.snapshotPaths(params)
    : (tool.snapshotPaths ?? []);
}

export interface ToolContext {
  /**
   * Pooled RouterOS REST client. Platform gating guarantees this is a real REST
   * client for every tool that declares (or defaults to) `platform: "routeros"`.
   * Tools with `platform: "any"` must check `deviceClient` instead.
   */
  routerClient: RouterOSRestClient;
  /** The pooled client as it actually is — a REST client or a SwOS client. */
  deviceClient: DeviceClient;
  /** SwOS ".b" API client, only set when the router's deviceType is "swos". */
  swosClient?: SwosClient;
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

/**
 * Stand-in for a context capability that does not exist for this call. Touching
 * any member throws a typed error instead of the `TypeError` a `null` cast
 * would produce.
 */
export function unavailableCapability<T extends object>(
  code: string,
  message: string,
  suggestedAction: string,
): T {
  return new Proxy({} as T, {
    get() {
      throw new MikroMCPError({
        category: ErrorCategory.INTERNAL,
        code,
        message,
        recoverability: { retryable: false, suggestedAction },
      });
    },
  });
}
