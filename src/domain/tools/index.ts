import type { ToolDefinition } from "./tool-definition.js";
import { systemTools } from "./system-tools.js";
import { interfaceTools } from "./interface-tools.js";
import { ipTools } from "./ip-tools.js";
import { ipv6Tools } from "./ipv6-tools.js";
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
import { schedulerTools } from "./scheduler-tools.js";
import { packagesTools } from "./packages-tools.js";
import { filesTools } from "./files-tools.js";
import { containerTools } from "./container-tools.js";
import { createChangeManagementTools } from "./change-management-tools.js";
import { ipsecTools } from "./ipsec-tools.js";
import { certificateTools } from "./certificate-tools.js";
import { userTools } from "./user-tools.js";
import { userGroupTools } from "./user-group-tools.js";
import { dhcpServerTools } from "./dhcp-server-tools.js";
import { ipPoolTools } from "./ip-pool-tools.js";
import { queueTools } from "./queue-tools.js";
import { vrrpTools } from "./vrrp-tools.js";
import { networkServicesTools } from "./network-services-tools.js";
import { vlanTools } from "./vlan-tools.js";
import { dhcpClientTools } from "./dhcp-client-tools.js";
import { ipServiceTools } from "./ip-service-tools.js";
import { pppoeTools } from "./pppoe-tools.js";
import { ovpnTools } from "./ovpn-tools.js";
import { pppTools } from "./ppp-tools.js";
import { upgradeTools } from "./upgrade-tools.js";
import { backupTools } from "./backup-tools.js";
import { logTools } from "./log-tools.js";
import { networkTestTools } from "./network-test-tools.js";
import { containerConfigTools } from "./container-config-tools.js";
import { interfaceListTools } from "./interface-list-tools.js";
import { swosTools } from "./swos-tools.js";
import { swosConfigTools } from "./swos-config-tools.js";
import { swosMaintenanceTools } from "./swos-maintenance-tools.js";
import { createFleetTools } from "./fleet-tools.js";

/**
 * Tools grouped by area. MIKROMCP_TOOLSETS selects groups by these names to keep
 * the catalogue small; every tool belongs to exactly one group (a unit test
 * checks it), so a new tool file must be added to one of them.
 */
const baseToolsets = {
  system: [...systemTools, ...systemOpsTools, ...packagesTools, ...upgradeTools, ...backupTools],
  automation: [...scriptsTools, ...schedulerTools, ...filesTools],
  containers: [...containerTools, ...containerConfigTools],
  interfaces: [...interfaceTools, ...bridgeTools, ...vlanTools, ...interfaceListTools],
  wireless: [...wifiTools],
  ip: [...ipTools, ...ipv6Tools, ...ipPoolTools, ...ipServiceTools, ...dnsTools],
  dhcp: [...dhcpTools, ...dhcpServerTools, ...dhcpClientTools],
  routing: [...routeTools, ...policyRoutingTools, ...routingProtocolTools, ...vrrpTools],
  firewall: [...firewallTools, ...mangleTools, ...addressListTools],
  vpn: [...wireguardTools, ...ipsecTools, ...pppoeTools, ...ovpnTools, ...pppTools],
  access: [...userTools, ...userGroupTools, ...certificateTools],
  queues: [...queueTools],
  monitoring: [...diagnosticTools, ...networkTestTools, ...logTools, ...networkServicesTools],
  swos: [...swosTools, ...swosConfigTools, ...swosMaintenanceTools],
} satisfies Record<string, ToolDefinition[]>;

const baseTools: ToolDefinition[] = Object.values(baseToolsets).flat();

export const toolsets: Record<string, ToolDefinition[]> = {
  ...baseToolsets,
  change: createChangeManagementTools(baseTools),
  fleet: createFleetTools(baseTools),
};

export const allTools: ToolDefinition[] = Object.values(toolsets).flat();

/** Kept whatever MIKROMCP_TOOLSETS selects: the agent needs them to find its routers. */
export const ALWAYS_ON_TOOLS: ReadonlySet<string> = new Set([
  "list_routers",
  "check_router_health",
]);

export type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ToolAnnotations,
} from "./tool-definition.js";
