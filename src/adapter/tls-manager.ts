import { readFileSync } from "node:fs";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import { Agent, buildConnector } from "undici";

export interface TlsOptions {
  enabled: boolean;
  rejectUnauthorized: boolean;
  ca?: string;
  fingerprint?: string;
}

/**
 * Wrap an undici connector so it verifies the server's SHA-256 certificate
 * fingerprint after the TLS handshake and destroys the socket on mismatch.
 *
 * This is done in the connector — NOT via tls.checkServerIdentity — because
 * Node ignores checkServerIdentity errors when rejectUnauthorized is false,
 * which is exactly the self-signed + pinned setup MikroTik deployments use.
 * Verifying here enforces the pin regardless of rejectUnauthorized.
 */
export function makePinnedConnector(
  inner: buildConnector.connector,
  expectedFingerprint: string,
): buildConnector.connector {
  const expected = expectedFingerprint.replace(/:/g, "").toLowerCase();
  return (opts, cb) => {
    inner(opts, (err, socket) => {
      if (err || !socket) {
        cb(err ?? new Error("TLS connection failed"), null);
        return;
      }
      const peer = socket as unknown as TLSSocket;
      const cert =
        typeof peer.getPeerCertificate === "function" ? peer.getPeerCertificate() : undefined;
      const actual = (cert?.fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
      if (actual !== expected) {
        socket.destroy();
        cb(
          new Error(
            `TLS certificate fingerprint mismatch. Expected: ${expected}, got: ${actual || "none"}`,
          ),
          null,
        );
        return;
      }
      cb(null, socket);
    });
  };
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
    const inner = buildConnector(connectOptions as buildConnector.BuildOptions);
    return { connect: makePinnedConnector(inner, tls.fingerprint) };
  }

  return {
    connect: connectOptions,
  };
}
