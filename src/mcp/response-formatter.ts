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
  const { suggestedAction, alternativeTools, retryAfterMs } = error.recoverability;
  // Some clients (Claude Code among them) give the model only the text of an error
  // result, so the text must carry what structuredContent does — above all the
  // confirmationToken in details, without which a confirmation can't be completed.
  const lines = [`Error [${error.category}]: ${error.message}`];
  if (suggestedAction) lines.push(`Suggested action: ${suggestedAction}`);
  lines.push(`Code: ${error.code}`);
  if (error.details && Object.keys(error.details).length > 0) {
    lines.push(`Details: ${JSON.stringify(error.details)}`);
  }
  if (alternativeTools && alternativeTools.length > 0) {
    lines.push(`Alternative tools: ${alternativeTools.join(", ")}`);
  }
  if (retryAfterMs !== undefined) lines.push(`Retry after: ${retryAfterMs} ms`);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: error.toJSON(),
    isError: true,
  };
}
