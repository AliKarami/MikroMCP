import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("packages-tools");

const PACKAGE_PATH = "system/package";

const listPackagesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    name: z.string().optional().describe("Filter by package name (exact match)"),
  })
  .strict();

const listPackagesTool: ToolDefinition = {
  name: "list_packages",
  title: "List Packages",
  description:
    "List installed RouterOS packages with version and enabled status.",
  inputSchema: listPackagesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listPackagesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing packages");

    try {
      let packages = await context.routerClient.get<RouterOSRecord>(PACKAGE_PATH, {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.name !== undefined) {
        packages = packages.filter((p) => (p as Record<string, string>).name === parsed.name);
      }

      return {
        content: `Packages on ${context.routerId}: ${packages.length} package(s).`,
        structuredContent: { routerId: context.routerId, packages, total: packages.length },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "list_packages" });
    }
  },
};

const managePackageInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["enable", "disable"]).describe("Action to perform"),
    name: z.string().describe("Package name"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const managePackageTool: ToolDefinition = {
  name: "manage_package",
  title: "Manage Package",
  description:
    "Enable or disable a RouterOS package. Changes take effect only after a router reboot — use the reboot tool to apply. Idempotent: no-op if already in the target state.",
  inputSchema: managePackageInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = managePackageInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing package",
    );

    try {
      const all = await context.routerClient.get<RouterOSRecord>(PACKAGE_PATH, {
        limit: undefined,
        offset: undefined,
      });
      const pkg = all.find(
        (p) => (p as Record<string, string>).name === parsed.name,
      ) as Record<string, string> | undefined;

      if (!pkg) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "PACKAGE_NOT_FOUND",
          message: `Package "${parsed.name}" is not installed on this router.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the package name with list_packages.",
            alternativeTools: ["list_packages"],
          },
        });
      }

      const wantDisabled = parsed.action === "disable";
      const isDisabled = pkg.disabled === "true";
      const id = pkg[".id"];

      if (isDisabled === wantDisabled) {
        return {
          content: `Package "${parsed.name}" is already ${wantDisabled ? "disabled" : "enabled"}. No changes made.`,
          structuredContent: { action: "no_change", name: parsed.name, id },
        };
      }

      if (parsed.dryRun) {
        const diff = [
          { property: "disabled", before: String(isDisabled), after: String(wantDisabled) },
        ];
        return {
          content: `Dry run: Would ${parsed.action} package "${parsed.name}". A reboot is required to apply.`,
          structuredContent: { action: "dry_run", diff },
        };
      }

      await context.routerClient.update(PACKAGE_PATH, id, {
        disabled: wantDisabled ? "true" : "false",
      });
      log.info({ name: parsed.name, id, action: parsed.action }, "Package toggled");

      return {
        content: `${parsed.action === "disable" ? "Disabled" : "Enabled"} package "${parsed.name}". A reboot is required to apply the change.`,
        structuredContent: { action: "updated", name: parsed.name, id },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_package" });
    }
  },
};

export const packagesTools: ToolDefinition[] = [listPackagesTool, managePackageTool];
