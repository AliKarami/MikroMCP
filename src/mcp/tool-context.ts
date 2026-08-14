import type { RouterConfig } from "../types.js";
import type { Identity } from "../types.js";
import type { ToolContext } from "../domain/tools/tool-definition.js";
import { unavailableCapability } from "../domain/tools/tool-definition.js";
import type { ConnectionPool } from "../adapter/connection-pool.js";
import type { RouterOSRestClient } from "../adapter/rest-client.js";
import { SwosClient } from "../adapter/swos-client.js";
import type { RouterRegistry } from "../config/router-registry.js";
import type { AppConfig } from "../config/app-config.js";
import { getCredentials } from "../config/secrets.js";
import { createSshClient, createFtpClient, createSftpClient } from "../adapter/adapter-factory.js";

export interface BuildContextArgs {
  routerConfig: RouterConfig;
  correlationId: string;
  identity: Identity;
  pool: ConnectionPool;
  config: AppConfig;
  registry?: RouterRegistry;
}

/** Assemble a per-router ToolContext: credentials, pooled device client, SSH and FTP clients. */
export function buildRouterToolContext(args: BuildContextArgs): ToolContext {
  const { routerConfig, correlationId, identity, pool, config, registry } = args;
  const credentials = getCredentials(routerConfig);
  const deviceClient = pool.getClient(routerConfig, credentials);
  const swosClient = deviceClient instanceof SwosClient ? deviceClient : undefined;
  const restClient = swosClient ? undefined : (deviceClient as RouterOSRestClient);
  return {
    // Platform gating (tool-executor / bulk_execute) guarantees a RouterOS tool
    // never reaches a SwOS device, so `routerClient` is only ever dereferenced
    // when the pool actually returned a REST client. `deviceClient` carries the
    // honest type for platform-aware callers.
    routerClient:
      restClient ??
      unavailableCapability<RouterOSRestClient>(
        "ROUTEROS_CLIENT_UNAVAILABLE",
        `Router "${routerConfig.id}" is a SwOS switch and has no RouterOS REST API.`,
        "Use a swos_* tool, or target a RouterOS router.",
      ),
    deviceClient,
    swosClient,
    routerId: routerConfig.id,
    correlationId,
    routerConfig,
    sshClient: createSshClient(routerConfig, config.ssh),
    ftpClient: createFtpClient(routerConfig),
    sftpClient: createSftpClient(routerConfig),
    identity,
    routerRegistry: registry,
    connectionPool: pool,
    appConfig: config,
  };
}
