import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("certificate-tools");

const listCertificatesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    name: z.string().optional().describe("Filter by certificate name (substring match)"),
    expired: z
      .boolean()
      .optional()
      .describe("Filter by expiry status; omit to return all"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of certificates to return"),
  })
  .strict();

const listCertificatesTool: ToolDefinition = {
  name: "list_certificates",
  title: "List Certificates",
  description: "List certificates on a MikroTik router.",
  inputSchema: listCertificatesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listCertificatesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing certificates");
    try {
      const allCerts = await context.routerClient.get<RouterOSRecord>("certificate", {
        limit: undefined,
        offset: undefined,
      });

      const now = new Date();
      const filtered = (allCerts as Record<string, string>[])
        .filter((c) => (parsed.name ? (c.name ?? "").includes(parsed.name) : true))
        .filter((c) => {
          if (parsed.expired === undefined) return true;
          const invalidAfter = c["invalid-after"];
          if (!invalidAfter) {
            return parsed.expired === true;
          }
          const expiry = new Date(invalidAfter);
          return parsed.expired ? expiry < now : expiry >= now;
        });
      const certs = filtered.slice(0, parsed.limit);

      return {
        content: `Certificates on ${context.routerId}: ${certs.length} returned (${allCerts.length} total)`,
        structuredContent: {
          routerId: context.routerId,
          certificates: certs,
          total: allCerts.length,
          returned: certs.length,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_certificates");
    }
  },
};

const manageCertificateInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["remove", "trust", "untrust"]).describe("Action to perform"),
    name: z.string().describe("Certificate name — idempotency key"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageCertificateTool: ToolDefinition = {
  name: "manage_certificate",
  title: "Manage Certificate",
  description:
    "Remove, trust, or untrust a certificate. Idempotent: trust/untrust return early if already in the target state.",
  inputSchema: manageCertificateInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  snapshotPaths: ["certificate"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageCertificateInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing certificate",
    );
    try {
      const allCerts = await context.routerClient.get<RouterOSRecord>("certificate");
      const cert = (allCerts as Record<string, string>[]).find((c) => c.name === parsed.name);

      if (!cert) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "CERT_NOT_FOUND",
          message: `Certificate "${parsed.name}" not found.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the certificate name with list_certificates.",
            alternativeTools: ["list_certificates"],
          },
        });
      }

      if (parsed.action === "remove") {
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove certificate "${parsed.name}".`,
            structuredContent: { action: "dry_run", name: parsed.name, id: cert[".id"] },
          };
        }
        await context.routerClient.remove("certificate", cert[".id"]);
        log.info({ name: parsed.name, id: cert[".id"] }, "Certificate removed");
        return {
          content: `Removed certificate "${parsed.name}".`,
          structuredContent: { action: "removed", name: parsed.name, id: cert[".id"] },
        };
      }

      if (parsed.action === "trust") {
        if (cert.trusted === "yes") {
          return {
            content: `Certificate "${parsed.name}" is already trusted. No changes made.`,
            structuredContent: { action: "already_trusted", name: parsed.name },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would trust certificate "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              name: parsed.name,
              change: "trusted: no → yes",
            },
          };
        }
        await context.routerClient.update("certificate", cert[".id"], { trusted: "yes" });
        log.info({ name: parsed.name }, "Certificate trusted");
        return {
          content: `Certificate "${parsed.name}" is now trusted.`,
          structuredContent: { action: "trusted", name: parsed.name },
        };
      }

      // untrust
      if (cert.trusted === "no") {
        return {
          content: `Certificate "${parsed.name}" is already untrusted. No changes made.`,
          structuredContent: { action: "already_untrusted", name: parsed.name },
        };
      }
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would untrust certificate "${parsed.name}".`,
          structuredContent: {
            action: "dry_run",
            name: parsed.name,
            change: "trusted: yes → no",
          },
        };
      }
      await context.routerClient.update("certificate", cert[".id"], { trusted: "no" });
      log.info({ name: parsed.name }, "Certificate untrusted");
      return {
        content: `Certificate "${parsed.name}" is now untrusted.`,
        structuredContent: { action: "untrusted", name: parsed.name },
      };
    } catch (err) {
      throw toolError(err, context, "manage_certificate");
    }
  },
};

export const certificateTools: ToolDefinition[] = [listCertificatesTool, manageCertificateTool];
