import { z } from "zod";
import type { RouterOSRestClient } from "../../adapter/rest-client.js";
import type { RouterConfig } from "../../types.js";
import type { Identity } from "../../types.js";
import type { SshClient } from "../../adapter/ssh-client.js";
import type { FtpClient } from "../../adapter/ftp-client.js";
import type { RouterRegistry } from "../../config/router-registry.js";
import type { ConnectionPool } from "../../adapter/connection-pool.js";

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
  identity: Identity;
  routerRegistry?: RouterRegistry;
  connectionPool?: ConnectionPool;
}

export interface ToolResult {
  content: string;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}
