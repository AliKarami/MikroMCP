import { describe, it, expect, afterAll } from "vitest";
import { createHarness, runTool } from "./helpers/harness.js";

const harness = createHarness();

afterAll(() => harness.close());

describe("ping against live CHR (SSH transport, like run_command)", () => {
  it("pings the router's own address", async () => {
    const result = await runTool(harness.context, "ping", {
      address: "127.0.0.1",
      count: 2,
    });

    expect(result.content.length).toBeGreaterThan(0);
    expect(result.structuredContent).toBeTruthy();
  });
});

describe("SSH-backed tools against live CHR", () => {
  it("run_command executes a console command over SSH", async () => {
    const result = await runTool(harness.context, "run_command", {
      command: "/system identity print",
    });

    expect(result.content).toContain("name:");
  });

  it("run_command dry-run validates without executing", async () => {
    const result = await runTool(harness.context, "run_command", {
      command: "/system identity print",
      dryRun: true,
    });

    expect(result.structuredContent.action).toBe("dry_run");
  });

  it("run_command refuses a deny-listed command", async () => {
    await expect(
      runTool(harness.context, "run_command", {
        command: "/system reset-configuration",
      }),
    ).rejects.toMatchObject({ code: "COMMAND_DENIED" });
  });

  it("export_config returns the running config as a script", async () => {
    const result = await runTool(harness.context, "export_config", { compact: true });

    expect(result.content).toContain("/");
    expect(result.structuredContent).toBeTruthy();
  });
});

describe("REST diagnostics against live CHR", () => {
  it("traceroute returns the final hops once, numbered from 1", async () => {
    const result = await runTool(harness.context, "traceroute", {
      address: "127.0.0.1",
      count: 1,
      maxHops: 2,
    });

    const hops = result.structuredContent.hops as Array<Record<string, unknown>>;
    expect(hops.length).toBeGreaterThan(0);
    hops.forEach((hop, i) => expect(hop.hop).toBe(i + 1));
  });

  it("torch on ether1 ends after its duration and returns a flow list", async () => {
    const started = Date.now();
    const result = await runTool(harness.context, "torch", { interface: "ether1", duration: 2 });

    expect(Array.isArray(result.structuredContent.flows)).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("torch on a missing interface fails with VALIDATION instead of an empty capture", async () => {
    await expect(
      runTool(harness.context, "torch", { interface: "ether99", duration: 1 }),
    ).rejects.toMatchObject({ category: "VALIDATION" });
  });
});
