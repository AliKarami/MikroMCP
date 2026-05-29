import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("ppp-tools");

const listPppProfilesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    name: z.string().optional().describe("Filter by profile name (exact match)"),
    limit: z.number().int().min(1).max(500).default(100).describe("Maximum profiles to return"),
  })
  .strict();

const listPppProfilesTool: ToolDefinition = {
  name: "list_ppp_profiles",
  title: "List PPP Profiles",
  description: "List PPP profiles including the built-in default and default-encryption profiles.",
  inputSchema: listPppProfilesInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listPppProfilesInputSchema.parse(params);
    try {
      log.info({ routerId: context.routerId }, "Listing PPP profiles");
      const all = await context.routerClient.get<RouterOSRecord>("ppp/profile", { limit: undefined, offset: undefined });
      const filtered = parsed.name
        ? (all as Record<string, string>[]).filter((p) => p.name === parsed.name)
        : (all as Record<string, string>[]);
      const profiles = filtered.slice(0, parsed.limit);
      return {
        content: `PPP profiles on ${context.routerId}: ${profiles.length} returned`,
        structuredContent: { routerId: context.routerId, profiles, total: all.length, returned: profiles.length },
      };
    } catch (err) {
      throw toolError(err, context, "list_ppp_profiles");
    }
  },
};

const managePppProfileInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "update", "remove"]).describe("Action to perform"),
    name: z.string().describe("Profile name — idempotency key"),
    localAddress: z.string().optional().describe("Local IP assigned to router end of PPP link"),
    remoteAddress: z.string().optional().describe("IP or pool name assigned to client"),
    dnsServer: z.string().optional().describe("DNS server IP pushed to client"),
    rateLimit: z.string().optional().describe("Rate limit string (e.g. '10M/10M')"),
    sessionTimeout: z.string().optional().describe("Session timeout duration string (e.g. '1h')"),
    comment: z.string().optional().describe("Optional comment"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const managePppProfileTool: ToolDefinition = {
  name: "manage_ppp_profile",
  title: "Manage PPP Profile",
  description:
    "Add, update, or remove a PPP profile. Idempotent by name. update returns no_change when requested values match. Built-in profiles (default, default-encryption) cannot be removed — RouterOS blocks this and the error is surfaced.",
  inputSchema: managePppProfileInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  snapshotPaths: ["ppp/profile"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = managePppProfileInputSchema.parse(params);
    log.info({ routerId: context.routerId, action: parsed.action, name: parsed.name }, "Managing PPP profile");
    try {
      const all = await context.routerClient.get<RouterOSRecord>("ppp/profile", { limit: undefined, offset: undefined });
      const existing = (all as Record<string, string>[]).find((p) => p.name === parsed.name);

      if (parsed.action === "add") {
        if (existing) {
          return {
            content: `PPP profile "${parsed.name}" already exists. No changes made.`,
            structuredContent: { action: "already_exists", name: parsed.name },
          };
        }
        if (parsed.dryRun) {
          const diff: { property: string; before: null; after: string }[] = [
            { property: "name", before: null, after: parsed.name },
          ];
          if (parsed.localAddress) diff.push({ property: "local-address", before: null, after: parsed.localAddress });
          if (parsed.remoteAddress) diff.push({ property: "remote-address", before: null, after: parsed.remoteAddress });
          if (parsed.dnsServer) diff.push({ property: "dns-server", before: null, after: parsed.dnsServer });
          if (parsed.rateLimit) diff.push({ property: "rate-limit", before: null, after: parsed.rateLimit });
          if (parsed.sessionTimeout) diff.push({ property: "session-timeout", before: null, after: parsed.sessionTimeout });
          if (parsed.comment) diff.push({ property: "comment", before: null, after: parsed.comment });
          return {
            content: `Dry run: Would create PPP profile "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }
        const body: Record<string, string> = { name: parsed.name };
        if (parsed.localAddress) body["local-address"] = parsed.localAddress;
        if (parsed.remoteAddress) body["remote-address"] = parsed.remoteAddress;
        if (parsed.dnsServer) body["dns-server"] = parsed.dnsServer;
        if (parsed.rateLimit) body["rate-limit"] = parsed.rateLimit;
        if (parsed.sessionTimeout) body["session-timeout"] = parsed.sessionTimeout;
        if (parsed.comment) body.comment = parsed.comment;
        const created = await context.routerClient.create("ppp/profile", body);
        log.info({ name: parsed.name, id: created[".id"] }, "PPP profile created");
        return {
          content: `Created PPP profile "${parsed.name}".`,
          structuredContent: { action: "created", name: parsed.name, id: created[".id"] },
        };
      }

      if (parsed.action === "update") {
        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "PPP_PROFILE_NOT_FOUND",
            message: `PPP profile "${parsed.name}" not found.`,
            details: { name: parsed.name },
            recoverability: { retryable: false, suggestedAction: "Verify with list_ppp_profiles.", alternativeTools: ["list_ppp_profiles"] },
          });
        }
        const changes: Record<string, string> = {};
        const diff: { property: string; before: string | null; after: string }[] = [];

        if (parsed.localAddress !== undefined && existing["local-address"] !== parsed.localAddress) {
          changes["local-address"] = parsed.localAddress;
          diff.push({ property: "local-address", before: existing["local-address"] ?? null, after: parsed.localAddress });
        }
        if (parsed.remoteAddress !== undefined && existing["remote-address"] !== parsed.remoteAddress) {
          changes["remote-address"] = parsed.remoteAddress;
          diff.push({ property: "remote-address", before: existing["remote-address"] ?? null, after: parsed.remoteAddress });
        }
        if (parsed.dnsServer !== undefined && existing["dns-server"] !== parsed.dnsServer) {
          changes["dns-server"] = parsed.dnsServer;
          diff.push({ property: "dns-server", before: existing["dns-server"] ?? null, after: parsed.dnsServer });
        }
        if (parsed.rateLimit !== undefined && existing["rate-limit"] !== parsed.rateLimit) {
          changes["rate-limit"] = parsed.rateLimit;
          diff.push({ property: "rate-limit", before: existing["rate-limit"] ?? null, after: parsed.rateLimit });
        }
        if (parsed.sessionTimeout !== undefined && existing["session-timeout"] !== parsed.sessionTimeout) {
          changes["session-timeout"] = parsed.sessionTimeout;
          diff.push({ property: "session-timeout", before: existing["session-timeout"] ?? null, after: parsed.sessionTimeout });
        }
        if (parsed.comment !== undefined && existing.comment !== parsed.comment) {
          changes.comment = parsed.comment;
          diff.push({ property: "comment", before: existing.comment ?? null, after: parsed.comment });
        }

        if (Object.keys(changes).length === 0) {
          return {
            content: `PPP profile "${parsed.name}" already matches requested values. No changes made.`,
            structuredContent: { action: "no_change", name: parsed.name },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would update PPP profile "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }
        await context.routerClient.update("ppp/profile", existing[".id"], changes);
        log.info({ name: parsed.name, id: existing[".id"] }, "PPP profile updated");
        return {
          content: `Updated PPP profile "${parsed.name}".`,
          structuredContent: { action: "updated", name: parsed.name, id: existing[".id"], diff },
        };
      }

      // remove
      if (!existing) {
        return {
          content: `PPP profile "${parsed.name}" not found. Nothing to remove.`,
          structuredContent: { action: "not_found", name: parsed.name },
        };
      }
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove PPP profile "${parsed.name}".`,
          structuredContent: { action: "dry_run", diff: [{ property: "name", before: parsed.name, after: null }] },
        };
      }
      await context.routerClient.remove("ppp/profile", existing[".id"]);
      log.info({ name: parsed.name }, "PPP profile removed");
      return {
        content: `Removed PPP profile "${parsed.name}".`,
        structuredContent: { action: "removed", name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      throw toolError(err, context, "manage_ppp_profile");
    }
  },
};

export const pppTools: ToolDefinition[] = [listPppProfilesTool, managePppProfileTool];
