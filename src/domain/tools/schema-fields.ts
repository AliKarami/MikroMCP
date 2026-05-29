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
