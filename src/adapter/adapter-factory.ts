import { SshClient, type SshClientOptions } from "./ssh-client.js";
import { FtpClient } from "./ftp-client.js";
import { getCredentials } from "../config/secrets.js";
import type { RouterConfig } from "../types.js";

export function createSshClient(routerConfig: RouterConfig, options: SshClientOptions): SshClient {
  const creds = getCredentials(routerConfig);
  return new SshClient(routerConfig, creds, options);
}

export function createFtpClient(routerConfig: RouterConfig): FtpClient {
  const creds = getCredentials(routerConfig);
  return new FtpClient(routerConfig.host, 21, creds.username, creds.password);
}
