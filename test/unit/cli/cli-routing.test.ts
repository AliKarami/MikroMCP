import { describe, it, expect } from "vitest";
import { program } from "../../../src/cli/index.js";

describe("CLI routing", () => {
  it("has a serve command registered", () => {
    const cmd = program.commands.find((c) => c.name() === "serve");
    expect(cmd).toBeDefined();
  });

  it("serve is the default command", () => {
    // Commander v8+ tracks the default command name on the parent program
    expect((program as unknown as { _defaultCommandName?: string })._defaultCommandName).toBe(
      "serve",
    );
  });

  it("has a doctor command registered", () => {
    expect(program.commands.find((c) => c.name() === "doctor")).toBeDefined();
  });

  it("has an init command registered", () => {
    expect(program.commands.find((c) => c.name() === "init")).toBeDefined();
  });
});
