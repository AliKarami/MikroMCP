import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("ipsec-tools");

const listIpsecPeersInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    address: z.string().optional().describe("Filter by remote address (substring match)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of peers to return"),
  })
  .strict();

const listIpsecPeersTool: ToolDefinition = {
  name: "list_ipsec_peers",
  title: "List IPSec Peers",
  description: "List IPSec peers on a MikroTik router.",
  inputSchema: listIpsecPeersInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listIpsecPeersInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing IPSec peers");
    try {
      const allPeers = await context.routerClient.get<RouterOSRecord>("ip/ipsec/peer", {
        limit: undefined,
        offset: undefined,
      });

      let filtered = allPeers as Record<string, string>[];
      if (parsed.address) {
        filtered = filtered.filter((p) => (p.address ?? "").includes(parsed.address!));
      }
      const peers = filtered.slice(0, parsed.limit);

      return {
        content: `IPSec peers on ${context.routerId}: ${peers.length} returned (${allPeers.length} total)`,
        structuredContent: {
          routerId: context.routerId,
          peers,
          total: allPeers.length,
          returned: peers.length,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "list_ipsec_peers" });
    }
  },
};

const listIpsecPoliciesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    srcAddress: z
      .string()
      .optional()
      .describe("Filter by source address (substring match)"),
    dstAddress: z
      .string()
      .optional()
      .describe("Filter by destination address (substring match)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of policies to return"),
  })
  .strict();

const listIpsecPoliciesTool: ToolDefinition = {
  name: "list_ipsec_policies",
  title: "List IPSec Policies",
  description: "List IPSec policies on a MikroTik router.",
  inputSchema: listIpsecPoliciesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listIpsecPoliciesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing IPSec policies");
    try {
      const allPolicies = await context.routerClient.get<RouterOSRecord>("ip/ipsec/policy", {
        limit: undefined,
        offset: undefined,
      });

      let filtered = allPolicies as Record<string, string>[];
      if (parsed.srcAddress) {
        filtered = filtered.filter((p) =>
          (p["src-address"] ?? "").includes(parsed.srcAddress!),
        );
      }
      if (parsed.dstAddress) {
        filtered = filtered.filter((p) =>
          (p["dst-address"] ?? "").includes(parsed.dstAddress!),
        );
      }
      const policies = filtered.slice(0, parsed.limit);

      return {
        content: `IPSec policies on ${context.routerId}: ${policies.length} returned (${allPolicies.length} total)`,
        structuredContent: {
          routerId: context.routerId,
          policies,
          total: allPolicies.length,
          returned: policies.length,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "list_ipsec_policies" });
    }
  },
};

const manageIpsecPeerInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "remove", "enable", "disable"]).describe("Action to perform"),
    name: z.string().describe("Peer name — idempotency key"),
    address: z.string().optional().describe("Remote gateway address (required for add)"),
    localAddress: z.string().optional().describe("Local address"),
    exchange: z
      .enum(["ike1", "ike2"])
      .default("ike2")
      .describe("IKE exchange mode"),
    profile: z.string().optional().describe("IKE profile name"),
    comment: z.string().optional().describe("Optional comment"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageIpsecPeerTool: ToolDefinition = {
  name: "manage_ipsec_peer",
  title: "Manage IPSec Peer",
  description:
    "Add, remove, enable, or disable an IPSec peer. Idempotent by name: add returns already_exists if a peer with the same name and address already exists.",
  inputSchema: manageIpsecPeerInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["ip/ipsec/peer"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageIpsecPeerInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing IPSec peer",
    );
    try {
      const allPeers = await context.routerClient.get<RouterOSRecord>("ip/ipsec/peer", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (allPeers as Record<string, string>[]).find(
        (p) => p.name === parsed.name,
      );

      if (parsed.action === "add") {
        if (existing) {
          if (existing.address === parsed.address) {
            return {
              content: `IPSec peer "${parsed.name}" already exists with the same address. No changes made.`,
              structuredContent: { action: "already_exists", peer: existing },
            };
          }
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "IPSEC_PEER_CONFLICT",
            message: `IPSec peer "${parsed.name}" exists with a different address.`,
            details: { existing: existing.address, requested: parsed.address },
            recoverability: {
              retryable: false,
              suggestedAction: "Remove the existing peer first or use a different name.",
              alternativeTools: ["manage_ipsec_peer"],
            },
          });
        }

        if (parsed.dryRun) {
          const diff = [
            { property: "name", before: null, after: parsed.name },
            { property: "address", before: null, after: parsed.address ?? null },
            { property: "exchange", before: null, after: parsed.exchange },
            ...(parsed.localAddress
              ? [{ property: "local-address", before: null, after: parsed.localAddress }]
              : []),
            ...(parsed.profile
              ? [{ property: "profile", before: null, after: parsed.profile }]
              : []),
          ];
          return {
            content: `Dry run: Would add IPSec peer "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        if (!parsed.address) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "IPSEC_PEER_ADDRESS_REQUIRED",
            message: "address is required when adding an IPSec peer.",
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Provide the remote gateway address.",
            },
          });
        }

        const body: Record<string, string> = {
          name: parsed.name,
          address: parsed.address,
          exchange: parsed.exchange,
        };
        if (parsed.localAddress) body["local-address"] = parsed.localAddress;
        if (parsed.profile) body.profile = parsed.profile;
        if (parsed.comment) body.comment = parsed.comment;

        const created = await context.routerClient.create("ip/ipsec/peer", body);
        log.info({ name: parsed.name, id: created[".id"] }, "IPSec peer added");
        return {
          content: `Added IPSec peer "${parsed.name}".`,
          structuredContent: { action: "created", peer: created },
        };
      }

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `IPSec peer "${parsed.name}" not found. Nothing to remove.`,
            structuredContent: { action: "not_found", name: parsed.name },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove IPSec peer "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "name", before: parsed.name, after: null }],
            },
          };
        }
        await context.routerClient.remove("ip/ipsec/peer", existing[".id"]);
        log.info({ name: parsed.name }, "IPSec peer removed");
        return {
          content: `Removed IPSec peer "${parsed.name}".`,
          structuredContent: { action: "removed", name: parsed.name, id: existing[".id"] },
        };
      }

      // enable / disable
      if (!existing) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "IPSEC_PEER_NOT_FOUND",
          message: `IPSec peer "${parsed.name}" not found.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the peer name with list_ipsec_peers.",
            alternativeTools: ["list_ipsec_peers"],
          },
        });
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would ${parsed.action} IPSec peer "${parsed.name}".`,
          structuredContent: {
            action: "dry_run",
            diff: [
              {
                property: "disabled",
                before: existing.disabled,
                after: parsed.action === "disable" ? "true" : "false",
              },
            ],
          },
        };
      }

      const disabledValue = parsed.action === "disable" ? "true" : "false";
      await context.routerClient.update("ip/ipsec/peer", existing[".id"], {
        disabled: disabledValue,
      });
      const resultAction = parsed.action === "disable" ? "disabled" : "enabled";
      log.info({ name: parsed.name, action: resultAction }, "IPSec peer updated");
      return {
        content: `IPSec peer "${parsed.name}" ${resultAction}.`,
        structuredContent: { action: resultAction, name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_ipsec_peer" });
    }
  },
};

export const ipsecTools: ToolDefinition[] = [
  listIpsecPeersTool,
  listIpsecPoliciesTool,
  manageIpsecPeerTool,
];
