// ---------------------------------------------------------------------------
// MikroMCP - TLS configuration for undici HTTP Agent
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import type { Agent } from "undici";

export interface TlsOptions {
  /** Whether TLS is enabled (HTTPS vs HTTP). */
  enabled: boolean;
  /** Whether to reject self-signed / untrusted certificates. */
  rejectUnauthorized: boolean;
  /** Optional path to a CA certificate file. */
  ca?: string;
}

/**
 * Build `Agent.Options` for an undici `Agent` based on TLS configuration.
 *
 * - If TLS is disabled, returns empty options (HTTP mode).
 * - Otherwise, configures `rejectUnauthorized` and optional CA.
 */
export function buildAgentOptions(tls: TlsOptions): Agent.Options {
  if (!tls.enabled) {
    return {};
  }

  const connectOptions: ConnectionOptions = {
    rejectUnauthorized: tls.rejectUnauthorized,
  };

  if (tls.ca) {
    connectOptions.ca = readFileSync(tls.ca, "utf-8");
  }

  return {
    connect: connectOptions,
  };
}
