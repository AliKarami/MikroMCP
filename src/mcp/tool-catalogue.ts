import { allTools, toolsets, ALWAYS_ON_TOOLS } from "../domain/tools/index.js";
import type { ToolDefinition } from "../domain/tools/tool-definition.js";
import type { Identity } from "../types.js";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";
import { globMatch } from "../util/glob.js";

export interface CatalogueOptions {
  /** Register only tools with `readOnlyHint: true`. */
  readOnly: boolean;
  /** Toolset names to register; empty means every toolset. */
  toolsets: string[];
}

export function toolsetNames(): string[] {
  return Object.keys(toolsets);
}

/** Throws a CONFIGURATION error naming the valid toolsets when one is unknown. */
export function assertKnownToolsets(names: string[]): void {
  const known = new Set(toolsetNames());
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length === 0) return;
  throw new MikroMCPError({
    category: ErrorCategory.CONFIGURATION,
    code: "UNKNOWN_TOOLSET",
    message: `MIKROMCP_TOOLSETS names unknown toolsets: ${unknown.join(", ")}. Valid: ${toolsetNames().join(", ")}.`,
    details: { unknown, valid: toolsetNames() },
    recoverability: {
      retryable: false,
      suggestedAction: "Use toolset names from the Configuration page, or unset MIKROMCP_TOOLSETS.",
    },
  });
}

/** The server-wide catalogue: what MIKROMCP_READ_ONLY and MIKROMCP_TOOLSETS leave in. */
export function selectCatalogue(options: CatalogueOptions): ToolDefinition[] {
  const selected = new Set(options.toolsets);
  const inToolsets =
    selected.size === 0
      ? allTools
      : allTools.filter(
          (tool) =>
            ALWAYS_ON_TOOLS.has(tool.name) ||
            Object.entries(toolsets).some(
              ([name, tools]) => selected.has(name) && tools.includes(tool),
            ),
        );
  return options.readOnly ? inToolsets.filter((t) => t.annotations.readOnlyHint) : inToolsets;
}

/**
 * The tools an identity's allowedToolPatterns permit. This only shapes tools/list:
 * the executor still checks every call, so a hidden tool stays refused.
 */
export function toolsForIdentity(
  tools: ToolDefinition[],
  identity: Identity | undefined,
): ToolDefinition[] {
  const patterns = identity?.allowedToolPatterns ?? [];
  if (patterns.length === 0) return tools;
  return tools.filter((tool) => patterns.some((p) => globMatch(p, tool.name)));
}

/** One sentence for the server instructions when the catalogue is reduced, else undefined. */
export function catalogueNote(options: CatalogueOptions): string | undefined {
  const parts: string[] = [];
  if (options.readOnly) parts.push("read-only: write tools are not available");
  if (options.toolsets.length > 0) parts.push(`toolsets: ${options.toolsets.join(", ")}`);
  if (parts.length === 0) return undefined;
  return `This server exposes a reduced tool catalogue (${parts.join("; ")}); tools outside it cannot be called here.`;
}
