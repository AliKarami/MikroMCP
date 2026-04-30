import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import type { Agent } from "undici";

export interface TlsOptions {
  enabled: boolean;
  rejectUnauthorized: boolean;
  ca?: string;
  fingerprint?: string;
}

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

  if (tls.fingerprint) {
    const expected = tls.fingerprint.replace(/:/g, "").toLowerCase();
    connectOptions.checkServerIdentity = (
      _host: string,
      cert: { fingerprint256: string },
    ): Error | undefined => {
      const actual = cert.fingerprint256.replace(/:/g, "").toLowerCase();
      if (actual !== expected) {
        return new Error(
          `TLS certificate fingerprint mismatch. Expected: ${expected}, got: ${actual}`,
        );
      }
      return undefined;
    };
  }

  return {
    connect: connectOptions,
  };
}
