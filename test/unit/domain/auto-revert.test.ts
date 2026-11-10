import { describe, it, expect, vi, afterEach } from "vitest";
import {
  addArguments,
  guardedWrite,
  startAfter,
  revertScript,
  rosString,
} from "../../../src/domain/tools/auto-revert.js";
import type { GuardOptions } from "../../../src/domain/tools/auto-revert.js";
import { firewallTools } from "../../../src/domain/tools/firewall-tools.js";
import { MikroMCPError } from "../../../src/domain/errors/error-types.js";
import { HttpError } from "../../../src/adapter/rest-client.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import { fromWire, type WireRecord } from "../helpers/wire.js";

const SCHEDULER = "system/scheduler";
const CLOCK = { date: "2026-11-11", time: "23:59:30", "time-zone-name": "Europe/Berlin" };
const manageFirewallRule = firewallTools[1];

interface Client {
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  probe: ReturnType<typeof vi.fn>;
}

/**
 * A client where `events` records the order of router calls. The scheduler job
 * is still listed at disarm time unless `jobGone` is set.
 */
function makeClient(
  opts: {
    rules?: WireRecord[];
    probe?: () => Promise<void>;
    jobGone?: boolean;
    armError?: unknown;
    clock?: Record<string, string>;
  } = {},
) {
  const events: string[] = [];
  const client: Client = {
    get: vi.fn((path: string, query?: { filter?: Record<string, string> }) => {
      events.push(`get ${path}`);
      if (path === SCHEDULER) return Promise.resolve(opts.jobGone ? [] : [{ ".id": "*S1" }]);
      if (path === "system/clock") return Promise.resolve(opts.clock ?? CLOCK);
      const comment = query?.filter?.comment;
      const rules = fromWire(opts.rules ?? []);
      return Promise.resolve(
        comment === undefined ? rules : rules.filter((r) => r.comment === comment),
      );
    }),
    create: vi.fn((path: string) => {
      events.push(`create ${path}`);
      if (path === SCHEDULER) {
        return opts.armError ? Promise.reject(opts.armError) : Promise.resolve({ ".id": "*S1" });
      }
      return Promise.resolve({ ".id": "*2A" });
    }),
    update: vi.fn((path: string) => {
      events.push(`update ${path}`);
      return Promise.resolve(undefined);
    }),
    remove: vi.fn((path: string) => {
      events.push(`remove ${path}`);
      return Promise.resolve(undefined);
    }),
    probe: vi.fn(() => {
      events.push("probe");
      return opts.probe ? opts.probe() : Promise.resolve();
    }),
  };
  const context = { routerId: "r1", correlationId: "c1", routerClient: client };
  return { client, events, context: context as unknown as ToolContext };
}

const guard: GuardOptions = {
  seconds: 60,
  path: "ip/firewall/filter",
  revert: { kind: "set-disabled", id: "*5", disabled: false },
  description: 'disable filter rule "allow-mgmt"',
};

async function caught(promise: Promise<unknown>): Promise<MikroMCPError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof MikroMCPError) return err;
    throw err;
  }
  throw new Error("expected a MikroMCPError");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("revert scripts", () => {
  it("escapes RouterOS string literals, including $ interpolation", () => {
    expect(rosString('a "b" $x \\ ?')).toBe('"a \\"b\\" \\$x \\\\ \\?"');
  });

  it("removes the added rule by id", () => {
    const script = revertScript("job", "ip/firewall/filter", { kind: "remove-id", id: "*2A" }, "x");
    expect(script).toContain("/ip firewall filter remove [find where .id=*2A]");
    expect(script).toContain('/system scheduler remove [find where name="job"]');
  });

  it("puts the disabled flag back", () => {
    const script = revertScript(
      "job",
      "ip/firewall/nat",
      { kind: "set-disabled", id: "*5", disabled: true },
      "x",
    );
    expect(script).toContain("/ip firewall nat set [find where .id=*5] disabled=yes");
  });

  it("before the id is known, removes only rules in the chain that were not there before", () => {
    const script = revertScript(
      "job",
      "ip/firewall/filter",
      { kind: "remove-new", chain: "input", knownIds: ["*1", "*2"] },
      "x",
    );
    expect(script).toContain(':local known ",*1,*2,"');
    expect(script).toContain('find where chain="input" and dynamic=no');
    expect(script).toContain("/ip firewall filter remove $i");
  });

  it("re-adds a removed rule at its position, once, without read-only fields", () => {
    const record = fromWire([
      {
        ".id": "*7",
        chain: "input",
        action: "accept",
        "dst-port": "443",
        protocol: "tcp",
        comment: "allow-mgmt",
        disabled: "false",
        bytes: "1234",
        packets: "5",
        dynamic: "false",
        invalid: "false",
      },
    ])[0];
    const script = revertScript(
      "job",
      "ip/firewall/filter",
      { kind: "restore", record, placeBefore: "*9", sameComment: 1 },
      "x",
    );
    const add =
      '/ip firewall filter add chain="input" action="accept" dst-port="443" protocol="tcp" comment="allow-mgmt" disabled=no';
    expect(script).toContain(
      ':if ([:len [/ip firewall filter find where comment="allow-mgmt"]] < 1)',
    );
    expect(script).toContain(`:do {${add} place-before=*9} on-error={${add}}`);
    expect(addArguments(record)).not.toMatch(/bytes|packets|dynamic|invalid|\.id/);
  });

  it("refuses to embed something that is not a RouterOS id", () => {
    expect(() =>
      revertScript(
        "job",
        "ip/firewall/filter",
        { kind: "remove-id", id: "*1]; /system reset" },
        "x",
      ),
    ).toThrow(MikroMCPError);
  });
});

describe("startAfter", () => {
  it("adds the delay to an ISO clock, across midnight and month end", () => {
    expect(startAfter({ date: "2026-12-31", time: "23:59:50" }, 60)).toEqual({
      "start-date": "2027-01-01",
      "start-time": "00:00:50",
    });
  });

  it("keeps the legacy date format the router reports", () => {
    expect(startAfter({ date: "feb/28/2028", time: "23:30:00" }, 3600)).toEqual({
      "start-date": "feb/29/2028",
      "start-time": "00:30:00",
    });
  });

  it("refuses a clock it cannot read", () => {
    expect(() => startAfter({ date: "11/11/2026", time: "10:00:00" }, 60)).toThrow(
      /AUTO_REVERT_CLOCK_UNREADABLE|Cannot read the router clock/,
    );
  });
});

describe("guardedWrite", () => {
  it("arms the job, applies the change, checks health, then removes the job", async () => {
    const { client, events, context } = makeClient();
    const write = vi.fn(async () => {
      events.push("write");
      return "done";
    });

    const { result, autoRevert } = await guardedWrite(context, guard, write);

    expect(result).toBe("done");
    expect(events).toEqual([
      "get system/clock",
      `create ${SCHEDULER}`,
      "write",
      "probe",
      `get ${SCHEDULER}`,
      `remove ${SCHEDULER}`,
    ]);
    const [, job] = client.create.mock.calls[0];
    // The first run is pinned 60s ahead: a new entry otherwise runs when added.
    expect(job).toMatchObject({
      "start-date": "2026-11-12",
      "start-time": "00:00:30",
      interval: "60s",
      policy: "read,write",
    });
    expect(job.name).toMatch(/^mikromcp-autorevert-/);
    expect(job["on-event"]).toContain("/ip firewall filter set [find where .id=*5] disabled=no");
    expect(client.remove).toHaveBeenCalledWith(SCHEDULER, "*S1");
    expect(autoRevert).toMatchObject({ status: "disarmed", healthCheck: "ok", seconds: 60 });
  });

  it("leaves the job armed and says so when the router stops answering", async () => {
    vi.useFakeTimers();
    const { client, context } = makeClient({
      probe: () => Promise.reject(new Error("connect ETIMEDOUT")),
    });

    const pending = caught(guardedWrite(context, guard, async () => "done"));
    await vi.runAllTimersAsync();
    const err = await pending;

    expect(err.code).toBe("AUTO_REVERT_PENDING");
    expect(err.category).toBe("ROUTER_UNREACHABLE");
    expect(err.message).toMatch(/left armed/);
    expect(err.details?.autoRevert).toMatchObject({ status: "armed", healthCheck: "failed" });
    expect(client.probe).toHaveBeenCalledTimes(2);
    expect(client.remove).not.toHaveBeenCalled();
  });

  it("does not apply the change when the router clock cannot be read", async () => {
    const { client, context } = makeClient({ clock: { date: "", time: "" } });
    const write = vi.fn();

    const err = await caught(guardedWrite(context, guard, write));

    expect(err.code).toBe("AUTO_REVERT_ARM_FAILED");
    expect(client.create).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not apply the change when the job cannot be armed", async () => {
    const { context } = makeClient({
      armError: new HttpError(403, '{"message":"not enough permissions"}'),
    });
    const write = vi.fn();

    const err = await caught(guardedWrite(context, guard, write));

    expect(err.code).toBe("AUTO_REVERT_ARM_FAILED");
    expect(err.recoverability.suggestedAction).toMatch(/autoRevertSeconds=0/);
    expect(write).not.toHaveBeenCalled();
  });

  it("removes the job when the write is refused outright", async () => {
    const { client, context } = makeClient();
    const refused = new HttpError(400, '{"message":"invalid value"}');

    const err = await caught(guardedWrite(context, guard, () => Promise.reject(refused)));

    expect(err.code).not.toMatch(/AUTO_REVERT/);
    expect(client.remove).toHaveBeenCalledWith(SCHEDULER, "*S1");
    expect(client.probe).not.toHaveBeenCalled();
  });

  it("keeps the job armed when the write's outcome is unknown", async () => {
    const { client, context } = makeClient();
    const timeout = Object.assign(new Error("Headers Timeout Error"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    });

    const err = await caught(guardedWrite(context, guard, () => Promise.reject(timeout)));

    expect(err.details?.autoRevert).toMatchObject({ status: "armed" });
    expect(err.recoverability.suggestedAction).toMatch(/stays armed/);
    expect(client.remove).not.toHaveBeenCalled();
  });

  it("reports an expired job: it already ran and likely undid the change", async () => {
    const { context } = makeClient({ jobGone: true });

    const err = await caught(guardedWrite(context, guard, async () => "done"));

    expect(err.code).toBe("AUTO_REVERT_EXPIRED");
    expect(err.details?.autoRevert).toMatchObject({ status: "expired", healthCheck: "ok" });
  });

  it("reports a job it could not remove, which will still fire", async () => {
    const { client, context } = makeClient();
    client.remove.mockRejectedValueOnce(new HttpError(500, "{}"));

    const err = await caught(guardedWrite(context, guard, async () => "done"));

    expect(err.code).toBe("AUTO_REVERT_DISARM_FAILED");
    expect(err.details?.autoRevert).toMatchObject({ status: "disarm_failed" });
    expect(err.recoverability.alternativeTools).toContain("manage_scheduled_job");
  });

  it("retarget narrows the job's script once the write knows more", async () => {
    const { client, context } = makeClient();

    const { autoRevert } = await guardedWrite(
      context,
      { ...guard, revert: { kind: "remove-new", chain: "input", knownIds: [] } },
      async (retarget) => {
        await retarget({ kind: "remove-id", id: "*2A" });
        return "done";
      },
    );

    expect(client.update).toHaveBeenCalledWith(SCHEDULER, "*S1", {
      "on-event": expect.stringContaining("remove [find where .id=*2A]"),
    });
    expect(autoRevert.revert).toBe("remove-id");
  });
});

describe("manage_firewall_rule auto-revert", () => {
  const schema = manageFirewallRule.inputSchema;
  const base = { routerId: "r1", chain: "input", ruleAction: "drop" };

  it("defaults autoRevertSeconds to 60, accepts 0, and rejects values below 30", () => {
    expect(schema.parse({ ...base, action: "add" })).toMatchObject({ autoRevertSeconds: 60 });
    expect(schema.parse({ ...base, action: "add", autoRevertSeconds: 0 })).toMatchObject({
      autoRevertSeconds: 0,
    });
    expect(() => schema.parse({ ...base, action: "add", autoRevertSeconds: 10 })).toThrow();
    expect(() => schema.parse({ ...base, action: "add", autoRevertSeconds: 3601 })).toThrow();
  });

  it("add: arms a job for new rules in the chain, then narrows it to the created id", async () => {
    const { client, context } = makeClient({
      rules: [
        { ".id": "*1", chain: "input", action: "accept" },
        { ".id": "*3", chain: "forward", action: "accept" },
      ],
    });

    const result = await manageFirewallRule.handler(
      { ...base, action: "add", comment: "block-x" },
      context,
    );

    const [, job] = client.create.mock.calls.find((c) => c[0] === SCHEDULER)!;
    expect(job["on-event"]).toContain(':local known ",*1,"');
    expect(client.update).toHaveBeenCalledWith(SCHEDULER, "*S1", {
      "on-event": expect.stringContaining("remove [find where .id=*2A]"),
    });
    expect(result.structuredContent).toMatchObject({
      action: "created",
      autoRevert: { status: "disarmed", revert: "remove-id" },
    });
    expect(result.content).toMatch(/Auto-revert/);
  });

  it("remove: restores the rule before the next static rule", async () => {
    const { client, context } = makeClient({
      rules: [
        { ".id": "*D1", chain: "input", action: "accept", dynamic: "true" },
        { ".id": "*4", chain: "input", action: "accept", comment: "allow-mgmt" },
        { ".id": "*D2", chain: "input", action: "accept", dynamic: "true" },
        { ".id": "*6", chain: "input", action: "drop" },
      ],
    });
    const result = await manageFirewallRule.handler(
      { ...base, action: "remove", comment: "allow-mgmt" },
      context,
    );

    const [, job] = client.create.mock.calls.find((c) => c[0] === SCHEDULER)!;
    expect(job["on-event"]).toContain("place-before=*6");
    expect(job["on-event"]).toContain('comment="allow-mgmt"');
    expect(client.remove).toHaveBeenCalledWith("ip/firewall/filter", "*4");
    expect(result.structuredContent).toMatchObject({
      action: "removed",
      autoRevert: { status: "disarmed" },
    });
  });

  it("remove: restores the rule even when another rule shares its comment", async () => {
    const { client, context } = makeClient({
      rules: [
        { ".id": "*4", chain: "input", action: "accept", comment: "mgmt" },
        { ".id": "*5", chain: "input", action: "accept", comment: "mgmt" },
      ],
    });

    await manageFirewallRule.handler({ ...base, action: "remove", comment: "mgmt" }, context);

    const [, job] = client.create.mock.calls.find((c) => c[0] === SCHEDULER)!;
    expect(job["on-event"]).toContain('[:len [/ip firewall filter find where comment="mgmt"]] < 2');
    expect(job["on-event"]).toContain("place-before=*5");
  });

  it("disable: the job re-enables the rule", async () => {
    const { client, context } = makeClient({
      rules: [
        { ".id": "*4", chain: "input", action: "accept", comment: "allow-mgmt", disabled: "false" },
      ],
    });

    await manageFirewallRule.handler(
      { ...base, action: "disable", comment: "allow-mgmt" },
      context,
    );

    const [, job] = client.create.mock.calls.find((c) => c[0] === SCHEDULER)!;
    expect(job["on-event"]).toContain("set [find where .id=*4] disabled=no");
    expect(client.update).toHaveBeenCalledWith("ip/firewall/filter", "*4", { disabled: "true" });
  });

  it("surfaces a lockout as an error and leaves the job armed", async () => {
    vi.useFakeTimers();
    const { client, context } = makeClient({
      probe: () => Promise.reject(new Error("connect ETIMEDOUT")),
    });

    const pending = caught(manageFirewallRule.handler({ ...base, action: "add" }, context));
    await vi.runAllTimersAsync();
    const err = await pending;

    expect(err.code).toBe("AUTO_REVERT_PENDING");
    expect(client.create).toHaveBeenCalledWith("ip/firewall/filter", expect.anything());
    expect(client.remove).not.toHaveBeenCalled();
  });

  it("autoRevertSeconds=0 writes without touching the scheduler", async () => {
    const { client, context } = makeClient();

    const result = await manageFirewallRule.handler(
      { ...base, action: "add", autoRevertSeconds: 0 },
      context,
    );

    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.create).toHaveBeenCalledWith("ip/firewall/filter", expect.anything());
    expect(client.probe).not.toHaveBeenCalled();
    expect(result.structuredContent).not.toHaveProperty("autoRevert");
  });

  it("dry run reports the job it would arm and arms nothing", async () => {
    const { client, context } = makeClient();

    const result = await manageFirewallRule.handler(
      { ...base, action: "add", dryRun: true },
      context,
    );

    expect(result.structuredContent).toMatchObject({
      action: "dry_run",
      autoRevert: { wouldArm: true, seconds: 60 },
    });
    expect(client.create).not.toHaveBeenCalled();
  });

  it("an idempotent no-op arms nothing", async () => {
    const { client, context } = makeClient({
      rules: [
        { ".id": "*4", chain: "input", action: "accept", comment: "allow-mgmt", disabled: "true" },
      ],
    });

    const result = await manageFirewallRule.handler(
      { ...base, action: "disable", comment: "allow-mgmt" },
      context,
    );

    expect(result.structuredContent).toMatchObject({ action: "no_change" });
    expect(client.create).not.toHaveBeenCalled();
  });
});
