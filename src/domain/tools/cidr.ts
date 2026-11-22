import { z } from "zod";
import { isIP } from "node:net";

function validateCidr(value: string): string {
  const withPrefix = value.includes("/") ? value : `${value}/32`;
  const slashIdx = withPrefix.lastIndexOf("/");
  const ipPart = withPrefix.slice(0, slashIdx);
  const prefixStr = withPrefix.slice(slashIdx + 1);

  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid prefix length "${prefixStr}": must be 0–32`);
  }

  const octets = ipPart.split(".");
  if (octets.length !== 4) {
    throw new Error(`Invalid IP address "${ipPart}": expected 4 octets`);
  }
  for (const octet of octets) {
    const n = Number(octet);
    if (!Number.isInteger(n) || n < 0 || n > 255 || String(n) !== octet) {
      throw new Error(`Invalid octet "${octet}" in IP address "${ipPart}"`);
    }
  }

  return withPrefix;
}

export const cidrSchema = z.string().transform((v, ctx) => {
  try {
    return validateCidr(v);
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
    return z.NEVER;
  }
});

/** An IPv6 address and prefix length in canonical form. */
export interface Ipv6Cidr {
  /** RFC 5952 text: lowercase, leading zeros dropped, longest zero run compressed. */
  address: string;
  prefix: number;
  /** The address as a 128-bit integer, for comparing network or interface-ID bits. */
  value: bigint;
}

function ipv6Groups(address: string): number[] | undefined {
  // isIP accepts a zone ("fe80::1%ether1"); a zone is not part of an address here.
  if (address.includes("%") || isIP(address) !== 6) return undefined;
  let text = address.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    text = `${text.slice(0, v4.index)}${hi}:${lo}`;
  }
  const parseGroups = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((g) => parseInt(g, 16));
  const [head, tail] = text.split("::");
  const headGroups = parseGroups(head);
  if (tail === undefined) return headGroups;
  const tailGroups = parseGroups(tail);
  const zeros = new Array<number>(8 - headGroups.length - tailGroups.length).fill(0);
  return [...headGroups, ...zeros, ...tailGroups];
}

function formatIpv6(groups: number[]): string {
  let runStart = -1;
  let runLength = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > runLength) {
      runStart = i;
      runLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  // RFC 5952 4.2.2: a single zero group is never shortened to "::".
  if (runLength < 2) return hex.join(":");
  return `${hex.slice(0, runStart).join(":")}::${hex.slice(runStart + runLength).join(":")}`;
}

/** Canonical (RFC 5952) text of an IPv6 address, or undefined when it is not one. */
export function canonicalIpv6(address: string): string | undefined {
  const groups = ipv6Groups(address);
  return groups ? formatIpv6(groups) : undefined;
}

/**
 * Parse an IPv6 CIDR such as `2001:DB8:0::1/64`. A bare address takes
 * `defaultPrefix` when given; otherwise the prefix length is required.
 * Throws with a message naming what is wrong.
 */
export function parseIpv6Cidr(value: string, defaultPrefix?: number): Ipv6Cidr {
  const slashIdx = value.lastIndexOf("/");
  if (slashIdx === -1 && defaultPrefix === undefined) {
    throw new Error(`IPv6 address "${value}" needs a prefix length, e.g. 2001:db8::1/64`);
  }
  const addressPart = slashIdx === -1 ? value : value.slice(0, slashIdx);
  const prefixStr = slashIdx === -1 ? String(defaultPrefix) : value.slice(slashIdx + 1);

  const prefix = Number(prefixStr);
  if (!/^\d{1,3}$/.test(prefixStr) || prefix > 128) {
    throw new Error(`Invalid IPv6 prefix length "${prefixStr}": must be 0–128`);
  }
  const groups = ipv6Groups(addressPart);
  if (!groups) {
    throw new Error(`Invalid IPv6 address "${addressPart}"`);
  }
  const bits = groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
  return { address: formatIpv6(groups), prefix, value: bits };
}

/** The first `prefix` bits of an address (its network part). */
export function ipv6NetworkBits(cidr: Ipv6Cidr): bigint {
  const hostBits = BigInt(128 - cidr.prefix);
  return (cidr.value >> hostBits) << hostBits;
}

/** The bits after the first `prefix` (the interface-ID part of the address). */
export function ipv6HostBits(cidr: Ipv6Cidr): bigint {
  return cidr.value & ((1n << BigInt(128 - cidr.prefix)) - 1n);
}

/** Canonical `address/prefix` text for an IPv6 CIDR, or undefined when it does not parse. */
export function normalizeIpv6Cidr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const cidr = parseIpv6Cidr(value);
    return `${cidr.address}/${cidr.prefix}`;
  } catch {
    return undefined;
  }
}

/** IPv6 CIDR with a required prefix length, normalised to canonical text. */
export const ipv6CidrSchema = z.string().transform((v, ctx) => {
  try {
    const cidr = parseIpv6Cidr(v.trim());
    return `${cidr.address}/${cidr.prefix}`;
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
    return z.NEVER;
  }
});

/**
 * IPv4 or IPv6 CIDR; a bare address becomes a host prefix (/32 or /128).
 * IPv6 is normalised to canonical text.
 */
export const ipCidrSchema = z.string().transform((v, ctx) => {
  try {
    if (!v.includes(":")) return validateCidr(v);
    const cidr = parseIpv6Cidr(v.trim(), 128);
    return `${cidr.address}/${cidr.prefix}`;
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
    return z.NEVER;
  }
});

/** 6 when a CIDR (as produced by `ipCidrSchema`) is IPv6, 4 otherwise. */
export function cidrFamily(cidr: string): 4 | 6 {
  return cidr.includes(":") ? 6 : 4;
}
