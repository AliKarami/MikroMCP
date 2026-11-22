import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";

export interface RequestGuardConfig {
  bindHost: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  allowedIps: string[];
}

export type GuardVerdict = { ok: true } | { ok: false; code: string; error: string; hint: string };

export interface RequestGuard {
  check(req: IncomingMessage): GuardVerdict;
  /** False when neither a host list nor a loopback bind gives the Host/Origin check anything to enforce. */
  readonly hostCheckActive: boolean;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** A Host-header pattern: a hostname, optionally with a port (no port = any port). */
interface HostPattern {
  hostname: string;
  port: string | undefined;
}

export function isLoopbackBind(bindHost: string): boolean {
  const host = bindHost.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

/** Split `host[:port]`, keeping IPv6 literals in brackets. */
function splitHostPort(value: string): HostPattern {
  const lower = value.trim().toLowerCase();
  const bracketed = /^(\[[^\]]+\])(?::(\d+))?$/.exec(lower);
  if (bracketed) return { hostname: bracketed[1], port: bracketed[2] };
  if (isIP(lower) === 6) return { hostname: `[${lower}]`, port: undefined };
  const colon = lower.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(lower.slice(colon + 1))) {
    return { hostname: lower.slice(0, colon), port: lower.slice(colon + 1) };
  }
  return { hostname: lower, port: undefined };
}

function hostMatches(header: string, patterns: HostPattern[]): boolean {
  const { hostname, port } = splitHostPort(header);
  return patterns.some((p) => p.hostname === hostname && (p.port === undefined || p.port === port));
}

function configError(variable: string, message: string): MikroMCPError {
  return new MikroMCPError({
    category: ErrorCategory.CONFIGURATION,
    code: "INVALID_HTTP_ALLOWLIST",
    message: `${variable}: ${message}`,
    details: { variable },
    recoverability: {
      retryable: false,
      suggestedAction: `Fix ${variable}: a comma-separated list (see the Configuration page).`,
    },
  });
}

/** Build a BlockList (used as an allow list) from IPs and CIDRs; throws on a malformed entry. */
export function parseIpAllowlist(entries: string[]): BlockList | undefined {
  if (entries.length === 0) return undefined;
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split("/");
    const family = isIP(address);
    if (family === 0 || extra !== undefined) {
      throw configError("MIKROMCP_HTTP_ALLOWED_IPS", `"${entry}" is not an IP address or CIDR`);
    }
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const bits = Number(prefix);
    if (!/^\d+$/.test(prefix) || bits > (family === 4 ? 32 : 128)) {
      throw configError("MIKROMCP_HTTP_ALLOWED_IPS", `"${entry}" has an invalid prefix length`);
    }
    list.addSubnet(address, bits, type);
  }
  return list;
}

/** The client address as the allow list should see it: IPv4-mapped IPv6 unwrapped. */
function clientAddress(raw: string | undefined): { address: string; type: "ipv4" | "ipv6" } | null {
  if (!raw) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
  if (mapped) return { address: mapped[1], type: "ipv4" };
  const family = isIP(raw);
  if (family === 0) return null;
  return { address: raw, type: family === 4 ? "ipv4" : "ipv6" };
}

/**
 * Checks every HTTP request before authentication: the client IP against
 * MIKROMCP_HTTP_ALLOWED_IPS, and the Host and Origin headers against
 * MIKROMCP_HTTP_ALLOWED_HOSTS / _ORIGINS. The Host/Origin check is what stops a
 * DNS-rebinding page in the user's browser from reaching a server bound to
 * localhost; requests without an Origin header come from non-browser clients and
 * are not subject to the Origin check.
 */
export function createRequestGuard(config: RequestGuardConfig): RequestGuard {
  const ipList = parseIpAllowlist(config.allowedIps);

  const wildcardHosts = config.allowedHosts.includes("*");
  const hostPatterns: HostPattern[] | undefined = wildcardHosts
    ? undefined
    : config.allowedHosts.length > 0
      ? config.allowedHosts.map(splitHostPort)
      : isLoopbackBind(config.bindHost)
        ? LOOPBACK_HOSTS.map((h) => ({ hostname: h, port: undefined }))
        : undefined;

  const wildcardOrigins = config.allowedOrigins.includes("*");
  const origins = new Set(
    config.allowedOrigins.map((o) => o.trim().toLowerCase().replace(/\/+$/, "")),
  );

  const check = (req: IncomingMessage): GuardVerdict => {
    if (ipList) {
      const client = clientAddress(req.socket.remoteAddress);
      if (!client || !ipList.check(client.address, client.type)) {
        return {
          ok: false,
          code: "CLIENT_IP_NOT_ALLOWED",
          error: "This client address is not allowed to use this server.",
          hint: "Add the client's address or network to MIKROMCP_HTTP_ALLOWED_IPS. Behind a reverse proxy the server sees the proxy's address.",
        };
      }
    }

    if (hostPatterns) {
      const host = req.headers.host;
      if (!host || !hostMatches(host, hostPatterns)) {
        return {
          ok: false,
          code: "HOST_NOT_ALLOWED",
          error: "The Host header is not one this server answers to.",
          hint: "Add the name clients use to reach the server (e.g. mcp.example.com) to MIKROMCP_HTTP_ALLOWED_HOSTS, or * to turn the Host check off.",
        };
      }
    }

    const origin = req.headers.origin;
    if (origin !== undefined && !wildcardOrigins) {
      const normalised = origin.trim().toLowerCase();
      const allowed =
        origins.has(normalised) ||
        (origins.size === 0 && originHostAllowed(normalised, hostPatterns));
      if (!allowed) {
        return {
          ok: false,
          code: "ORIGIN_NOT_ALLOWED",
          error: "Requests from this browser origin are not allowed.",
          hint: "Add the origin (e.g. https://app.example.com) to MIKROMCP_HTTP_ALLOWED_ORIGINS, or * to allow any origin.",
        };
      }
    }

    return { ok: true };
  };

  return { check, hostCheckActive: hostPatterns !== undefined };
}

/**
 * With no explicit origin list, an Origin passes when its host is one the Host
 * check accepts — or when there is no Host check at all, matching the
 * documented "protection off" state of a non-loopback bind without a host list.
 */
function originHostAllowed(origin: string, hostPatterns: HostPattern[] | undefined): boolean {
  if (!hostPatterns) return true;
  if (origin === "null") return false;
  try {
    return hostMatches(new URL(origin).host, hostPatterns);
  } catch {
    return false;
  }
}
