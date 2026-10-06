import { describe, it, expect } from "vitest";
import { allTools } from "../../../src/domain/tools/index.js";
import { diagnosticTools } from "../../../src/domain/tools/diagnostic-tools.js";
import { networkTestTools } from "../../../src/domain/tools/network-test-tools.js";
import { BULK_READ_EXCLUDED_TOOLS } from "../../../src/domain/tools/fleet-tools.js";

/**
 * bulk_read refuses these by name. If one is renamed, the exclusion silently stops
 * matching and bulk_read starts fanning traffic out across the fleet, so the names
 * are checked against the real catalog rather than against mocks.
 */
describe("bulk_read exclusions stay in step with the tool catalog", () => {
  const byName = new Map(allTools.map((tool) => [tool.name, tool]));

  it.each([...BULK_READ_EXCLUDED_TOOLS])("%s exists and is annotated read-only", (name) => {
    const tool = byName.get(name);
    expect(tool).toBeDefined();
    expect(tool!.annotations.readOnlyHint).toBe(true);
  });

  it("excludes exactly the read-only diagnostics that send traffic or load the router", () => {
    // Read-only diagnostics that only read state. A new read-only tool in these
    // modules must be added either here or to BULK_READ_EXCLUDED_TOOLS.
    const passive = new Set(["get_log", "list_connections"]);
    const active = [...diagnosticTools, ...networkTestTools]
      .filter((tool) => tool.annotations.readOnlyHint && !passive.has(tool.name))
      .map((tool) => tool.name);
    expect([...BULK_READ_EXCLUDED_TOOLS].sort()).toEqual(active.sort());
  });
});
