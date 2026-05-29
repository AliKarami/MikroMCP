import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("container-tools");

const CONTAINER_PATH = "container";

const listContainersInputSchema = z
  .object({
    routerId,
  })
  .strict();

const listContainersTool: ToolDefinition = {
  name: "list_containers",
  title: "List Containers",
  description: "List RouterOS container instances with status, image, and network information.",
  inputSchema: listContainersInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    listContainersInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing containers");

    try {
      const containers = await context.routerClient.get<RouterOSRecord>(CONTAINER_PATH, {
        limit: undefined,
        offset: undefined,
      });

      return {
        content: `Containers on ${context.routerId}: ${containers.length} container(s).`,
        structuredContent: { routerId: context.routerId, containers, total: containers.length },
      };
    } catch (err) {
      throw toolError(err, context, "list_containers");
    }
  },
};

const manageContainerInputSchema = z
  .object({
    routerId,
    action: z.enum(["create", "start", "stop", "remove"]).describe("Action to perform"),
    name: z.string().describe("Container name — idempotency key"),
    remoteImage: z
      .string()
      .optional()
      .describe("Docker image to pull (required on create, e.g. alpine:latest)"),
    interface: z
      .string()
      .optional()
      .describe(
        "veth interface name to attach the container to (required on create — must be pre-configured in RouterOS)",
      ),
    rootDir: z.string().optional().describe("Root directory for container files"),
    envlist: z
      .string()
      .optional()
      .describe("RouterOS environment list name for container env vars"),
    comment: z.string().optional().describe("Optional comment"),
    dryRun,
  })
  .strict();

const manageContainerTool: ToolDefinition = {
  name: "manage_container",
  title: "Manage Container",
  description:
    "Create, start, stop, or remove a RouterOS container. create needs a pre-configured veth interface; start/stop are no-ops when already in the target state; remove throws NOT_FOUND when absent. Supports dry-run.",
  inputSchema: manageContainerInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["container"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageContainerInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing container",
    );

    try {
      const all = await context.routerClient.get<RouterOSRecord>(CONTAINER_PATH, {
        limit: undefined,
        offset: undefined,
      });
      const existing = all.find((c) => (c as Record<string, string>).name === parsed.name) as
        | Record<string, string>
        | undefined;

      if (parsed.action === "create") {
        if (parsed.remoteImage === undefined) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "REMOTE_IMAGE_REQUIRED",
            message: "remoteImage is required when action is create",
            recoverability: {
              retryable: false,
              suggestedAction:
                "Provide the Docker image name in the remoteImage field (e.g. alpine:latest).",
            },
          });
        }

        if (parsed.interface === undefined) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "INTERFACE_REQUIRED",
            message: "interface is required when action is create",
            recoverability: {
              retryable: false,
              suggestedAction:
                "Provide the veth interface name. The interface must be pre-configured in RouterOS before creating a container.",
            },
          });
        }

        if (existing) {
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "CONTAINER_CONFLICT",
            message: `Container "${parsed.name}" already exists.`,
            details: {
              existing: { name: existing.name, ".id": existing[".id"], status: existing.status },
            },
            recoverability: {
              retryable: false,
              suggestedAction:
                "Remove the existing container first with action=remove, then re-create.",
              alternativeTools: ["manage_container with action=remove"],
            },
          });
        }

        const body: Record<string, string> = {
          name: parsed.name,
          "remote-image": parsed.remoteImage,
          interface: parsed.interface,
        };
        if (parsed.rootDir !== undefined) body["root-dir"] = parsed.rootDir;
        if (parsed.envlist !== undefined) body.envlist = parsed.envlist;
        if (parsed.comment !== undefined) body.comment = parsed.comment;

        if (parsed.dryRun) {
          const diff = Object.entries(body).map(([property, after]) => ({
            property,
            before: null,
            after,
          }));
          return {
            content: `Dry run: Would create container "${parsed.name}" with image "${parsed.remoteImage}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const created = await context.routerClient.create(CONTAINER_PATH, body);
        log.info({ name: parsed.name, id: created[".id"] }, "Container created");
        return {
          content: `Created container "${parsed.name}" with image "${parsed.remoteImage}".`,
          structuredContent: { action: "created", container: created },
        };
      }

      const container = existing;

      if (
        !container &&
        (parsed.action === "start" || parsed.action === "stop" || parsed.action === "remove")
      ) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "CONTAINER_NOT_FOUND",
          message: `Container "${parsed.name}" not found.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the container name with list_containers.",
            alternativeTools: ["list_containers"],
          },
        });
      }

      const id = container![".id"];

      if (parsed.action === "start") {
        if (container!.status === "running") {
          return {
            content: `Container "${parsed.name}" is already running. No changes made.`,
            structuredContent: { action: "no_change", name: parsed.name, id },
          };
        }

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would start container "${parsed.name}".`,
            structuredContent: { action: "dry_run", name: parsed.name, id },
          };
        }

        await context.routerClient.execute(`${CONTAINER_PATH}/start`, { ".id": id });
        log.info({ name: parsed.name, id }, "Container started");
        return {
          content: `Started container "${parsed.name}".`,
          structuredContent: { action: "started", name: parsed.name, id },
        };
      }

      if (parsed.action === "stop") {
        if (container!.status === "stopped") {
          return {
            content: `Container "${parsed.name}" is already stopped. No changes made.`,
            structuredContent: { action: "no_change", name: parsed.name, id },
          };
        }

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would stop container "${parsed.name}".`,
            structuredContent: { action: "dry_run", name: parsed.name, id },
          };
        }

        await context.routerClient.execute(`${CONTAINER_PATH}/stop`, { ".id": id });
        log.info({ name: parsed.name, id }, "Container stopped");
        return {
          content: `Stopped container "${parsed.name}".`,
          structuredContent: { action: "stopped", name: parsed.name, id },
        };
      }

      if (parsed.action === "remove") {
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove container "${parsed.name}".`,
            structuredContent: { action: "dry_run", name: parsed.name, id },
          };
        }

        await context.routerClient.remove(CONTAINER_PATH, id);
        log.info({ name: parsed.name, id }, "Container removed");
        return {
          content: `Removed container "${parsed.name}".`,
          structuredContent: { action: "removed", name: parsed.name, id },
        };
      }

      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "INVALID_ACTION",
        message: `Unknown action: ${parsed.action as string}`,
        recoverability: {
          retryable: false,
          suggestedAction: "Use one of: create, start, stop, remove.",
        },
      });
    } catch (err) {
      throw toolError(err, context, "manage_container");
    }
  },
};

export const containerTools: ToolDefinition[] = [listContainersTool, manageContainerTool];
