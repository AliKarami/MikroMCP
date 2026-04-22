// ---------------------------------------------------------------------------
// MikroMCP - Tool registry aggregation
// ---------------------------------------------------------------------------

import type { ToolDefinition } from "./tool-definition.js";
import { systemTools } from "./system-tools.js";
import { interfaceTools } from "./interface-tools.js";
import { ipTools } from "./ip-tools.js";

export const allTools: ToolDefinition[] = [
  ...systemTools,
  ...interfaceTools,
  ...ipTools,
];

export type { ToolDefinition, ToolContext, ToolResult, ToolAnnotations } from "./tool-definition.js";
