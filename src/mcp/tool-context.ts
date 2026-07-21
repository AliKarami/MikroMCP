import type { RouterConfig } from "../types.js";
import type { Identity } from "../types.js";
import type { ToolContext } from "../domain/tools/tool-definition.js";
import type { ConnectionPool } from "../adapter/connection-pool.js";
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

/** Assemble a per-router ToolContext: credentials, pooled REST client, SSH and FTP clients. */
export function buildRouterToolContext(args: BuildContextArgs): ToolContext {
  const { routerConfig, correlationId, identity, pool, config, registry } = args;
  const credentials = getCredentials(routerConfig);
  return {
    routerClient: pool.getClient(routerConfig, credentials),
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
