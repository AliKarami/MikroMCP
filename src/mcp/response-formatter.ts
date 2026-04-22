// ---------------------------------------------------------------------------
// MikroMCP - MCP response formatting
// ---------------------------------------------------------------------------

import type { ToolResult } from "../domain/tools/tool-definition.js";
import { MikroMCPError } from "../domain/errors/error-types.js";

export interface McpToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function formatToolResult(result: ToolResult): McpToolResponse {
  return {
    content: [{ type: "text", text: result.content }],
    structuredContent: result.structuredContent,
    ...(result.isError ? { isError: true } : {}),
  };
}

export function formatError(error: MikroMCPError): McpToolResponse {
  const hint = error.recoverability.suggestedAction;
  const text = `Error [${error.category}]: ${error.message}${hint ? `\nSuggested action: ${hint}` : ""}`;

  return {
    content: [{ type: "text", text }],
    structuredContent: error.toJSON(),
    isError: true,
  };
}
