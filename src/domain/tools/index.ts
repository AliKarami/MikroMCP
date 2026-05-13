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
import { diagnosticTools } from "./diagnostic-tools.js";
import { systemOpsTools } from "./system-ops-tools.js";
import { bridgeTools } from "./bridge-tools.js";
import { wifiTools } from "./wifi-tools.js";
import { wireguardTools } from "./wireguard-tools.js";
import { dnsTools } from "./dns-tools.js";
import { mangleTools } from "./mangle-tools.js";
import { addressListTools } from "./address-list-tools.js";
import { policyRoutingTools } from "./policy-routing-tools.js";
import { routingProtocolTools } from "./routing-protocol-tools.js";
import { scriptsTools } from "./scripts-tools.js";

export const allTools: ToolDefinition[] = [
  ...systemTools,
  ...interfaceTools,
  ...ipTools,
  ...dhcpTools,
  ...routeTools,
  ...firewallTools,
  ...diagnosticTools,
  ...systemOpsTools,
  ...bridgeTools,
  ...wifiTools,
  ...wireguardTools,
  ...dnsTools,
  ...mangleTools,
  ...addressListTools,
  ...policyRoutingTools,
  ...routingProtocolTools,
  ...scriptsTools,
];

export type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ToolAnnotations,
} from "./tool-definition.js";
