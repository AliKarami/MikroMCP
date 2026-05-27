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
import { createFleetTools } from "./fleet-tools.js";

const baseTools: ToolDefinition[] = [
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
  ...schedulerTools,
  ...packagesTools,
  ...filesTools,
  ...containerTools,
  ...ipsecTools,
  ...certificateTools,
  ...userTools,
  ...userGroupTools,
  ...dhcpServerTools,
  ...ipPoolTools,
  ...queueTools,
  ...vrrpTools,
  ...networkServicesTools,
  ...vlanTools,
  ...dhcpClientTools,
  ...ipServiceTools,
  ...pppoeTools,
  ...ovpnTools,
  ...pppTools,
  ...upgradeTools,
  ...backupTools,
  ...logTools,
  ...networkTestTools,
  ...containerConfigTools,
  ...interfaceListTools,
];

export const allTools: ToolDefinition[] = [
  ...baseTools,
  ...createChangeManagementTools(baseTools),
  ...createFleetTools(baseTools),
];

export type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ToolAnnotations,
} from "./tool-definition.js";
