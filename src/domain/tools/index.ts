// ---------------------------------------------------------------------------
// MikroMCP - Tool registry aggregation
// ---------------------------------------------------------------------------

import type { ToolDefinition } from "./tool-definition.js";
import { systemTools } from "./system-tools.js";
import { interfaceTools } from "./interface-tools.js";
import { ipTools } from "./ip-tools.js";
import { dhcpTools } from "./dhcp-tools.js";
import { routeTools } from "./route-tools.js";
import { firewallTools } from "./firewall-tools.js";

export const allTools: ToolDefinition[] = [
  ...systemTools,
  ...interfaceTools,
  ...ipTools,
  ...dhcpTools,
  ...routeTools,
  ...firewallTools,
];

export type { ToolDefinition, ToolContext, ToolResult, ToolAnnotations } from "./tool-definition.js";
