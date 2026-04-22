// ---------------------------------------------------------------------------
// MikroMCP - Tool definition types
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { RouterOSRestClient } from "../../adapter/rest-client.js";

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
  handler: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  routerClient: RouterOSRestClient;
  routerId: string;
  correlationId: string;
}

export interface ToolResult {
  content: string;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}
