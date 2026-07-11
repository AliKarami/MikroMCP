import { z } from "zod";
import { listContent, compactFields } from "./pagination.js";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, limit, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("ipsec-tools");

const listIpsecPeersInputSchema = z
  .object({
    routerId,
    address: z.string().optional().describe("Filter by remote address (substring match)"),
    limit,
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

      const filtered = parsed.address
        ? (allPeers as Record<string, string>[]).filter((p) =>
            (p.address ?? "").includes(parsed.address!),
          )
        : (allPeers as Record<string, string>[]);
      const peers = filtered.slice(0, parsed.limit);

      return {
        content: listContent(
          "IPSec peers",
          context.routerId,
          peers,
          allPeers.length,
          0,
          (p) => compactFields(p, ["name", "address", "profile", "exchange-mode", "disabled"]),
        ),
        structuredContent: {
          routerId: context.routerId,
          peers,
          total: allPeers.length,
          returned: peers.length,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_ipsec_peers");
    }
  },
};

const listIpsecPoliciesInputSchema = z
  .object({
    routerId,
    srcAddress: z
      .string()
      .optional()
      .describe("Filter by source address (substring match)"),
    dstAddress: z
      .string()
      .optional()
      .describe("Filter by destination address (substring match)"),
    limit,
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

      const filtered = (allPolicies as Record<string, string>[])
        .filter((p) =>
          parsed.srcAddress ? (p["src-address"] ?? "").includes(parsed.srcAddress) : true,
        )
        .filter((p) =>
          parsed.dstAddress ? (p["dst-address"] ?? "").includes(parsed.dstAddress) : true,
        );
      const policies = filtered.slice(0, parsed.limit);

      return {
        content: listContent(
          "IPSec policies",
          context.routerId,
          policies,
          allPolicies.length,
          0,
          (p) => compactFields(p, ["src-address", "dst-address", "protocol", "action", "level", "disabled"]),
        ),
        structuredContent: {
          routerId: context.routerId,
          policies,
          total: allPolicies.length,
          returned: policies.length,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_ipsec_policies");
    }
  },
};

const manageIpsecPeerInputSchema = z
  .object({
    routerId,
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
    dryRun,
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
    destructiveHint: true,
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

        if (parsed.dryRun) {
          const diff = [
            { property: "name", before: null, after: parsed.name },
            { property: "address", before: null, after: parsed.address ?? null },
            { property: "exchange-mode", before: null, after: parsed.exchange },
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

        const body: Record<string, string> = {
          name: parsed.name,
          address: parsed.address,
          "exchange-mode": parsed.exchange,
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
      throw toolError(err, context, "manage_ipsec_peer");
    }
  },
};

const manageIpsecPolicyInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove", "enable", "disable"]).describe("Action to perform"),
    srcAddress: z.string().describe("Source CIDR — part of composite idempotency key"),
    dstAddress: z.string().describe("Destination CIDR — part of composite idempotency key"),
    tunnel: z.boolean().default(false).describe("Tunnel mode — part of composite idempotency key"),
    ipsecAction: z
      .enum(["encrypt", "discard", "none"])
      .optional()
      .describe("IPSec action (required for add)"),
    level: z.enum(["require", "use", "unique"]).default("require").describe("SA level"),
    saSourceAddress: z.string().optional().describe("SA source IP for tunnel mode"),
    saDstAddress: z.string().optional().describe("SA destination IP for tunnel mode"),
    dryRun,
  })
  .strict();

const manageIpsecPolicyTool: ToolDefinition = {
  name: "manage_ipsec_policy",
  title: "Manage IPSec Policy",
  description:
    "Add, remove, enable, or disable an IPSec policy. Idempotent by composite key (srcAddress + dstAddress + tunnel).",
  inputSchema: manageIpsecPolicyInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["ip/ipsec/policy"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageIpsecPolicyInputSchema.parse(params);
    log.info({ routerId: context.routerId, action: parsed.action }, "Managing IPSec policy");
    try {
      const all = await context.routerClient.get<RouterOSRecord>("ip/ipsec/policy", {
        limit: undefined,
        offset: undefined,
      });
      const tunnelStr = String(parsed.tunnel);
      const existing = (all as Record<string, string>[]).find(
        (p) =>
          p["src-address"] === parsed.srcAddress &&
          p["dst-address"] === parsed.dstAddress &&
          p.tunnel === tunnelStr,
      );

      if (parsed.action === "add") {
        if (existing) {
          return {
            content: `IPSec policy ${parsed.srcAddress} → ${parsed.dstAddress} already exists. No changes made.`,
            structuredContent: { action: "already_exists", policy: existing },
          };
        }
        if (!parsed.ipsecAction) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "IPSEC_POLICY_ACTION_REQUIRED",
            message: "ipsecAction is required when adding an IPSec policy.",
            recoverability: {
              retryable: false,
              suggestedAction: "Provide ipsecAction: encrypt, discard, or none.",
            },
          });
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would add IPSec policy ${parsed.srcAddress} → ${parsed.dstAddress}.`,
            structuredContent: {
              action: "dry_run",
              diff: [
                { property: "src-address", before: null, after: parsed.srcAddress },
                { property: "dst-address", before: null, after: parsed.dstAddress },
                { property: "action", before: null, after: parsed.ipsecAction },
              ],
            },
          };
        }
        const body: Record<string, string> = {
          "src-address": parsed.srcAddress,
          "dst-address": parsed.dstAddress,
          tunnel: tunnelStr,
          action: parsed.ipsecAction,
          level: parsed.level,
        };
        if (parsed.saSourceAddress) body["sa-src-address"] = parsed.saSourceAddress;
        if (parsed.saDstAddress) body["sa-dst-address"] = parsed.saDstAddress;
        const created = await context.routerClient.create("ip/ipsec/policy", body);
        log.info({ id: created[".id"] }, "IPSec policy added");
        return {
          content: `Added IPSec policy ${parsed.srcAddress} → ${parsed.dstAddress}.`,
          structuredContent: { action: "created", policy: created },
        };
      }

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `IPSec policy ${parsed.srcAddress} → ${parsed.dstAddress} not found. Nothing to remove.`,
            structuredContent: {
              action: "not_found",
              srcAddress: parsed.srcAddress,
              dstAddress: parsed.dstAddress,
            },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove IPSec policy ${parsed.srcAddress} → ${parsed.dstAddress}.`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "src-address", before: parsed.srcAddress, after: null }],
            },
          };
        }
        await context.routerClient.remove("ip/ipsec/policy", existing[".id"]);
        log.info({ id: existing[".id"] }, "IPSec policy removed");
        return {
          content: `Removed IPSec policy ${parsed.srcAddress} → ${parsed.dstAddress}.`,
          structuredContent: { action: "removed", id: existing[".id"] },
        };
      }

      // enable / disable
      if (!existing) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "IPSEC_POLICY_NOT_FOUND",
          message: `IPSec policy ${parsed.srcAddress} → ${parsed.dstAddress} not found.`,
          recoverability: {
            retryable: false,
            suggestedAction: "Verify with list_ipsec_policies.",
            alternativeTools: ["list_ipsec_policies"],
          },
        });
      }
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would ${parsed.action} IPSec policy ${parsed.srcAddress} → ${parsed.dstAddress}.`,
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
      await context.routerClient.update("ip/ipsec/policy", existing[".id"], {
        disabled: parsed.action === "disable" ? "true" : "false",
      });
      const resultAction = parsed.action === "disable" ? "disabled" : "enabled";
      log.info({ id: existing[".id"], action: resultAction }, "IPSec policy updated");
      return {
        content: `IPSec policy ${parsed.srcAddress} → ${parsed.dstAddress} ${resultAction}.`,
        structuredContent: { action: resultAction, id: existing[".id"] },
      };
    } catch (err) {
      throw toolError(err, context, "manage_ipsec_policy");
    }
  },
};

export const ipsecTools: ToolDefinition[] = [
  listIpsecPeersTool,
  listIpsecPoliciesTool,
  manageIpsecPeerTool,
  manageIpsecPolicyTool,
];
