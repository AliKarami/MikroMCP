// ---------------------------------------------------------------------------
// MikroMCP - Connection pool for RouterOS REST clients
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { RouterConfig } from "../types.js";
import { RouterOSRestClient } from "./rest-client.js";

/** Credentials used to authenticate with a RouterOS device. */
export interface Credentials {
  username: string;
  password: string;
}

interface PooledClient {
  client: RouterOSRestClient;
  credHash: string;
}

function credentialHash(credentials: Credentials): string {
  return createHash("sha256")
    .update(`${credentials.username}\0${credentials.password}`)
    .digest("hex");
}

export class ConnectionPool {
  private readonly clients = new Map<string, PooledClient>();

  /**
   * Get an existing client for the given router or create a new one. Clients are
   * keyed by `config.id`, but a client whose credentials no longer match the
   * request is closed and rebuilt so rotated credentials take effect.
   */
  getClient(config: RouterConfig, credentials: Credentials): RouterOSRestClient {
    const credHash = credentialHash(credentials);
    const existing = this.clients.get(config.id);
    if (existing) {
      if (existing.credHash === credHash) {
        return existing.client;
      }
      existing.client.close();
    }

    const client = new RouterOSRestClient(config, credentials);
    this.clients.set(config.id, { client, credHash });
    return client;
  }

  /**
   * Perform a lightweight health check against a router by fetching
   * `/rest/system/resource`. Returns `true` if the request succeeds.
   */
  async healthCheck(routerId: string): Promise<boolean> {
    const entry = this.clients.get(routerId);
    if (!entry) {
      return false;
    }

    try {
      await entry.client.get("system/resource");
      return true;
    } catch {
      return false;
    }
  }

  /** Remove and close a single client by router ID. */
  removeClient(routerId: string): void {
    const entry = this.clients.get(routerId);
    if (entry) {
      entry.client.close();
      this.clients.delete(routerId);
    }
  }

  /** Close and remove all clients. */
  closeAll(): void {
    for (const [id, entry] of this.clients) {
      entry.client.close();
      this.clients.delete(id);
    }
  }
}
