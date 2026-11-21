import { z } from "zod";

/**
 * Shared Zod field definitions reused across tool input schemas.
 *
 * Centralising these keeps the advertised JSON Schema small (the same terse
 * description is reused rather than re-spelled per tool) and consistent. A
 * single ZodType instance can be safely shared across many `.object()` schemas.
 */

/** Router identifier. Optional — the executor resolves a default/sole router when omitted. */
export const routerId = z
  .string()
  .optional()
  .describe("Router ID; omit to use the default router.");

/** Standard preview flag for write tools. */
export const dryRun = z.boolean().default(false).describe("Preview changes without applying.");

/** Standard pagination offset. */
export const offset = z.number().int().min(0).default(0).describe("Pagination offset.");

/** Standard pagination limit (1–500, default 100). */
export const limit = z
  .number()
  .int()
  .min(1)
  .max(500)
  .default(100)
  .describe("Max results to return.");

/**
 * Comment used as a rule's idempotency key. Never empty: a REST lookup with
 * `?comment=` matches no rule.
 */
export const ruleComment = z.string().min(1);

/** Address family of a firewall menu: `/ip firewall` or `/ipv6 firewall`. */
export const firewallFamily = z
  .enum(["ip", "ipv6"])
  .default("ip")
  .describe("Address family: ip (IPv4, /ip firewall) or ipv6 (/ipv6 firewall)");

export type FirewallFamily = z.infer<typeof firewallFamily>;

/** REST path of a firewall menu, e.g. `ipv6/firewall/raw`. */
export function firewallPath(family: FirewallFamily, menu: string): string {
  return `${family}/firewall/${menu}`;
}

/** The family a raw (unparsed) call names, for snapshot and state paths. */
export function rawFamily(params: Record<string, unknown>): FirewallFamily {
  return params.family === "ipv6" ? "ipv6" : "ip";
}
