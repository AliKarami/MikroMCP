import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IdentityRegistry } from "../../../src/config/identity-registry.js";
import bcrypt from "bcryptjs";

function tempYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mikromcp-id-"));
  const path = join(dir, "identities.yaml");
  writeFileSync(path, content);
  return path;
}

// Use cost 4 in tests for speed
async function hashToken(token: string): Promise<string> {
  return bcrypt.hash(token, 4);
}

describe("IdentityRegistry", () => {
  it("starts empty and does not throw when file does not exist", () => {
    expect(() => new IdentityRegistry("/nonexistent/identities.yaml")).not.toThrow();
  });

  it("loads a valid identities.yaml without throwing", async () => {
    const hash = await hashToken("mysecrettoken");
    const path = tempYaml(`
identities:
  admin-ali:
    token: "${hash}"
    role: admin
    allowedRouters: []
    allowedToolPatterns: []
`);
    expect(() => new IdentityRegistry(path)).not.toThrow();
  });

  it("throws on unknown field in identity config", async () => {
    const hash = await hashToken("tok");
    const path = tempYaml(`
identities:
  bad:
    token: "${hash}"
    role: admin
    allowedRouters: []
    allowedToolPatterns: []
    unknownField: true
`);
    expect(() => new IdentityRegistry(path)).toThrow();
  });

  it("throws on invalid role value", async () => {
    const hash = await hashToken("tok");
    const path = tempYaml(`
identities:
  bad:
    token: "${hash}"
    role: superuser
    allowedRouters: []
    allowedToolPatterns: []
`);
    expect(() => new IdentityRegistry(path)).toThrow();
  });

  it("findIdentityByToken returns matching identity", async () => {
    const raw = "my-raw-token-12345";
    const hash = await hashToken(raw);
    const path = tempYaml(`
identities:
  ci-pipeline:
    token: "${hash}"
    role: operator
    allowedRouters: ["edge-01"]
    allowedToolPatterns: ["list_*"]
`);
    const registry = new IdentityRegistry(path);
    const found = await registry.findIdentityByToken(raw);
    expect(found).not.toBeNull();
    expect(found!.id).toBe("ci-pipeline");
    expect(found!.role).toBe("operator");
    expect(found!.allowedRouters).toEqual(["edge-01"]);
    expect(found!.allowedToolPatterns).toEqual(["list_*"]);
  });

  it("findIdentityByToken returns null for wrong token", async () => {
    const hash = await hashToken("correct-token");
    const path = tempYaml(`
identities:
  ci-pipeline:
    token: "${hash}"
    role: operator
    allowedRouters: []
    allowedToolPatterns: []
`);
    const registry = new IdentityRegistry(path);
    const found = await registry.findIdentityByToken("wrong-token");
    expect(found).toBeNull();
  });

  it("getIdentities returns all loaded identities", async () => {
    const hash = await hashToken("tok");
    const path = tempYaml(`
identities:
  admin-ali:
    token: "${hash}"
    role: admin
    allowedRouters: []
    allowedToolPatterns: []
  ci-pipeline:
    token: "${hash}"
    role: operator
    allowedRouters: ["edge-01"]
    allowedToolPatterns: []
`);
    const registry = new IdentityRegistry(path);
    expect(registry.getIdentities()).toHaveLength(2);
  });
});
