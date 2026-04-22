// ---------------------------------------------------------------------------
// MikroMCP - Connection pool for RouterOS REST clients
// ---------------------------------------------------------------------------

import type { RouterConfig } from "../types.js";
import { RouterOSRestClient } from "./rest-client.js";

/** Credentials used to authenticate with a RouterOS device. */
export interface Credentials {
  username: string;
  password: string;
}

export class ConnectionPool {
  private readonly clients = new Map<string, RouterOSRestClient>();

  /**
   * Get an existing client for the given router or create a new one.
   * Clients are keyed by `config.id`.
   */
  getClient(config: RouterConfig, credentials: Credentials): RouterOSRestClient {
    const existing = this.clients.get(config.id);
    if (existing) {
      return existing;
    }

    const client = new RouterOSRestClient(config, credentials);
    this.clients.set(config.id, client);
    return client;
  }

  /**
   * Perform a lightweight health check against a router by fetching
   * `/rest/system/resource`. Returns `true` if the request succeeds.
   */
  async healthCheck(routerId: string): Promise<boolean> {
    const client = this.clients.get(routerId);
    if (!client) {
      return false;
    }

    try {
      await client.get("system/resource");
      return true;
    } catch {
      return false;
    }
  }

  /** Remove and close a single client by router ID. */
  removeClient(routerId: string): void {
    const client = this.clients.get(routerId);
    if (client) {
      client.close();
      this.clients.delete(routerId);
    }
  }

  /** Close and remove all clients. */
  closeAll(): void {
    for (const [id, client] of this.clients) {
      client.close();
      this.clients.delete(id);
    }
  }
}
