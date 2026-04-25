import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";
import { SshClient } from "../../adapter/ssh-client.js";
import { resolveCommandPolicy, checkCommand } from "./command-guard.js";

const log = createLogger("system-ops-tools");

// ---------------------------------------------------------------------------
// get_system_clock
// ---------------------------------------------------------------------------

const getSystemClockInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
}).strict();

const getSystemClockTool: ToolDefinition = {
  name: "get_system_clock",
  title: "Get System Clock",
  description:
    "Read the current date, time, and timezone from a MikroTik router. Focused single-purpose alternative to the clock section in get_system_status.",
  inputSchema: getSystemClockInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = getSystemClockInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Getting system clock");

    try {
      const results = await context.routerClient.get<Record<string, string>>("system/clock");
      const clock = (Array.isArray(results) && results.length > 0 ? results[0] : results) as Record<string, string>;

      return {
        content: `Clock on ${parsed.routerId}: ${clock.date} ${clock.time} (${clock["time-zone-name"] ?? "?"})`,
        structuredContent: {
          routerId: context.routerId,
          date: clock.date ?? null,
          time: clock.time ?? null,
          timeZoneName: clock["time-zone-name"] ?? null,
          timeZoneAutodetect: clock["time-zone-autodetect"] ?? null,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "get_system_clock" });
    }
  },
};

// ---------------------------------------------------------------------------
// set_system_clock
// ---------------------------------------------------------------------------

const setSystemClockInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  date: z.string().optional().describe("Date in RouterOS format: mon/dd/yyyy (e.g. jan/02/2006)"),
  time: z.string().optional().describe("Time in RouterOS format: hh:mm:ss (e.g. 15:04:05)"),
  timeZoneName: z.string().optional().describe("IANA timezone name (e.g. Europe/London, UTC)"),
  dryRun: z.boolean().default(false).describe("Preview changes without applying"),
}).strict();

const setSystemClockTool: ToolDefinition = {
  name: "set_system_clock",
  title: "Set System Clock",
  description:
    "Set the system date, time, and/or timezone on a MikroTik router. Idempotent: returns already_set if the values already match. Supports dry-run.",
  inputSchema: setSystemClockInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = setSystemClockInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Setting system clock");

    try {
      const results = await context.routerClient.get<Record<string, string>>("system/clock");
      const current = (Array.isArray(results) && results.length > 0 ? results[0] : results) as Record<string, string>;
      const id = current[".id"];

      const changes: Record<string, string> = {};
      const diff: Array<{ property: string; before: string | null; after: string }> = [];

      if (parsed.date !== undefined && current.date !== parsed.date) {
        changes.date = parsed.date;
        diff.push({ property: "date", before: current.date ?? null, after: parsed.date });
      }
      if (parsed.time !== undefined && current.time !== parsed.time) {
        changes.time = parsed.time;
        diff.push({ property: "time", before: current.time ?? null, after: parsed.time });
      }
      if (parsed.timeZoneName !== undefined && current["time-zone-name"] !== parsed.timeZoneName) {
        changes["time-zone-name"] = parsed.timeZoneName;
        diff.push({ property: "time-zone-name", before: current["time-zone-name"] ?? null, after: parsed.timeZoneName });
      }

      if (diff.length === 0) {
        return {
          content: `System clock on ${context.routerId} already has the requested configuration. No changes made.`,
          structuredContent: { action: "already_set", routerId: context.routerId },
        };
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would update clock on ${context.routerId}: ${diff.map((d) => `${d.property}: ${d.before} → ${d.after}`).join(", ")}.`,
          structuredContent: { action: "dry_run", diff },
        };
      }

      await context.routerClient.update("system/clock", id, changes);
      log.info({ routerId: context.routerId, changes }, "System clock updated");

      return {
        content: `Updated clock on ${context.routerId}: ${diff.map((d) => `${d.property}: ${d.before} → ${d.after}`).join(", ")}.`,
        structuredContent: { action: "updated", routerId: context.routerId, diff },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "set_system_clock" });
    }
  },
};

// ---------------------------------------------------------------------------
// reboot
// ---------------------------------------------------------------------------

const rebootInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  delay: z.number().int().min(0).max(3600).default(0).describe("Seconds before rebooting (0–3600)"),
  dryRun: z.boolean().default(false).describe("Preview the reboot without executing"),
}).strict();

const rebootTool: ToolDefinition = {
  name: "reboot",
  title: "Reboot",
  description:
    "Trigger a controlled router reboot with an optional delay. Supports dry-run. Use this tool instead of run_command for reboots — run_command's deny list blocks /system reboot*.",
  inputSchema: rebootInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = rebootInputSchema.parse(params);
    log.info({ routerId: context.routerId, delay: parsed.delay }, "Rebooting router");

    try {
      if (parsed.dryRun) {
        const msg = parsed.delay > 0
          ? `Dry run: Would reboot ${context.routerId} in ${parsed.delay} seconds.`
          : `Dry run: Would reboot ${context.routerId} immediately.`;
        return {
          content: msg,
          structuredContent: { action: "dry_run", delay: parsed.delay, routerId: context.routerId },
        };
      }

      await context.routerClient.execute("system/reboot", { delay: String(parsed.delay) });
      log.info({ routerId: context.routerId, delay: parsed.delay }, "Reboot triggered");

      const msg = parsed.delay > 0
        ? `Reboot of ${context.routerId} scheduled in ${parsed.delay} seconds.`
        : `Reboot of ${context.routerId} triggered.`;

      return {
        content: msg,
        structuredContent: { action: "rebooting", delay: parsed.delay, routerId: context.routerId },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "reboot" });
    }
  },
};

// ---------------------------------------------------------------------------
// run_command
// ---------------------------------------------------------------------------

const OUTPUT_MAX_CHARS = 4_000;

const runCommandInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  command: z.string().min(1).describe("RouterOS console command to execute"),
  dryRun: z.boolean().default(false).describe("Preview the command without executing (validates allow/deny policy only)"),
}).strict();

const runCommandTool: ToolDefinition = {
  name: "run_command",
  title: "Run Command",
  description:
    "Execute an arbitrary RouterOS console command via SSH. Protected by a configurable allow/deny policy — built-in deny list blocks destructive commands; use dedicated tools (reboot, etc.) for controlled operations. Output capped at 4000 characters.",
  inputSchema: runCommandInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = runCommandInputSchema.parse(params);
    log.info({ routerId: context.routerId, command: parsed.command }, "Running command");

    const globalAllow = (process.env.MIKROMCP_CMD_ALLOW ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const globalDeny = (process.env.MIKROMCP_CMD_DENY ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);

    const policy = resolveCommandPolicy(context.routerConfig, globalAllow, globalDeny);
    checkCommand(parsed.command, policy);

    if (parsed.dryRun) {
      return {
        content: `Dry run: Would execute command on ${context.routerId}: ${parsed.command}`,
        structuredContent: { action: "dry_run", command: parsed.command, routerId: context.routerId },
      };
    }

    try {
      const ssh = new SshClient(context.routerConfig, context.credentials);
      let output = await ssh.execute(parsed.command);

      let truncated = false;
      if (output.length > OUTPUT_MAX_CHARS) {
        output = output.slice(0, OUTPUT_MAX_CHARS);
        truncated = true;
      }

      const content = truncated
        ? `Output from ${context.routerId} (truncated at ${OUTPUT_MAX_CHARS} chars):\n${output}`
        : `Output from ${context.routerId}:\n${output}`;

      return {
        content,
        structuredContent: { action: "executed", command: parsed.command, routerId: context.routerId, output, truncated },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "run_command" });
    }
  },
};

export const systemOpsTools: ToolDefinition[] = [
  getSystemClockTool,
  setSystemClockTool,
  rebootTool,
  runCommandTool,
];
