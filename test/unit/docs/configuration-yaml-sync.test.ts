import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { IdentityRegistry } from "../../../src/config/identity-registry.js";
import { RouterRegistry } from "../../../src/config/router-registry.js";

const DOC = join(process.cwd(), "docs/wiki/Configuration.md");

/**
 * Every fenced ```yaml block in the Configuration page. Blocks are classified by
 * their top-level key so that full `identities:` / `routers:` documents are
 * loaded through the real registries, exactly as a user who copies them would.
 * Fragments (a lone `tls:` or `sshUsername:` snippet) have no top-level
 * registry key and are skipped.
 */
function yamlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fence = /^```yaml\n([\s\S]*?)^```/gm;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(markdown)) !== null) blocks.push(m[1]);
  return blocks;
}

function topLevelKeys(yaml: string): string[] {
  const parsed = parse(yaml) as unknown;
  return parsed && typeof parsed === "object" ? Object.keys(parsed as object) : [];
}

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mikromcp-config-doc-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("Configuration.md YAML examples load through the real registries", () => {
  const markdown = readFileSync(DOC, "utf-8");
  const blocks = yamlBlocks(markdown);
  const identityBlocks = blocks.filter((b) => topLevelKeys(b).includes("identities"));
  const routerBlocks = blocks.filter((b) => topLevelKeys(b).includes("routers"));

  it("documents at least one full identities.yaml example", () => {
    expect(identityBlocks.length).toBeGreaterThan(0);
  });

  it("documents at least one full routers.yaml example", () => {
    expect(routerBlocks.length).toBeGreaterThan(0);
  });

  it.each(identityBlocks.map((b, i) => [i + 1, b] as const))(
    "identities example #%i is accepted by IdentityRegistry",
    (_i, block) => {
      const path = tempFile("identities.yaml", block);
      const registry = new IdentityRegistry(path);
      expect(registry.getIdentities().length).toBeGreaterThan(0);
    },
  );

  it.each(routerBlocks.map((b, i) => [i + 1, b] as const))(
    "routers example #%i is accepted by RouterRegistry",
    (_i, block) => {
      const path = tempFile("routers.yaml", block);
      const registry = new RouterRegistry(path);
      expect(registry.listRouters().length).toBeGreaterThan(0);
    },
  );
});
