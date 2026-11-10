import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, runTool } from "./helpers/harness.js";
import { revertScript, startAfter } from "../../src/domain/tools/auto-revert.js";
import type { FirewallRevert } from "../../src/domain/tools/auto-revert.js";
import { MikroMCPError } from "../../src/domain/errors/error-types.js";
import { isTrue } from "../../src/adapter/response-parser.js";
import type { RouterOSRecord } from "../../src/types.js";

const harness = createHarness();
const client = harness.context.routerClient;

const FILTER = "ip/firewall/filter";
const SCHEDULER = "system/scheduler";
const PREFIX = "mikromcp-itest-ar";
// A chain nothing jumps to: rules in it never match traffic.
const CHAIN = "mikromcp-itest-ar";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // The router may be refusing new connections until the revert runs.
    }
    await sleep(1_000);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

const rules = () => client.get<RouterOSRecord>(FILTER, {});
const chainRules = async () => (await rules()).filter((r) => r.chain === CHAIN);
const withComment = async (comment: string) => (await rules()).filter((r) => r.comment === comment);
const job = async (name: string) =>
  (await client.get<RouterOSRecord>(SCHEDULER, { filter: { name } }))[0];
const autoRevertJobs = async () =>
  (await client.get<RouterOSRecord>(SCHEDULER, {})).filter((j) =>
    String(j.name).startsWith("mikromcp-autorevert-"),
  );

async function addRule(comment: string, extra: Record<string, string> = {}) {
  return client.create(FILTER, { chain: CHAIN, action: "accept", comment, ...extra });
}

async function clock(): Promise<Record<string, unknown>> {
  const result: unknown = await client.get(`system/clock`);
  return (Array.isArray(result) ? result[0] : result) as Record<string, unknown>;
}

let jobCount = 0;

/** Arm a revert job the way guardedWrite does, without the write or the disarm. */
async function arm(revert: FirewallRevert, seconds: number): Promise<string> {
  const name = `${PREFIX}-job-${++jobCount}`;
  await client.create(SCHEDULER, {
    name,
    ...startAfter(await clock(), seconds),
    interval: `${seconds}s`,
    policy: "read,write",
    "on-event": revertScript(name, FILTER, revert, "integration test"),
  });
  return name;
}

async function cleanup(): Promise<void> {
  for (const r of await rules()) {
    if (r.chain === CHAIN || String(r.comment ?? "").startsWith(PREFIX)) {
      await client.remove(FILTER, r[".id"]);
    }
  }
  for (const j of await client.get<RouterOSRecord>(SCHEDULER, {})) {
    const name = String(j.name);
    if (name.startsWith(PREFIX) || name.startsWith("mikromcp-autorevert-")) {
      await client.remove(SCHEDULER, j[".id"]);
    }
  }
}

beforeAll(cleanup);

afterAll(async () => {
  await cleanup();
  harness.close();
});

describe("auto-revert scheduler job on a live CHR", () => {
  it("first runs at the router clock plus the delay, not when it is added", async () => {
    const rule = await addRule(`${PREFIX}-timing`);
    const name = await arm({ kind: "remove-id", id: rule[".id"] }, 600);
    await sleep(3_000);

    const entry = await job(name);
    expect(entry).toBeDefined();
    expect(Number(entry["run-count"])).toBe(0);
    expect(await withComment(`${PREFIX}-timing`)).toHaveLength(1);
    await client.remove(SCHEDULER, entry[".id"]);
  });

  it("remove-id: removes the added rule, then the job itself", async () => {
    const rule = await addRule(`${PREFIX}-added`);
    const name = await arm({ kind: "remove-id", id: rule[".id"] }, 5);

    await waitFor(async () => (await withComment(`${PREFIX}-added`)).length === 0, 30_000);
    await waitFor(async () => (await job(name)) === undefined, 10_000);
  }, 60_000);

  it("set-disabled: puts the disabled flag back", async () => {
    const rule = await addRule(`${PREFIX}-toggle`, { disabled: "false" });
    await arm({ kind: "set-disabled", id: rule[".id"], disabled: true }, 5);

    await waitFor(async () => isTrue((await withComment(`${PREFIX}-toggle`))[0]?.disabled), 30_000);
  }, 60_000);

  it("restore: re-adds a removed rule at its old position, once", async () => {
    await addRule(`${PREFIX}-a`);
    const b = await addRule(`${PREFIX}-b`, { protocol: "tcp", "dst-port": "8729" });
    const c = await addRule(`${PREFIX}-c`);
    const record = (await withComment(`${PREFIX}-b`))[0];
    await client.remove(FILTER, b[".id"]);

    const revert: FirewallRevert = {
      kind: "restore",
      record,
      placeBefore: c[".id"],
      sameComment: 1,
    };
    await arm(revert, 5);
    await waitFor(async () => (await withComment(`${PREFIX}-b`)).length === 1, 30_000);

    const order = (await chainRules())
      .map((r) => r.comment)
      .filter((c) => [`${PREFIX}-a`, `${PREFIX}-b`, `${PREFIX}-c`].includes(String(c)));
    expect(order).toEqual([`${PREFIX}-a`, `${PREFIX}-b`, `${PREFIX}-c`]);
    expect((await withComment(`${PREFIX}-b`))[0]).toMatchObject({
      protocol: "tcp",
      "dst-port": 8729,
    });

    // The same job firing again adds nothing.
    const again = await arm(revert, 5);
    await waitFor(async () => (await job(again)) === undefined, 30_000);
    expect(await withComment(`${PREFIX}-b`)).toHaveLength(1);
  }, 120_000);

  it("restore: works when another rule shares the removed rule's comment", async () => {
    const first = await addRule(`${PREFIX}-shared`);
    await addRule(`${PREFIX}-shared`);
    const record = (await withComment(`${PREFIX}-shared`)).find((r) => r[".id"] === first[".id"])!;
    await client.remove(FILTER, first[".id"]);

    await arm({ kind: "restore", record, sameComment: 2 }, 5);
    await waitFor(async () => (await withComment(`${PREFIX}-shared`)).length === 2, 30_000);
  }, 60_000);

  it("restore: brings back a comment with quotes, $ and ? unchanged", async () => {
    const comment = `${PREFIX} "quoted" $notAVar ?x`;
    const rule = await addRule(comment);
    const record = (await withComment(comment))[0];
    await client.remove(FILTER, rule[".id"]);

    await arm({ kind: "restore", record, sameComment: 1 }, 5);
    await waitFor(async () => (await withComment(comment)).length === 1, 30_000);
  }, 60_000);

  it("remove-new: removes only rules added to the chain after it was armed", async () => {
    await addRule(`${PREFIX}-old`);
    const knownIds = (await chainRules()).map((r) => r[".id"]);
    await addRule(`${PREFIX}-new`);

    await arm({ kind: "remove-new", chain: CHAIN, knownIds }, 5);
    await waitFor(async () => (await withComment(`${PREFIX}-new`)).length === 0, 30_000);
    expect(await withComment(`${PREFIX}-old`)).toHaveLength(1);
  }, 60_000);
});

describe("manage_firewall_rule with auto-revert on a live CHR", () => {
  it("disarms the job once the router answers after a harmless change", async () => {
    const added = await runTool(harness.context, "manage_firewall_rule", {
      action: "add",
      chain: CHAIN,
      ruleAction: "accept",
      comment: `${PREFIX}-tool`,
      autoRevertSeconds: 30,
    });
    expect(added.structuredContent).toMatchObject({
      action: "created",
      autoRevert: { status: "disarmed", healthCheck: "ok", revert: "remove-id" },
    });
    expect(await autoRevertJobs()).toHaveLength(0);
    expect(await withComment(`${PREFIX}-tool`)).toHaveLength(1);

    const removed = await runTool(harness.context, "manage_firewall_rule", {
      action: "remove",
      chain: CHAIN,
      ruleAction: "accept",
      comment: `${PREFIX}-tool`,
      autoRevertSeconds: 30,
    });
    expect(removed.structuredContent).toMatchObject({
      action: "removed",
      autoRevert: { status: "disarmed" },
    });
    expect(await autoRevertJobs()).toHaveLength(0);
    expect(await withComment(`${PREFIX}-tool`)).toHaveLength(0);
  }, 90_000);

  it("a rule that cuts off REST is reported and reverted by the router itself", async () => {
    let error: unknown;
    try {
      await runTool(harness.context, "manage_firewall_rule", {
        action: "add",
        chain: "input",
        ruleAction: "drop",
        protocol: "tcp",
        dstPort: "80",
        connectionState: "new",
        comment: `${PREFIX}-lockout`,
        autoRevertSeconds: 45,
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(MikroMCPError);
    expect((error as MikroMCPError).code).toBe("AUTO_REVERT_PENDING");

    await waitFor(async () => {
      await client.probe(5_000);
      return true;
    }, 90_000);
    expect(await withComment(`${PREFIX}-lockout`)).toHaveLength(0);
    expect(await autoRevertJobs()).toHaveLength(0);
  }, 180_000);
});
