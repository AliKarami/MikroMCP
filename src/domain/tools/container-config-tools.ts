import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, limit, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("container-config-tools");

// ---------------------------------------------------------------------------
// get_container_config
// ---------------------------------------------------------------------------

const getContainerConfigInputSchema = z
  .object({ routerId })
  .strict();

const getContainerConfigTool: ToolDefinition = {
  name: "get_container_config",
  title: "Get Container Config",
  description:
    "Read global container configuration: registry URL, RAM high-water mark, and veth interface.",
  inputSchema: getContainerConfigInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    getContainerConfigInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Getting container config");
    try {
      const results = await context.routerClient.get<RouterOSRecord>("container/config");
      const cfg = (Array.isArray(results) && results.length > 0
        ? results[0]
        : results) as Record<string, string>;
      return {
        content: `Container config on ${context.routerId}: registry=${cfg["registry-url"] ?? "none"} ram-high=${cfg["ram-high"] ?? "?"}MB veth=${cfg["veth-interface"] ?? "none"}`,
        structuredContent: {
          routerId: context.routerId,
          registryUrl: cfg["registry-url"] ?? null,
          ramHighMb: cfg["ram-high"] ?? null,
          vethInterface: cfg["veth-interface"] ?? null,
        },
      };
    } catch (err) {
      throw toolError(err, context, "get_container_config");
    }
  },
};

// ---------------------------------------------------------------------------
// manage_container_config
// ---------------------------------------------------------------------------

const manageContainerConfigInputSchema = z
  .object({
    routerId,
    registryUrl: z.string().optional().describe("Container registry URL"),
    ramHighMb: z.number().int().min(1).optional().describe("RAM high-water mark in MB"),
    vethInterface: z.string().optional().describe("Veth interface name for container networking"),
    dryRun,
  })
  .strict();

const manageContainerConfigTool: ToolDefinition = {
  name: "manage_container_config",
  title: "Manage Container Config",
  description:
    "Update global container settings. Idempotent: returns no_change if nothing differs.",
  inputSchema: manageContainerConfigInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  snapshotPaths: ["container/config"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageContainerConfigInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Managing container config");
    try {
      const results = await context.routerClient.get<RouterOSRecord>("container/config");
      const current = (Array.isArray(results) && results.length > 0
        ? results[0]
        : results) as Record<string, string>;
      const id = current[".id"];

      const changes: Record<string, string> = {};
      const diff: { property: string; before: string | null; after: string }[] = [];

      if (parsed.registryUrl !== undefined && current["registry-url"] !== parsed.registryUrl) {
        changes["registry-url"] = parsed.registryUrl;
        diff.push({ property: "registry-url", before: current["registry-url"] ?? null, after: parsed.registryUrl });
      }
      if (parsed.ramHighMb !== undefined) {
        const next = String(parsed.ramHighMb);
        if (current["ram-high"] !== next) {
          changes["ram-high"] = next;
          diff.push({ property: "ram-high", before: current["ram-high"] ?? null, after: next });
        }
      }
      if (parsed.vethInterface !== undefined && current["veth-interface"] !== parsed.vethInterface) {
        changes["veth-interface"] = parsed.vethInterface;
        diff.push({ property: "veth-interface", before: current["veth-interface"] ?? null, after: parsed.vethInterface });
      }

      if (Object.keys(changes).length === 0) {
        return {
          content: "Container config already matches. No changes made.",
          structuredContent: { action: "no_change", routerId: context.routerId },
        };
      }
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would update container config on ${context.routerId}.`,
          structuredContent: { action: "dry_run", diff },
        };
      }
      await context.routerClient.update("container/config", id, changes);
      log.info({ routerId: context.routerId }, "Container config updated");
      return {
        content: `Updated container config on ${context.routerId}.`,
        structuredContent: { action: "updated", routerId: context.routerId, diff },
      };
    } catch (err) {
      throw toolError(err, context, "manage_container_config");
    }
  },
};

// ---------------------------------------------------------------------------
// list_container_envs
// ---------------------------------------------------------------------------

const listContainerEnvsInputSchema = z
  .object({
    routerId,
    name: z.string().optional().describe("Filter by container name (exact match)"),
    limit,
  })
  .strict();

const listContainerEnvsTool: ToolDefinition = {
  name: "list_container_envs",
  title: "List Container Envs",
  description:
    "List container environment variable entries, optionally filtered by container name.",
  inputSchema: listContainerEnvsInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listContainerEnvsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing container envs");
    try {
      const all = await context.routerClient.get<RouterOSRecord>("container/envs", {
        limit: undefined,
        offset: undefined,
      });
      const filtered = parsed.name
        ? (all as Record<string, string>[]).filter((e) => e.name === parsed.name)
        : (all as Record<string, string>[]);
      const envs = filtered.slice(0, parsed.limit);
      return {
        content: `Container envs on ${context.routerId}: ${envs.length} returned`,
        structuredContent: { routerId: context.routerId, envs, total: all.length, returned: envs.length },
      };
    } catch (err) {
      throw toolError(err, context, "list_container_envs");
    }
  },
};

// ---------------------------------------------------------------------------
// manage_container_env
// ---------------------------------------------------------------------------

const manageContainerEnvInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove"]).describe("Action to perform"),
    name: z.string().describe("Container name"),
    key: z.string().describe("Environment variable name — part of idempotency key"),
    value: z.string().optional().describe("Environment variable value (required for add)"),
    dryRun,
  })
  .strict();

const manageContainerEnvTool: ToolDefinition = {
  name: "manage_container_env",
  title: "Manage Container Env",
  description:
    "Add or remove a container environment variable. Idempotent by name+key. add returns already_exists if the entry exists with the same value; throws CONFLICT if the value differs.",
  inputSchema: manageContainerEnvInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageContainerEnvInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name, key: parsed.key },
      "Managing container env",
    );
    try {
      const all = await context.routerClient.get<RouterOSRecord>("container/envs", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (all as Record<string, string>[]).find(
        (e) => e.name === parsed.name && e.key === parsed.key,
      );

      if (parsed.action === "add") {
        if (existing) {
          if (existing.value === parsed.value) {
            return {
              content: `Env ${parsed.name}.${parsed.key} already exists with same value.`,
              structuredContent: { action: "already_exists", name: parsed.name, key: parsed.key },
            };
          }
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "CONTAINER_ENV_CONFLICT",
            message: `Env ${parsed.name}.${parsed.key} exists with a different value.`,
            details: { existingValue: existing.value, requestedValue: parsed.value },
            recoverability: {
              retryable: false,
              suggestedAction: "Remove the existing entry first.",
              alternativeTools: ["manage_container_env"],
            },
          });
        }
        if (parsed.value === undefined) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "ENV_VALUE_REQUIRED",
            message: "value is required for add.",
            recoverability: { retryable: false, suggestedAction: "Provide the value parameter." },
          });
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would add env ${parsed.name}.${parsed.key}=${parsed.value}.`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "value", before: null, after: parsed.value }],
            },
          };
        }
        const created = await context.routerClient.create("container/envs", {
          name: parsed.name,
          key: parsed.key,
          value: parsed.value,
        });
        log.info({ name: parsed.name, key: parsed.key, id: created[".id"] }, "Container env added");
        return {
          content: `Added env ${parsed.name}.${parsed.key}.`,
          structuredContent: {
            action: "created",
            name: parsed.name,
            key: parsed.key,
            id: created[".id"],
          },
        };
      }

      // remove
      if (!existing) {
        return {
          content: `Env ${parsed.name}.${parsed.key} not found. Nothing to remove.`,
          structuredContent: { action: "not_found", name: parsed.name, key: parsed.key },
        };
      }
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove env ${parsed.name}.${parsed.key}.`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "key", before: parsed.key, after: null }],
          },
        };
      }
      await context.routerClient.remove("container/envs", existing[".id"]);
      log.info({ name: parsed.name, key: parsed.key }, "Container env removed");
      return {
        content: `Removed env ${parsed.name}.${parsed.key}.`,
        structuredContent: { action: "removed", name: parsed.name, key: parsed.key },
      };
    } catch (err) {
      throw toolError(err, context, "manage_container_env");
    }
  },
};

// ---------------------------------------------------------------------------
// list_container_mounts
// ---------------------------------------------------------------------------

const listContainerMountsInputSchema = z
  .object({
    routerId,
    name: z.string().optional().describe("Filter by mount name (exact match)"),
    limit,
  })
  .strict();

const listContainerMountsTool: ToolDefinition = {
  name: "list_container_mounts",
  title: "List Container Mounts",
  description:
    "List container volume mount definitions with source path, destination path, and mount name.",
  inputSchema: listContainerMountsInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listContainerMountsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing container mounts");
    try {
      const all = await context.routerClient.get<RouterOSRecord>("container/mounts", {
        limit: undefined,
        offset: undefined,
      });
      const filtered = parsed.name
        ? (all as Record<string, string>[]).filter((m) => m.name === parsed.name)
        : (all as Record<string, string>[]);
      const mounts = filtered.slice(0, parsed.limit);
      return {
        content: `Container mounts on ${context.routerId}: ${mounts.length} returned`,
        structuredContent: { routerId: context.routerId, mounts, total: all.length, returned: mounts.length },
      };
    } catch (err) {
      throw toolError(err, context, "list_container_mounts");
    }
  },
};

// ---------------------------------------------------------------------------
// manage_container_mount
// ---------------------------------------------------------------------------

const manageContainerMountInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove"]).describe("Action to perform"),
    name: z.string().describe("Mount name — idempotency key"),
    src: z.string().optional().describe("Host source path (required for add)"),
    dst: z.string().optional().describe("Container destination path (required for add)"),
    dryRun,
  })
  .strict();

const manageContainerMountTool: ToolDefinition = {
  name: "manage_container_mount",
  title: "Manage Container Mount",
  description:
    "Add or remove a container volume mount. Idempotent by name: add returns already_exists if the mount exists with matching src/dst; throws CONFLICT if name exists with different paths.",
  inputSchema: manageContainerMountInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageContainerMountInputSchema.parse(params);
    log.info({ routerId: context.routerId, action: parsed.action, name: parsed.name }, "Managing container mount");
    try {
      const all = await context.routerClient.get<RouterOSRecord>("container/mounts", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (all as Record<string, string>[]).find((m) => m.name === parsed.name);

      if (parsed.action === "add") {
        if (existing) {
          if (existing.src === parsed.src && existing.dst === parsed.dst) {
            return {
              content: `Mount "${parsed.name}" already exists with same paths.`,
              structuredContent: { action: "already_exists", name: parsed.name },
            };
          }
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "CONTAINER_MOUNT_CONFLICT",
            message: `Mount "${parsed.name}" exists with different src/dst paths.`,
            details: {
              existing: { src: existing.src, dst: existing.dst },
              requested: { src: parsed.src, dst: parsed.dst },
            },
            recoverability: {
              retryable: false,
              suggestedAction: "Remove the existing mount first.",
              alternativeTools: ["manage_container_mount"],
            },
          });
        }
        if (!parsed.src || !parsed.dst) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "MOUNT_PATHS_REQUIRED",
            message: "src and dst are required for add.",
            recoverability: { retryable: false, suggestedAction: "Provide src and dst parameters." },
          });
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would add mount "${parsed.name}" ${parsed.src} → ${parsed.dst}.`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "name", before: null, after: parsed.name }],
            },
          };
        }
        const created = await context.routerClient.create("container/mounts", {
          name: parsed.name,
          src: parsed.src,
          dst: parsed.dst,
        });
        log.info({ name: parsed.name, id: created[".id"] }, "Container mount added");
        return {
          content: `Added mount "${parsed.name}".`,
          structuredContent: { action: "created", name: parsed.name, id: created[".id"] },
        };
      }

      // remove
      if (!existing) {
        return {
          content: `Mount "${parsed.name}" not found. Nothing to remove.`,
          structuredContent: { action: "not_found", name: parsed.name },
        };
      }
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove mount "${parsed.name}".`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "name", before: parsed.name, after: null }],
          },
        };
      }
      await context.routerClient.remove("container/mounts", existing[".id"]);
      log.info({ name: parsed.name }, "Container mount removed");
      return {
        content: `Removed mount "${parsed.name}".`,
        structuredContent: { action: "removed", name: parsed.name },
      };
    } catch (err) {
      throw toolError(err, context, "manage_container_mount");
    }
  },
};

export const containerConfigTools: ToolDefinition[] = [
  getContainerConfigTool,
  manageContainerConfigTool,
  listContainerEnvsTool,
  manageContainerEnvTool,
  listContainerMountsTool,
  manageContainerMountTool,
];
