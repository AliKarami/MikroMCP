// ---------------------------------------------------------------------------
// MikroMCP - SwOS switch configuration as a document
//
// get_swos_config exports a switch as one YAML document; apply_swos_config
// plans a document against the switch and writes the changed endpoints in a
// fixed order (VLAN table first, system last). See src/domain/swos/switch-config.ts.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { stringify as toYaml } from "yaml";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import { createLogger } from "../../observability/logger.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { requireSwosClient } from "./swos-tools.js";
import {
  decodeEndpoint,
  dumpBlob,
  firmwareSupport,
  parseWireBlob,
} from "../../adapter/swos-protocol.js";
import type { SwosClient } from "../../adapter/swos-client.js";
import {
  CONFIG_ENDPOINTS,
  dialectOf,
  parseSwitchConfig,
  planSwitchConfig,
  portCountOf,
  type ConfigEndpoint,
  type ConfigPlan,
  type CurrentBlobs,
  type FieldChange,
  type SwitchConfig,
  redactConfigParam,
} from "../swos/switch-config.js";

const log = createLogger("swos-config-tools");

/** How long apply_swos_config waits before re-reading the switch after an unanswered write (tests set 0). */
export const swosApplyTiming = { confirmDelayMs: 1000 };

/**
 * After a write that got no answer: read the switch again and plan the same config once more. When the new
 * plan no longer writes `endpoint` in its apply phase, the switch took the write and only its answer was
 * lost - which happens when the write changes the VLAN of the port the request came in on. Any read
 * failure counts as "not confirmed".
 */
async function confirmedAfterTimeout(
  client: SwosClient,
  config: SwitchConfig,
  pruneVlans: boolean,
  endpoint: ConfigEndpoint,
): Promise<boolean> {
  try {
    if (swosApplyTiming.confirmDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, swosApplyTiming.confirmDelayMs));
    }
    const current: CurrentBlobs = {};
    for (const ep of endpointsToRead(config)) current[ep] = await client.readBlobForWrite(ep);
    const replan = planSwitchConfig(config, current, { pruneVlans });
    return !replan.writes.some((w) => w.endpoint === endpoint && w.phase === "apply");
  } catch {
    return false;
  }
}

const portsOf = (bits: unknown): number[] =>
  Array.isArray(bits) ? bits.flatMap((on, i) => (on ? [i + 1] : [])) : [];

async function readWire(client: SwosClient, endpoint: ConfigEndpoint): Promise<unknown> {
  return parseWireBlob(await client.getRaw(endpoint));
}

// ---------------------------------------------------------------------------
// get_swos_config
// ---------------------------------------------------------------------------

const getConfigSchema = z.object({ routerId }).strict();

type Decoded = Record<string, unknown>;

/** Build the config document a switch is currently running. */
export function exportSwitchConfig(current: Required<CurrentBlobs>): Record<string, unknown> {
  const sysWire = current["sys.b"] as Record<string, unknown>;
  const portCount = portCountOf(current["link.b"] as Record<string, unknown>);
  const dialect = dialectOf(sysWire);
  const decode = (ep: ConfigEndpoint) =>
    decodeEndpoint(ep, dumpBlob(current[ep]), portCount) as Decoded;

  const sys = decode("sys.b");
  const link = decode("link.b");
  const fwd = decode("fwd.b");
  const lacp = decode("lacp.b");
  const snmp = decode("snmp.b");

  const system: Decoded = {};
  const put = (target: Decoded, key: string, value: unknown) => {
    if (value !== undefined) target[key] = value;
  };
  put(system, "identity", sys.identity);
  put(system, "independent_vlan_lookup", sys.independent_vlan_lookup);
  put(system, "igmp_snooping", sys.igmp_snooping);
  put(system, "igmp_querier", sys.igmp_querier);
  put(system, "igmp_version", sys.igmp_version);
  if (sys.igmp_fast_leave !== undefined) system.igmp_fast_leave = portsOf(sys.igmp_fast_leave);
  if (sys.discovery_protocol !== undefined)
    system.mikrotik_discovery = portsOf(sys.discovery_protocol);
  if (sys.dhcp_trusted_ports !== undefined)
    system.dhcp_trusted_ports = portsOf(sys.dhcp_trusted_ports);
  put(system, "dhcp_add_information_option", sys.dhcp_info_option);
  put(system, "address_acquisition", sys.addr_acq);
  put(system, "static_ip", sys.static_ip);
  if (sys.allow_from_ip !== undefined)
    system.allow_from = `${String(sys.allow_from_ip)}/${String(sys.allow_from_mask ?? 0)}`;
  if (sys.allow_from_ports !== undefined) system.allow_from_ports = portsOf(sys.allow_from_ports);
  put(system, "allow_from_vlan", sys.allow_from_vlan);

  const at = (field: unknown, i: number) => (Array.isArray(field) ? field[i] : undefined);
  const ports: Record<string, Decoded> = {};
  for (let i = 0; i < portCount; i++) {
    const port: Decoded = {};
    put(port, "name", at(link.name, i));
    put(port, "enabled", at(link.enabled, i));
    put(port, "vlan_mode", at(fwd.vlan_mode, i));
    put(port, "vlan_receive", at(fwd.vlan_recv_mode, i));
    put(port, "default_vlan", at(fwd.default_vid, i));
    put(port, "force_vlan", at(fwd.force_vid, i));
    put(port, "auto_negotiation", at(link.auto_neg, i));
    const isolation = fwd[`isolation_p${i + 1}`];
    if (Array.isArray(isolation)) port.forward_to = portsOf(isolation);
    put(port, "limit_unknown_unicast", at(fwd.limit_unknown_ucast, i));
    put(port, "flood_unknown_multicast", at(fwd.flood_unknown_mcast, i));
    // SwOS Lite stores storm rate and LAG differently; the config only maps full SwOS.
    if (dialect === "swos") {
      put(port, "storm_rate", at(fwd.storm_rate, i));
      put(port, "lag_mode", at(lacp.mode, i));
      put(port, "lag_group", at(lacp.group, i));
    }
    // A forced speed and duplex only take effect with auto-negotiation off.
    if (at(link.auto_neg, i) === false) {
      put(port, "speed", at(link.manual_speed, i));
      put(port, "full_duplex", at(link.manual_duplex, i));
    }
    ports[String(i + 1)] = port;
  }

  const doc: Record<string, unknown> = { version: 1, system, ports };
  if (dialect === "swos") {
    const rows = decodeEndpoint("vlan.b", dumpBlob(current["vlan.b"]), portCount) as Decoded[];
    doc.vlans = rows.map((r) => ({
      id: r.vid,
      name: r.name,
      members: portsOf(r.members),
      igmp_snooping: r.igmp,
      port_isolation: r.port_isolation,
      learning: r.learning,
      mirror: r.mirror,
    }));
  }
  // The community is a credential: it is never exported. A document applied
  // back without it leaves the switch's community unchanged.
  const snmpDoc: Decoded = {};
  put(snmpDoc, "enabled", snmp.enabled);
  put(snmpDoc, "contact", snmp.contact);
  put(snmpDoc, "location", snmp.location);
  doc.snmp = snmpDoc;
  return doc;
}

const getSwosConfigTool: ToolDefinition = {
  name: "get_swos_config",
  title: "Get SwOS Config",
  description:
    "Export a SwOS switch's configuration as one YAML document: system settings (including management access), every port's name, enabled state and VLAN settings, the VLAN table (full SwOS) and SNMP. The SNMP community is never exported. The document is the input format of apply_swos_config, so it doubles as a backup you can read and diff.",
  inputSchema: getConfigSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  platform: "swos",
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    getConfigSchema.parse(params);
    const client = requireSwosClient(context);
    try {
      const current = {} as Required<CurrentBlobs>;
      for (const ep of CONFIG_ENDPOINTS) current[ep] = await readWire(client, ep);
      const doc = exportSwitchConfig(current);
      const yaml =
        `# SwOS switch config exported by MikroMCP from ${context.routerId}.\n` +
        "# The SNMP community is not exported; add it as ${SNMP_COMMUNITY} to set it.\n" +
        toYaml(doc);
      const sys = decodeEndpoint("sys.b", dumpBlob(current["sys.b"])) as Decoded;
      return {
        content: yaml,
        structuredContent: {
          routerId: context.routerId,
          config: doc,
          yaml,
          compatibility: firmwareSupport(sys.model, sys.version),
        },
      };
    } catch (err) {
      throw toolError(err, context, "get_swos_config");
    }
  },
};

// ---------------------------------------------------------------------------
// apply_swos_config
// ---------------------------------------------------------------------------

/** The per-port settings and VLAN table changes that cannot be ordered with a management VLAN move. */
const VLAN_PORT_SETTINGS = new Set([
  "vlan_mode",
  "vlan_receive",
  "default_vlan",
  "force_vlan",
  "forward_to",
]);
const VLAN_MEMBERSHIP = new Set(["add", "remove", "members"]);

const applyConfigSchema = z
  .object({
    routerId,
    config: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .describe(
        "The switch config: a YAML document (as text) or the same structure as an object. `version: 1`, then any of `system`, `ports`, `vlans`, `snmp`; only the settings it names are changed. `snmp.community` may be `${NAME}`, replaced by the server's MIKROMCP_SECRET_<NAME> value; no other field may reference a secret.",
      ),
    dryRun: z
      .boolean()
      .default(true)
      .describe("Plan and show every change without writing to the switch."),
    includeManagement: z
      .boolean()
      .default(false)
      .describe(
        "Allow changes to how the switch is reached: address acquisition, static IP and the allow-from settings. Refused unless this is true.",
      ),
    acceptLockoutRisk: z
      .boolean()
      .default(false)
      .describe(
        "Apply a plan whose warnings show a linked port being cut off (its VLAN, untagged traffic, link, isolation or LAG changing). Refused unless this is true; a dry run shows the warnings without it.",
      ),
    pruneVlans: z
      .boolean()
      .default(true)
      .describe(
        "When the config has a `vlans` list, remove VLANs the switch has but the list does not.",
      ),
  })
  .strict();

function describeChange(c: FieldChange): string {
  const where =
    c.port !== undefined ? ` port ${c.port}` : c.vlan !== undefined ? ` VLAN ${c.vlan}` : "";
  if (c.setting === "add") return `  add${where}: ${JSON.stringify(c.to)}`;
  if (c.setting === "remove") return `  remove${where}`;
  return `  ${c.setting}${where}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`;
}

function describePlan(plan: ConfigPlan): string {
  const lines: string[] = [];
  for (const ep of plan.endpoints) {
    if (ep.changes.length === 0) continue;
    lines.push(
      `${ep.endpoint} (${ep.changes.length} change(s)):`,
      ...ep.changes.map(describeChange),
    );
  }
  return lines.length > 0 ? lines.join("\n") : "No changes: the switch already matches the config.";
}

/** Endpoints a config needs read before it can be planned. */
function endpointsToRead(config: ReturnType<typeof parseSwitchConfig>): ConfigEndpoint[] {
  const needed = new Set<ConfigEndpoint>(["sys.b", "link.b"]);
  // vlan.b and fwd.b also feed the lockout check, so both are read whenever
  // the VLAN table or any port changes.
  if (config.vlans || config.ports) {
    needed.add("vlan.b");
    needed.add("fwd.b");
  }
  if (config.snmp) needed.add("snmp.b");
  if (
    config.ports &&
    Object.values(config.ports).some((p) => p.lag_mode !== undefined || p.lag_group !== undefined)
  ) {
    needed.add("lacp.b");
  }
  return CONFIG_ENDPOINTS.filter((ep) => needed.has(ep));
}

const applySwosConfigTool: ToolDefinition = {
  name: "apply_swos_config",
  title: "Apply SwOS Config",
  description:
    "Apply a switch config document (the format get_swos_config exports) to a SwOS switch. Plans every change against the switch first; dryRun defaults to true. Writes only the endpoints that change: the VLAN table grows first (new VLANs and members), then the per-port settings (VLAN, isolation, storm and flood control), port names/negotiation/enabled, LAG and SNMP, then the table shrinks (removed VLANs and members), then system — so no port loses its VLAN mid-apply. Refuses management changes (address, allow-from) unless includeManagement is true, and any plan that would cut a linked port off (its untagged VLAN moved or dropped, a trunk losing tagged VLANs or becoming an access port, a forced VLAN, a port that starts filtering VLANs, the port disabled, renegotiating, isolated from another linked port or moved in or out of a LAG, every linked port dropped from allow_from_ports; only risks the plan introduces) unless acceptLockoutRisk is true. All six endpoints are snapshotted before a real apply, so rollback_change restores the previous state; the result names any endpoint whose snapshot failed, and says so when none was recorded. A document that moves management to another VLAN (allow_from_vlan) and changes a port's VLAN settings or the VLAN table's membership at the same time is refused, because that cannot be written in a safe order (sys.b goes last and cuts the session): apply the VLAN changes first, then the move. `snmp.community` may reference only the secrets bound to the switch (its `secrets` list in routers.yaml); a switch without a list may reference none.",
  inputSchema: applyConfigSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  platform: "swos",
  snapshotPaths: (params) => (params.dryRun === false ? [...CONFIG_ENDPOINTS] : []),
  // The audit log and the journal see the config with a written-out community
  // redacted, in the text and the object form; a `${NAME}` reference stays.
  redactParams: (params) => ({ ...params, config: redactConfigParam(params.config) }),
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = applyConfigSchema.parse(params);
    const client = requireSwosClient(context);
    // A config given as text travels through the conversation as it is, so its
    // community must be a ${NAME} reference; an object may carry the value.
    const config = parseSwitchConfig(parsed.config, context.appConfig.configSecrets, {
      communityByReferenceOnly: typeof parsed.config === "string",
      // A switch references only the secrets bound to it; none without a list.
      allowedSecrets: context.routerConfig?.secrets ?? [],
      routerId: context.routerId,
    });

    let plan: ConfigPlan;
    let sys: Decoded;
    try {
      const current: CurrentBlobs = {};
      // Read with the round-trip guarantee: every endpoint we may write must
      // re-encode byte-for-byte before its mutated copy is POSTed.
      for (const ep of endpointsToRead(config)) current[ep] = await client.readBlobForWrite(ep);
      plan = planSwitchConfig(config, current, { pruneVlans: parsed.pruneVlans });
      sys = decodeEndpoint("sys.b", dumpBlob(current["sys.b"])) as Decoded;
    } catch (err) {
      throw toolError(err, context, "apply_swos_config");
    }

    // Moving management to another VLAN cannot be ordered with VLAN changes in
    // one apply: sys.b is written last and the session is cut when it takes
    // effect, so the VLAN work before it can never be checked from the new VLAN.
    const vlanMove = plan.management.find(
      (c) => c.setting === "allow_from_vlan" && typeof c.to === "number" && c.to > 0,
    );
    // Only the VLAN work is unorderable: a port's VLAN settings and the table's
    // membership. Names, storm and flood control, LAG or identity go with a move.
    const vlanWork = plan.endpoints.some((e) =>
      e.changes.some(
        (c) =>
          (c.endpoint === "fwd.b" && VLAN_PORT_SETTINGS.has(c.setting.replace(/^port \d+ /, ""))) ||
          (c.endpoint === "vlan.b" && VLAN_MEMBERSHIP.has(c.setting)),
      ),
    );
    const unordered = vlanMove && vlanWork;
    if (unordered && !parsed.dryRun) {
      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "SWOS_MANAGEMENT_MOVE_UNORDERED",
        message: `The config moves management to VLAN ${String(vlanMove.to)} and changes a port's VLAN settings or the VLAN table's membership in the same document; that cannot be written in a safe order (the system settings go last and cut the session). Nothing was written.`,
        details: { management: plan.management },
        recoverability: {
          retryable: false,
          suggestedAction:
            "Apply the VLAN changes first, check that the switch answers from the new VLAN, then move management (allow_from_vlan) in a second apply with includeManagement: true.",
        },
      });
    }

    if (plan.management.length > 0 && !parsed.includeManagement) {
      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "SWOS_MANAGEMENT_CHANGE_REFUSED",
        message: `The config changes how the switch is reached (${[
          ...new Set(plan.management.map((c) => c.setting)),
        ].join(", ")}); nothing was written.`,
        details: { management: plan.management },
        recoverability: {
          retryable: false,
          suggestedAction:
            "Review the new address and allow-from values, make sure this session can still reach the switch afterwards, then retry with includeManagement: true.",
        },
      });
    }

    if (plan.warnings.length > 0 && !parsed.dryRun && !parsed.acceptLockoutRisk) {
      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "SWOS_LOCKOUT_RISK",
        message: `The applied config would cut off port(s); nothing was written. ${plan.warnings.join(" ")}`,
        details: { warnings: plan.warnings },
        recoverability: {
          retryable: false,
          suggestedAction:
            "Fix the VLAN membership or default VLAN of the named ports. If the result is intended and this session does not depend on those ports, retry with acceptLockoutRisk: true.",
        },
      });
    }

    const compatibility = firmwareSupport(sys.model, sys.version);
    const banner = `${compatibility.verified ? "Firmware" : "⚠️  Firmware"}: ${compatibility.note}`;
    const planWarnings = unordered
      ? [
          ...plan.warnings,
          `Management moves to VLAN ${String(vlanMove.to)} in the same document that changes a port's VLAN settings or VLAN membership; a real apply refuses this, do the VLAN changes first and the move second.`,
        ]
      : plan.warnings;
    const warnings = planWarnings.map((w) => `⚠️  ${w}`).join("\n");
    const summary = describePlan(plan);
    const changes = plan.endpoints.map((e) => ({ endpoint: e.endpoint, changes: e.changes }));
    const toWrite = plan.writes;

    if (parsed.dryRun || toWrite.length === 0) {
      const action = toWrite.length === 0 ? "no_change" : "dry_run";
      return {
        content:
          (action === "dry_run" ? "DRY RUN — no write performed.\n" : "") +
          `${summary}\n${warnings ? `\n${warnings}\n` : ""}\n${banner}`,
        structuredContent: {
          routerId: context.routerId,
          action,
          dryRun: parsed.dryRun,
          portCount: plan.portCount,
          dialect: plan.dialect,
          endpoints: changes,
          management: plan.management,
          warnings: planWarnings,
          compatibility,
        },
      };
    }

    const written: string[] = [];
    for (const step of toWrite) {
      const label = step.phase === "apply" ? step.endpoint : `${step.endpoint} (${step.phase})`;
      try {
        await client.postRaw(step.endpoint, step.blob);
        written.push(label);
        log.info(
          { routerId: context.routerId, endpoint: step.endpoint, phase: step.phase },
          "SwOS config endpoint written",
        );
      } catch (err) {
        const enriched = toolError(err, context, "apply_swos_config");
        // A timed-out POST is ambiguous: SwOS may have applied it without answering. For a
        // per-endpoint step a fresh plan settles it; the VLAN table's grow and shrink steps write
        // an intermediate state a fresh plan cannot judge, so they stay ambiguous.
        const maybe = enriched.category === ErrorCategory.ROUTER_TIMEOUT;
        if (
          maybe &&
          step.phase === "apply" &&
          (await confirmedAfterTimeout(client, config, parsed.pruneVlans, step.endpoint))
        ) {
          written.push(`${label} (confirmed by read-back)`);
          log.warn(
            { routerId: context.routerId, endpoint: step.endpoint },
            "SwOS write got no answer, but the read-back shows it applied",
          );
          continue;
        }
        throw new MikroMCPError({
          category: enriched.category,
          code: "SWOS_APPLY_INCOMPLETE",
          message: `Writing ${label} failed after ${written.length} write(s) (${written.join(", ") || "none"})${maybe ? "; that write may still have been applied" : ""}: ${enriched.message}`,
          details: {
            written,
            failedAt: label,
            ...(maybe ? { possiblyWritten: label } : {}),
            cause: enriched.code,
          },
          recoverability: {
            retryable: false,
            suggestedAction:
              "Check the switch with get_swos_config. Undo with rollback_change and this call's journal ID, or re-apply the config once the switch answers again.",
          },
        });
      }
    }

    // What was snapshotted before this write (the executor, bulk_execute and
    // apply_plan record it). A context that records nothing is "none", not
    // "all six".
    const snapshots = context.snapshots ?? { taken: [], failed: [] };
    const missing = CONFIG_ENDPOINTS.filter((ep) => !snapshots.taken.includes(ep));
    const snapshotted: "all" | "partial" | "none" =
      missing.length === 0 ? "all" : snapshots.taken.length === 0 ? "none" : "partial";
    const snapshotNote =
      snapshotted === "all"
        ? "The previous state of all six endpoints was snapshotted — undo with rollback_change using this call's journal ID."
        : snapshotted === "none"
          ? snapshots.failed.length > 0
            ? "No endpoint could be snapshotted before the write, so rollback_change cannot restore the previous state; keep the switch's last save_swos_backup file at hand."
            : "No snapshot was recorded for this write, so rollback_change may not be able to restore the previous state; keep the switch's last save_swos_backup file at hand."
          : `The previous state of ${snapshots.taken.join(", ")} was snapshotted, but not ${missing.join(", ")}: rollback_change restores only the former.`;
    return {
      content:
        `Applied the config to ${context.routerId} (${written.join(", ")}):\n${summary}\n` +
        `${warnings ? `\n${warnings}\n` : ""}\n${banner}\n` +
        snapshotNote,
      structuredContent: {
        routerId: context.routerId,
        action: "applied",
        dryRun: false,
        written,
        snapshots,
        snapshotted,
        endpoints: changes,
        management: plan.management,
        warnings: plan.warnings,
        compatibility,
      },
    };
  },
};

export const swosConfigTools: ToolDefinition[] = [getSwosConfigTool, applySwosConfigTool];
