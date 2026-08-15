import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../../../src/version.js";

/**
 * mikromcp.com renders the release version in its footer. It reads that from
 * site/src/data/version.ts, which scripts/sync-version.mjs regenerates alongside
 * src/version.ts on `npm version`. This guards against the site being deployed
 * with a stale version if the script is bypassed.
 */
describe("landing site version matches package version", () => {
  it("site/src/data/version.ts exports the current VERSION", () => {
    const source = readFileSync(join(process.cwd(), "site/src/data/version.ts"), "utf-8");
    const match = source.match(/export const VERSION = "([^"]+)"/);
    expect(match, "no VERSION export found in site/src/data/version.ts").not.toBeNull();
    expect(match?.[1]).toBe(VERSION);
  });

  it("README version badge matches the current VERSION", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf-8");
    const badges = [...readme.matchAll(/version-v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    expect(badges.length, "no version badge found in README.md").toBeGreaterThan(0);
    expect(badges.filter((v) => v !== VERSION)).toEqual([]);
  });
});
