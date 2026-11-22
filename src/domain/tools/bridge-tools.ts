import { z } from "zod";
import { isTrue, sameValue } from "../../adapter/response-parser.js";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, limit, offset, routerId } from "./schema-fields.js";
import { assertNewInterfaceName } from "./interface-name.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";
import { paginate, listContent, compactFields } from "./pagination.js";

const log = createLogger("bridge-tools");

const listBridgesInputSchema = z
  .object({
    routerId,
    limit,
    offset,
  })
  .strict();

const listBridgesTool: ToolDefinition = {
  name: "list_bridges",
  title: "List Bridges",
  description: "List bridge interfaces and their port members on a MikroTik router.",
  inputSchema: listBridgesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listBridgesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing bridges");
    try {
      const [bridges, ports] = await Promise.all([
        context.routerClient.get<RouterOSRecord>("interface/bridge"),
        context.routerClient.get<RouterOSRecord>("interface/bridge/port"),
      ]);

      const portsByBridge: Record<string, RouterOSRecord[]> = {};
      for (const port of ports) {
        const rec = port as Record<string, string>;
        const bridgeName = rec.bridge ?? "";
        if (!portsByBridge[bridgeName]) portsByBridge[bridgeName] = [];
        portsByBridge[bridgeName].push(port);
      }

      const enriched = bridges.map((b) => {
        const rec = b as Record<string, string>;
        return { ...rec, ports: portsByBridge[rec.name] ?? [] };
      });

      const { items: paginated, total, hasMore } = paginate(enriched, parsed.offset, parsed.limit);

      return {
        content: listContent("Bridges", context.routerId, paginated, total, parsed.offset, (b) =>
          compactFields(b, [
            "name",
            "protocol-mode",
            "vlan-filtering",
            "mtu",
            "disabled",
            "comment",
          ]),
        ),
        structuredContent: {
          routerId: context.routerId,
          bridges: paginated,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_bridges");
    }
  },
};

const listBridgePortsInputSchema = z
  .object({
    routerId,
    bridge: z.string().optional().describe("Only ports of this bridge"),
    interface: z.string().optional().describe("Only the port entry for this interface"),
    limit,
    offset,
  })
  .strict();

const listBridgePortsTool: ToolDefinition = {
  name: "list_bridge_ports",
  title: "List Bridge Ports",
  description:
    "List bridge port entries (interface membership, PVID, STP role and status) on a MikroTik router. Supports filtering by bridge and interface, with pagination.",
  inputSchema: listBridgePortsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listBridgePortsInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, bridge: parsed.bridge, interface: parsed.interface },
      "Listing bridge ports",
    );
    try {
      const filter: Record<string, string> = {};
      if (parsed.bridge !== undefined) filter.bridge = parsed.bridge;
      if (parsed.interface !== undefined) filter.interface = parsed.interface;

      const ports = await context.routerClient.get<RouterOSRecord>(
        "interface/bridge/port",
        Object.keys(filter).length > 0 ? { filter } : {},
      );

      // debug-info is a multi-line STP state dump (~1.5 KB per port) with no
      // configuration value; drop it to keep the response small.
      const trimmed = ports.map((p) => {
        const { "debug-info": _debug, ...rest } = p as Record<string, unknown>;
        return rest as RouterOSRecord;
      });

      const { items: paginated, total, hasMore } = paginate(trimmed, parsed.offset, parsed.limit);

      return {
        content: listContent(
          "Bridge ports",
          context.routerId,
          paginated,
          total,
          parsed.offset,
          (p) =>
            compactFields(p, [
              "interface",
              "bridge",
              "pvid",
              "frame-types",
              "status",
              "role",
              "hw",
              "disabled",
              "comment",
            ]),
        ),
        structuredContent: {
          routerId: context.routerId,
          ports: paginated,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_bridge_ports");
    }
  },
};

const VLAN_ID_MIN = 1;
const VLAN_ID_MAX = 4094;

const FRAME_TYPES = [
  "admit-all",
  "admit-only-untagged-and-priority-tagged",
  "admit-only-vlan-tagged",
] as const;

interface DiffEntry {
  property: string;
  before: string | null;
  after: string | null;
}

function sanitizeComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  return comment.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Expand a vlan-ids value (10, "10", "10,20", "100-110") into sorted, unique ids.
 * Returns null when any part is malformed or out of 1-4094.
 */
function parseVlanIds(value: unknown): number[] | null {
  const text = String(value ?? "").replace(/\s+/g, "");
  if (text === "") return null;
  const ids = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(part);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (lo < VLAN_ID_MIN || hi > VLAN_ID_MAX || lo > hi) return null;
    for (let id = lo; id <= hi; id++) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

/** Collapse sorted ids into RouterOS's form, runs as ranges: [10, 20, 100..110] → "10,20,100-110". */
function formatVlanIds(ids: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < ids.length) {
    let j = i;
    while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j++;
    parts.push(j === i ? String(ids[i]) : `${ids[i]}-${ids[j]}`);
    i = j + 1;
  }
  return parts.join(",");
}

function sameIds(a: number[] | null, b: number[]): boolean {
  return a !== null && a.length === b.length && a.every((id, i) => id === b[i]);
}

/** A comma-separated interface list as RouterOS stores it, as a sorted unique set. */
function memberSet(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const names = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return [...new Set(names)].sort();
}

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

function withWarnings(text: string, warnings: string[]): string {
  return warnings.length === 0 ? text : `${text}\n${warnings.map((w) => `⚠️  ${w}`).join("\n")}`;
}

function bridgeNotFound(bridge: string): MikroMCPError {
  return new MikroMCPError({
    category: ErrorCategory.NOT_FOUND,
    code: "BRIDGE_NOT_FOUND",
    message: `Bridge "${bridge}" not found.`,
    details: { name: bridge },
    recoverability: {
      retryable: false,
      suggestedAction: "Verify the bridge name with list_bridges.",
      alternativeTools: ["list_bridges"],
    },
  });
}

function vlanFilteringOffWarning(bridge: string): string {
  return `Bridge "${bridge}" has vlan-filtering off, so this setting has no effect until it is enabled (manage_bridge action update, vlanFiltering: true). Enable it last, after the VLAN table and port PVIDs are in place.`;
}

const manageBridgeInputSchema = z
  .object({
    routerId,
    action: z.enum(["create", "update", "remove"]).describe("Action to perform"),
    name: z
      .string()
      .min(1)
      .describe(
        "Bridge interface name, taken verbatim for update/remove; create accepts letters, digits, dot, hyphen, underscore, up to 64 chars",
      ),
    vlanFiltering: z
      .boolean()
      .optional()
      .describe(
        "Turn bridge VLAN filtering on or off (create/update). Enabling it on a bridge that carries the management address can lock you out; see the tool description.",
      ),
    comment: z.string().max(255).optional().describe("Optional comment (create/update)"),
    disabled: z
      .boolean()
      .optional()
      .describe(
        "Whether the bridge is disabled (create: defaults to false; update: unchanged when omitted)",
      ),
    dryRun,
  })
  .strict();

type BridgeClient = ToolContext["routerClient"];

/**
 * What enabling vlan-filtering on a bridge will cut off, from its current VLAN table,
 * VLAN interfaces, ports and addresses. Always leads with the generic lock-out warning.
 */
async function enableVlanFilteringWarnings(
  client: BridgeClient,
  bridge: Record<string, unknown>,
): Promise<string[]> {
  const name = String(bridge.name);
  const warnings = [
    `Enabling vlan-filtering on "${name}" is the classic management lock-out: traffic to the router's own address on this bridge stops unless "${name}" itself is a tagged member of the management VLAN (for a VLAN interface on the bridge) or the management VLAN is untagged with a PVID that matches the bridge's. Confirm the management path before applying, and keep another way in (a port outside the bridge, or MAC/serial console).`,
  ];
  try {
    const [vlanInterfaces, entries, ports, addresses] = await Promise.all([
      client.get<RouterOSRecord>("interface/vlan", { filter: { interface: name } }),
      client.get<RouterOSRecord>("interface/bridge/vlan", { filter: { bridge: name } }),
      client.get<RouterOSRecord>("interface/bridge/port", { filter: { bridge: name } }),
      client.get<RouterOSRecord>("ip/address", { filter: { interface: name } }),
    ]);
    const staticEntries = (entries as Record<string, unknown>[]).filter(
      (e) => !isTrue(e.dynamic) && !isTrue(e.disabled),
    );
    if (staticEntries.length === 0) {
      warnings.push(
        `"${name}" has no static bridge VLAN entries: with filtering on, only untagged traffic in each port's PVID VLAN passes. Add entries with manage_bridge_vlan first.`,
      );
    }
    for (const v of vlanInterfaces as Record<string, unknown>[]) {
      const id = Number(v["vlan-id"]);
      const covered = staticEntries.some(
        (e) => parseVlanIds(e["vlan-ids"])?.includes(id) && memberSet(e.tagged).includes(name),
      );
      if (!covered) {
        warnings.push(
          `VLAN interface "${String(v.name)}" (VLAN ${id}) sits on "${name}", but no bridge VLAN entry lists "${name}" as tagged for VLAN ${id}: its traffic, and any address on it, stops once filtering is on. Add it with manage_bridge_vlan (tagged includes "${name}").`,
        );
      }
    }
    if (addresses.length > 0) {
      const bridgePvid = bridge.pvid ?? 1;
      const mismatched = (ports as Record<string, unknown>[])
        .filter((p) => !isTrue(p.disabled) && !sameValue(p.pvid ?? 1, bridgePvid))
        .map((p) => `${String(p.interface)} (PVID ${String(p.pvid)})`);
      if (mismatched.length > 0) {
        const list = (addresses as Record<string, unknown>[])
          .map((a) => String(a.address))
          .join(", ");
        warnings.push(
          `"${name}" holds ${list}; untagged traffic reaches it only from ports whose PVID matches the bridge PVID (${String(bridgePvid)}). Ports with another PVID: ${mismatched.join(", ")}. Managing the router through one of them stops.`,
        );
      }
    }
  } catch (err) {
    log.warn({ err, bridge: name }, "Could not inspect the bridge VLAN setup");
    warnings.push(
      `Could not read the VLAN table, ports and addresses of "${name}" to check the management path; verify them with list_bridge_vlans and list_bridge_ports before applying.`,
    );
  }
  return warnings;
}

const manageBridgeTool: ToolDefinition = {
  name: "manage_bridge",
  title: "Manage Bridge Interface",
  description:
    "Create, update, or remove a bridge interface on a MikroTik router. Idempotent: create returns already_exists if a bridge with the same name (and the requested vlanFiltering) exists, update returns no_change when nothing differs. update sets vlanFiltering, comment, disabled. " +
    "Enabling vlanFiltering is the classic lock-out: before turning it on, verify the management VLAN, that the bridge itself is listed as tagged in list_bridge_vlans for every VLAN interface on the bridge, and that port PVIDs (list_bridge_ports) put the management port in the VLAN that reaches the router's address. Configure the VLAN table (manage_bridge_vlan) and PVIDs (manage_bridge_port) first and enable filtering last; dry-run first and read the warnings.",
  inputSchema: manageBridgeInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["interface/bridge"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageBridgeInputSchema.parse(params);
    const comment = sanitizeComment(parsed.comment);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing bridge",
    );
    try {
      const existing = await context.routerClient.get<RouterOSRecord>("interface/bridge", {
        filter: { name: parsed.name },
      });

      if (parsed.action === "create") {
        assertNewInterfaceName(parsed.name, {
          kind: "Bridge",
          action: "create",
          code: "BRIDGE_NAME_INVALID",
        });
        const disabled = parsed.disabled ?? false;
        if (existing.length > 0) {
          const rec = existing[0] as Record<string, unknown>;
          if (
            parsed.vlanFiltering !== undefined &&
            isTrue(rec["vlan-filtering"]) !== parsed.vlanFiltering
          ) {
            throw new MikroMCPError({
              category: ErrorCategory.CONFLICT,
              code: "BRIDGE_CONFLICT",
              message: `Bridge "${parsed.name}" already exists with vlan-filtering=${isTrue(rec["vlan-filtering"])}.`,
              details: {
                existing: { "vlan-filtering": isTrue(rec["vlan-filtering"]) },
                requested: { "vlan-filtering": parsed.vlanFiltering },
              },
              recoverability: {
                retryable: false,
                suggestedAction:
                  "Use action update to change vlan-filtering on the existing bridge.",
                alternativeTools: ["manage_bridge"],
              },
            });
          }
          return {
            content: `Bridge "${parsed.name}" already exists. No changes made.`,
            structuredContent: { action: "already_exists", bridge: existing[0] },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would create bridge "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              diff: [
                { property: "name", before: null, after: parsed.name },
                { property: "disabled", before: null, after: disabled ? "true" : "false" },
                ...(parsed.vlanFiltering !== undefined
                  ? [
                      {
                        property: "vlan-filtering",
                        before: null,
                        after: parsed.vlanFiltering ? "true" : "false",
                      },
                    ]
                  : []),
              ],
            },
          };
        }
        const body: Record<string, string> = {
          name: parsed.name,
          disabled: disabled ? "true" : "false",
        };
        if (parsed.vlanFiltering !== undefined) {
          body["vlan-filtering"] = parsed.vlanFiltering ? "true" : "false";
        }
        if (comment) body.comment = comment;
        const created = await context.routerClient.create("interface/bridge", body);
        log.info({ name: parsed.name, id: created[".id"] }, "Bridge created");
        return {
          content: `Created bridge "${parsed.name}".`,
          structuredContent: { action: "created", bridge: created },
        };
      }

      if (existing.length === 0) throw bridgeNotFound(parsed.name);
      const rec = existing[0] as Record<string, unknown>;
      const id = String(rec[".id"]);

      if (parsed.action === "update") {
        const updates: Record<string, string> = {};
        const diff: DiffEntry[] = [];
        const enabling = parsed.vlanFiltering === true && !isTrue(rec["vlan-filtering"]);
        if (
          parsed.vlanFiltering !== undefined &&
          isTrue(rec["vlan-filtering"]) !== parsed.vlanFiltering
        ) {
          updates["vlan-filtering"] = parsed.vlanFiltering ? "true" : "false";
          diff.push({
            property: "vlan-filtering",
            before: String(isTrue(rec["vlan-filtering"])),
            after: updates["vlan-filtering"],
          });
        }
        if (comment !== undefined && !sameValue(rec.comment ?? "", comment)) {
          updates.comment = comment;
          diff.push({
            property: "comment",
            before: rec.comment === undefined ? null : String(rec.comment),
            after: comment,
          });
        }
        if (parsed.disabled !== undefined && isTrue(rec.disabled) !== parsed.disabled) {
          updates.disabled = parsed.disabled ? "true" : "false";
          diff.push({
            property: "disabled",
            before: String(isTrue(rec.disabled)),
            after: updates.disabled,
          });
        }

        if (diff.length === 0) {
          return {
            content: `Bridge "${parsed.name}" already matches the requested settings. No changes made.`,
            structuredContent: { action: "no_change", bridge: rec, warnings: [] },
          };
        }

        const warnings = enabling
          ? await enableVlanFilteringWarnings(context.routerClient, rec)
          : [];

        if (parsed.dryRun) {
          return {
            content: withWarnings(`Dry run: Would update bridge "${parsed.name}".`, warnings),
            structuredContent: { action: "dry_run", diff, warnings },
          };
        }
        await context.routerClient.update("interface/bridge", id, updates);
        log.info({ name: parsed.name, changed: Object.keys(updates) }, "Bridge updated");
        return {
          content: withWarnings(`Updated bridge "${parsed.name}".`, warnings),
          structuredContent: { action: "updated", name: parsed.name, id, diff, warnings },
        };
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove bridge "${parsed.name}".`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "name", before: parsed.name, after: null }],
          },
        };
      }
      await context.routerClient.remove("interface/bridge", id);
      log.info({ name: parsed.name }, "Bridge removed");
      return {
        content: `Removed bridge "${parsed.name}".`,
        structuredContent: { action: "removed", name: parsed.name, id },
      };
    } catch (err) {
      throw toolError(err, context, "manage_bridge");
    }
  },
};

const manageBridgePortInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "update", "remove"]).describe("Action to perform"),
    bridge: z.string().describe("Bridge interface name"),
    interface: z.string().describe("Interface to add, update or remove as a bridge port"),
    pvid: z
      .number()
      .int()
      .min(VLAN_ID_MIN)
      .max(VLAN_ID_MAX)
      .optional()
      .describe("Port VLAN ID for untagged ingress traffic, 1-4094 (add/update)"),
    frameTypes: z
      .enum(FRAME_TYPES)
      .optional()
      .describe("Which frames the port admits on ingress (add/update)"),
    ingressFiltering: z
      .boolean()
      .optional()
      .describe("Drop ingress frames for VLANs the port is not a member of (add/update)"),
    dryRun,
  })
  .strict();

type BridgePortParams = z.infer<typeof manageBridgePortInputSchema>;

/** Port settings the call asks for that differ from the record; an absent record differs in all. */
function portSettingsDiff(
  parsed: BridgePortParams,
  rec: Record<string, unknown> | undefined,
): { updates: Record<string, string>; diff: DiffEntry[] } {
  const updates: Record<string, string> = {};
  const diff: DiffEntry[] = [];
  if (parsed.pvid !== undefined && !(rec && sameValue(rec.pvid, parsed.pvid))) {
    updates.pvid = String(parsed.pvid);
    diff.push({
      property: "pvid",
      before: rec?.pvid === undefined ? null : String(rec.pvid),
      after: updates.pvid,
    });
  }
  if (
    parsed.frameTypes !== undefined &&
    !(rec && sameValue(rec["frame-types"], parsed.frameTypes))
  ) {
    updates["frame-types"] = parsed.frameTypes;
    diff.push({
      property: "frame-types",
      before: rec?.["frame-types"] === undefined ? null : String(rec["frame-types"]),
      after: parsed.frameTypes,
    });
  }
  if (
    parsed.ingressFiltering !== undefined &&
    !(rec && isTrue(rec["ingress-filtering"]) === parsed.ingressFiltering)
  ) {
    updates["ingress-filtering"] = parsed.ingressFiltering ? "true" : "false";
    diff.push({
      property: "ingress-filtering",
      before:
        rec?.["ingress-filtering"] === undefined ? null : String(isTrue(rec["ingress-filtering"])),
      after: updates["ingress-filtering"],
    });
  }
  return { updates, diff };
}

async function portVlanWarnings(
  client: BridgeClient,
  bridge: string,
  diff: DiffEntry[],
): Promise<string[]> {
  if (diff.length === 0) return [];
  const bridges = await client.get<RouterOSRecord>("interface/bridge", {
    filter: { name: bridge },
  });
  if (bridges.length === 0) throw bridgeNotFound(bridge);
  if (!isTrue((bridges[0] as Record<string, unknown>)["vlan-filtering"])) {
    return [vlanFilteringOffWarning(bridge)];
  }
  if (diff.some((d) => d.property === "pvid" || d.property === "frame-types")) {
    return [
      `Bridge "${bridge}" filters VLANs: changing the PVID or frame types of the port you manage the router through can cut this session. Make sure the new PVID's VLAN still reaches the router's address.`,
    ];
  }
  return [];
}

const manageBridgePortTool: ToolDefinition = {
  name: "manage_bridge_port",
  title: "Manage Bridge Port",
  description:
    "Add, update, or remove an interface as a bridge port on a MikroTik router, and set its VLAN-filtering port settings (pvid, frameTypes, ingressFiltering) on add or update. Idempotent: add returns already_exists if the port exists with the requested settings (CONFLICT if they differ; use update), update returns no_change when nothing differs and NOT_FOUND when the interface is not a port of that bridge. Results warn when the bridge has vlan-filtering off (the settings have no effect yet) or on (a PVID change on the management port can cut the session).",
  inputSchema: manageBridgePortInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["interface/bridge/port"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageBridgePortInputSchema.parse(params);
    log.info(
      {
        routerId: context.routerId,
        action: parsed.action,
        bridge: parsed.bridge,
        interface: parsed.interface,
      },
      "Managing bridge port",
    );
    try {
      const existing = await context.routerClient.get<RouterOSRecord>("interface/bridge/port", {
        filter: { bridge: parsed.bridge, interface: parsed.interface },
      });
      const rec = existing[0] as Record<string, unknown> | undefined;

      if (parsed.action === "add") {
        if (rec) {
          const { diff } = portSettingsDiff(parsed, rec);
          if (diff.length > 0) {
            throw new MikroMCPError({
              category: ErrorCategory.CONFLICT,
              code: "BRIDGE_PORT_CONFLICT",
              message: `Interface "${parsed.interface}" is already a port on bridge "${parsed.bridge}" with different settings (${diff.map((d) => `${d.property}=${d.before}`).join(", ")}).`,
              details: { bridge: parsed.bridge, interface: parsed.interface, diff },
              recoverability: {
                retryable: false,
                suggestedAction: "Use action update to change the port settings.",
                alternativeTools: ["manage_bridge_port"],
              },
            });
          }
          return {
            content: `Interface "${parsed.interface}" is already a port on bridge "${parsed.bridge}". No changes made.`,
            structuredContent: { action: "already_exists", port: rec },
          };
        }
        const { updates: settings, diff: settingsDiff } = portSettingsDiff(parsed, undefined);
        const warnings = await portVlanWarnings(context.routerClient, parsed.bridge, settingsDiff);
        if (parsed.dryRun) {
          return {
            content: withWarnings(
              `Dry run: Would add "${parsed.interface}" to bridge "${parsed.bridge}".`,
              warnings,
            ),
            structuredContent: {
              action: "dry_run",
              diff: [
                { property: "bridge", before: null, after: parsed.bridge },
                { property: "interface", before: null, after: parsed.interface },
                ...settingsDiff,
              ],
              ...(warnings.length > 0 ? { warnings } : {}),
            },
          };
        }
        const created = await context.routerClient.create("interface/bridge/port", {
          bridge: parsed.bridge,
          interface: parsed.interface,
          ...settings,
        });
        log.info({ bridge: parsed.bridge, interface: parsed.interface }, "Bridge port added");
        return {
          content: withWarnings(
            `Added "${parsed.interface}" to bridge "${parsed.bridge}".`,
            warnings,
          ),
          structuredContent: {
            action: "created",
            port: created,
            ...(warnings.length > 0 ? { warnings } : {}),
          },
        };
      }

      if (!rec) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "BRIDGE_PORT_NOT_FOUND",
          message: `Interface "${parsed.interface}" is not a port on bridge "${parsed.bridge}".`,
          details: { bridge: parsed.bridge, interface: parsed.interface },
          recoverability: {
            retryable: false,
            suggestedAction:
              "Verify the interface is a member of the bridge with list_bridge_ports.",
            alternativeTools: ["list_bridge_ports"],
          },
        });
      }
      const id = String(rec[".id"]);

      if (parsed.action === "update") {
        if (
          parsed.pvid === undefined &&
          parsed.frameTypes === undefined &&
          parsed.ingressFiltering === undefined
        ) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "BRIDGE_PORT_NOTHING_TO_UPDATE",
            message: "update needs at least one of pvid, frameTypes, ingressFiltering.",
            details: { bridge: parsed.bridge, interface: parsed.interface },
            recoverability: {
              retryable: false,
              suggestedAction: "Pass the port settings to change.",
            },
          });
        }
        if (isTrue(rec.dynamic)) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "BRIDGE_PORT_DYNAMIC",
            message: `The port entry for "${parsed.interface}" on "${parsed.bridge}" is dynamic and cannot be edited.`,
            details: { bridge: parsed.bridge, interface: parsed.interface, id },
            recoverability: {
              retryable: false,
              suggestedAction:
                "Change the configuration that creates the dynamic port (e.g. the WiFi or CAPsMAN datapath) instead.",
            },
          });
        }
        const { updates, diff } = portSettingsDiff(parsed, rec);
        if (diff.length === 0) {
          return {
            content: `Port "${parsed.interface}" on bridge "${parsed.bridge}" already matches the requested settings. No changes made.`,
            structuredContent: { action: "no_change", port: rec, warnings: [] },
          };
        }
        const warnings = await portVlanWarnings(context.routerClient, parsed.bridge, diff);
        if (parsed.dryRun) {
          return {
            content: withWarnings(
              `Dry run: Would update port "${parsed.interface}" on bridge "${parsed.bridge}".`,
              warnings,
            ),
            structuredContent: { action: "dry_run", diff, warnings },
          };
        }
        await context.routerClient.update("interface/bridge/port", id, updates);
        log.info(
          { bridge: parsed.bridge, interface: parsed.interface, changed: Object.keys(updates) },
          "Bridge port updated",
        );
        return {
          content: withWarnings(
            `Updated port "${parsed.interface}" on bridge "${parsed.bridge}".`,
            warnings,
          ),
          structuredContent: {
            action: "updated",
            bridge: parsed.bridge,
            interface: parsed.interface,
            id,
            diff,
            warnings,
          },
        };
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove "${parsed.interface}" from bridge "${parsed.bridge}".`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "interface", before: parsed.interface, after: null }],
          },
        };
      }
      await context.routerClient.remove("interface/bridge/port", id);
      log.info({ bridge: parsed.bridge, interface: parsed.interface }, "Bridge port removed");
      return {
        content: `Removed "${parsed.interface}" from bridge "${parsed.bridge}".`,
        structuredContent: {
          action: "removed",
          bridge: parsed.bridge,
          interface: parsed.interface,
          id,
        },
      };
    } catch (err) {
      throw toolError(err, context, "manage_bridge_port");
    }
  },
};

const listBridgeVlansInputSchema = z
  .object({
    routerId,
    bridge: z.string().optional().describe("Only entries of this bridge"),
    vlanId: z
      .number()
      .int()
      .min(VLAN_ID_MIN)
      .max(VLAN_ID_MAX)
      .optional()
      .describe("Only entries whose vlan-ids include this VLAN (ranges and lists are expanded)"),
    limit,
    offset,
  })
  .strict();

const listBridgeVlansTool: ToolDefinition = {
  name: "list_bridge_vlans",
  title: "List Bridge VLANs",
  description:
    "List the bridge VLAN table (interface/bridge/vlan) on a MikroTik router: per entry the bridge, vlan-ids, configured tagged/untagged ports, the current-tagged/current-untagged ports RouterOS actually applies, and whether it is dynamic. Filter by bridge and by a VLAN id (matched inside ranges and lists), with pagination.",
  inputSchema: listBridgeVlansInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listBridgeVlansInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, bridge: parsed.bridge, vlanId: parsed.vlanId },
      "Listing bridge VLANs",
    );
    try {
      const entries = await context.routerClient.get<RouterOSRecord>(
        "interface/bridge/vlan",
        parsed.bridge !== undefined ? { filter: { bridge: parsed.bridge } } : {},
      );
      const vlanId = parsed.vlanId;
      const matching =
        vlanId === undefined
          ? entries
          : entries.filter((e) => parseVlanIds(e["vlan-ids"])?.includes(vlanId) ?? false);

      const { items: paginated, total, hasMore } = paginate(matching, parsed.offset, parsed.limit);

      return {
        content: listContent(
          "Bridge VLANs",
          context.routerId,
          paginated,
          total,
          parsed.offset,
          (e) =>
            compactFields(e, [
              "bridge",
              "vlan-ids",
              "tagged",
              "untagged",
              "current-tagged",
              "current-untagged",
              "dynamic",
              "disabled",
              "comment",
            ]),
        ),
        structuredContent: {
          routerId: context.routerId,
          vlans: paginated,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_bridge_vlans");
    }
  },
};

const interfaceName = z
  .string()
  .min(1)
  .regex(/^[^,]+$/, "An interface name cannot contain a comma");

const manageBridgeVlanInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "update", "remove"]).describe("Action to perform"),
    bridge: z.string().min(1).describe("Bridge interface name"),
    vlanIds: z
      .union([z.number().int(), z.string()])
      .refine((v) => parseVlanIds(v) !== null, {
        message:
          "vlanIds must be a VLAN id 1-4094, a range like 100-110, or a comma list of those (10,20,100-110)",
      })
      .describe(
        "VLAN id (1-4094), range (100-110) or comma list (10,20,100-110). With bridge, the idempotency key; order and format do not matter (20,10 equals 10,20)",
      ),
    tagged: z
      .array(interfaceName)
      .max(512)
      .optional()
      .describe(
        "Interfaces that carry these VLANs tagged (trunks). Include the bridge itself when the router has a VLAN interface on it. On update, replaces the list; [] clears it",
      ),
    untagged: z
      .array(interfaceName)
      .max(512)
      .optional()
      .describe(
        "Interfaces that carry these VLANs untagged (access ports; set their PVID to match with manage_bridge_port). On update, replaces the list; [] clears it",
      ),
    comment: z.string().max(255).optional().describe("Optional comment"),
    disabled: z
      .boolean()
      .optional()
      .describe("Whether the entry is disabled (unchanged on update when omitted)"),
    dryRun,
  })
  .strict();

const manageBridgeVlanTool: ToolDefinition = {
  name: "manage_bridge_vlan",
  title: "Manage Bridge VLAN",
  description:
    "Add, update, or remove a bridge VLAN table entry (interface/bridge/vlan): which ports carry which VLANs tagged or untagged. Idempotent by bridge + vlanIds, compared as a set of ids (10,20 equals 20,10; 100-102 equals 100,101,102) with port lists compared order-insensitively: add returns already_exists when an equal entry exists and CONFLICT when it exists with different ports or overlaps another entry's VLANs; update returns no_change when nothing differs; update and remove return NOT_FOUND when no static entry has exactly those VLANs. Dynamic entries (created by RouterOS from PVIDs) are refused. A port listed as both tagged and untagged is rejected. Results warn when the bridge has vlan-filtering off (the entry has no effect until it is on) and when a change drops the bridge itself from a VLAN while filtering is on. Workflow: create the VLAN entries, set access-port PVIDs with manage_bridge_port, then enable vlan-filtering with manage_bridge last.",
  inputSchema: manageBridgeVlanInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["interface/bridge/vlan"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageBridgeVlanInputSchema.parse(params);
    const ids = parseVlanIds(parsed.vlanIds) ?? [];
    const vlanIds = formatVlanIds(ids);
    const comment = sanitizeComment(parsed.comment);
    log.info(
      { routerId: context.routerId, action: parsed.action, bridge: parsed.bridge, vlanIds },
      "Managing bridge VLAN",
    );
    try {
      const [bridges, entries] = await Promise.all([
        context.routerClient.get<RouterOSRecord>("interface/bridge", {
          filter: { name: parsed.bridge },
        }),
        context.routerClient.get<RouterOSRecord>("interface/bridge/vlan", {
          filter: { bridge: parsed.bridge },
        }),
      ]);
      if (bridges.length === 0) throw bridgeNotFound(parsed.bridge);
      const filtering = isTrue((bridges[0] as Record<string, unknown>)["vlan-filtering"]);

      const all = entries as Record<string, unknown>[];
      const exact = all.filter((e) => sameIds(parseVlanIds(e["vlan-ids"]), ids));
      const existing = exact.find((e) => !isTrue(e.dynamic));
      const overlapping = all.filter(
        (e) =>
          !isTrue(e.dynamic) &&
          !exact.includes(e) &&
          (parseVlanIds(e["vlan-ids"]) ?? []).some((id) => ids.includes(id)),
      );
      const key = `VLAN ${vlanIds} on bridge "${parsed.bridge}"`;

      const assertNoOverlap = (tagged: string[], untagged: string[]): void => {
        const both = tagged.filter((name) => untagged.includes(name));
        if (both.length > 0) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "BRIDGE_VLAN_PORT_OVERLAP",
            message: `${both.join(", ")} cannot be both tagged and untagged for ${key}; RouterOS rejects it.`,
            details: { bridge: parsed.bridge, vlanIds, both, tagged, untagged },
            recoverability: {
              retryable: false,
              suggestedAction:
                "List each port once: tagged for a trunk, untagged for an access port.",
            },
          });
        }
      };

      const membersOf = (e: Record<string, unknown>): string[] => [
        ...memberSet(e.tagged),
        ...memberSet(e.untagged),
      ];

      const bridgeDropWarning = (before: string[], after: string[]): string[] =>
        filtering && before.includes(parsed.bridge) && !after.includes(parsed.bridge)
          ? [
              `This drops "${parsed.bridge}" itself from VLAN ${vlanIds} while vlan-filtering is on: the router stops sending and receiving that VLAN on the bridge, so a management address on a VLAN interface for it becomes unreachable.`,
            ]
          : [];

      const notFound = (): MikroMCPError => {
        const dynamic = exact.find((e) => isTrue(e.dynamic));
        if (dynamic) {
          return new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "BRIDGE_VLAN_DYNAMIC",
            message: `The entry for ${key} is dynamic (RouterOS derives it from port PVIDs) and cannot be modified.`,
            details: { bridge: parsed.bridge, vlanIds, entry: dynamic },
            recoverability: {
              retryable: false,
              suggestedAction:
                "Add a static entry for the VLAN with action add, or change the port PVIDs with manage_bridge_port.",
              alternativeTools: ["manage_bridge_vlan", "manage_bridge_port"],
            },
          });
        }
        return new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "BRIDGE_VLAN_NOT_FOUND",
          message: `No static bridge VLAN entry for ${key}.`,
          details: {
            bridge: parsed.bridge,
            vlanIds,
            overlapping: overlapping.map((e) => ({ id: e[".id"], "vlan-ids": e["vlan-ids"] })),
          },
          recoverability: {
            retryable: false,
            suggestedAction:
              "vlanIds must match an entry's VLAN set exactly; check list_bridge_vlans.",
            alternativeTools: ["list_bridge_vlans"],
          },
        });
      };

      if (parsed.action === "add") {
        const tagged = memberSet(parsed.tagged?.join(","));
        const untagged = memberSet(parsed.untagged?.join(","));
        assertNoOverlap(tagged, untagged);
        const warnings = filtering ? [] : [vlanFilteringOffWarning(parsed.bridge)];

        if (existing) {
          const diff: DiffEntry[] = [];
          if (!sameMembers(memberSet(existing.tagged), tagged)) {
            diff.push({
              property: "tagged",
              before: memberSet(existing.tagged).join(","),
              after: tagged.join(","),
            });
          }
          if (!sameMembers(memberSet(existing.untagged), untagged)) {
            diff.push({
              property: "untagged",
              before: memberSet(existing.untagged).join(","),
              after: untagged.join(","),
            });
          }
          if (diff.length === 0) {
            return {
              content: withWarnings(
                `${key} already exists with the same ports. No changes made.`,
                warnings,
              ),
              structuredContent: { action: "already_exists", vlan: existing, warnings },
            };
          }
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "BRIDGE_VLAN_CONFLICT",
            message: `${key} already exists with different ports.`,
            details: { bridge: parsed.bridge, vlanIds, id: existing[".id"], diff },
            recoverability: {
              retryable: false,
              suggestedAction: "Use action update to change the ports of the existing entry.",
              alternativeTools: ["manage_bridge_vlan"],
            },
          });
        }

        if (overlapping.length > 0) {
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "BRIDGE_VLAN_OVERLAP",
            message: `${key} overlaps existing entries (${overlapping.map((e) => String(e["vlan-ids"])).join("; ")}); a VLAN should appear in one static entry per bridge.`,
            details: {
              bridge: parsed.bridge,
              vlanIds,
              overlapping: overlapping.map((e) => ({
                id: e[".id"],
                "vlan-ids": e["vlan-ids"],
                tagged: e.tagged,
                untagged: e.untagged,
              })),
            },
            recoverability: {
              retryable: false,
              suggestedAction:
                "Update the overlapping entry, or remove it and add entries that do not share VLAN ids.",
              alternativeTools: ["manage_bridge_vlan", "list_bridge_vlans"],
            },
          });
        }

        const body: Record<string, string> = { bridge: parsed.bridge, "vlan-ids": vlanIds };
        if (tagged.length > 0) body.tagged = tagged.join(",");
        if (untagged.length > 0) body.untagged = untagged.join(",");
        if (comment) body.comment = comment;
        if (parsed.disabled !== undefined) body.disabled = parsed.disabled ? "true" : "false";

        if (parsed.dryRun) {
          return {
            content: withWarnings(`Dry run: Would add ${key}.`, warnings),
            structuredContent: {
              action: "dry_run",
              diff: Object.entries(body).map(([property, after]) => ({
                property,
                before: null,
                after,
              })),
              warnings,
            },
          };
        }
        const created = await context.routerClient.create("interface/bridge/vlan", body);
        log.info({ bridge: parsed.bridge, vlanIds, id: created[".id"] }, "Bridge VLAN added");
        return {
          content: withWarnings(`Added ${key}.`, warnings),
          structuredContent: { action: "created", vlan: created, warnings },
        };
      }

      if (!existing) throw notFound();
      const id = String(existing[".id"]);

      if (parsed.action === "update") {
        const beforeTagged = memberSet(existing.tagged);
        const beforeUntagged = memberSet(existing.untagged);
        const tagged = parsed.tagged ? memberSet(parsed.tagged.join(",")) : beforeTagged;
        const untagged = parsed.untagged ? memberSet(parsed.untagged.join(",")) : beforeUntagged;
        assertNoOverlap(tagged, untagged);

        const updates: Record<string, string> = {};
        const diff: DiffEntry[] = [];
        if (!sameMembers(beforeTagged, tagged)) {
          updates.tagged = tagged.join(",");
          diff.push({ property: "tagged", before: beforeTagged.join(","), after: updates.tagged });
        }
        if (!sameMembers(beforeUntagged, untagged)) {
          updates.untagged = untagged.join(",");
          diff.push({
            property: "untagged",
            before: beforeUntagged.join(","),
            after: updates.untagged,
          });
        }
        if (comment !== undefined && !sameValue(existing.comment ?? "", comment)) {
          updates.comment = comment;
          diff.push({
            property: "comment",
            before: existing.comment === undefined ? null : String(existing.comment),
            after: comment,
          });
        }
        if (parsed.disabled !== undefined && isTrue(existing.disabled) !== parsed.disabled) {
          updates.disabled = parsed.disabled ? "true" : "false";
          diff.push({
            property: "disabled",
            before: String(isTrue(existing.disabled)),
            after: updates.disabled,
          });
        }

        if (diff.length === 0) {
          return {
            content: `${key} already matches the requested settings. No changes made.`,
            structuredContent: { action: "no_change", vlan: existing, warnings: [] },
          };
        }

        const warnings = [
          ...(filtering ? [] : [vlanFilteringOffWarning(parsed.bridge)]),
          ...bridgeDropWarning(membersOf(existing), [...tagged, ...untagged]),
        ];
        if (parsed.dryRun) {
          return {
            content: withWarnings(`Dry run: Would update ${key}.`, warnings),
            structuredContent: { action: "dry_run", diff, warnings },
          };
        }
        await context.routerClient.update("interface/bridge/vlan", id, updates);
        log.info(
          { bridge: parsed.bridge, vlanIds, changed: Object.keys(updates) },
          "Bridge VLAN updated",
        );
        return {
          content: withWarnings(`Updated ${key}.`, warnings),
          structuredContent: {
            action: "updated",
            bridge: parsed.bridge,
            vlanIds,
            id,
            diff,
            warnings,
          },
        };
      }

      const warnings = bridgeDropWarning(membersOf(existing), []);
      if (parsed.dryRun) {
        return {
          content: withWarnings(`Dry run: Would remove ${key}.`, warnings),
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "vlan-ids", before: String(existing["vlan-ids"]), after: null }],
            warnings,
          },
        };
      }
      await context.routerClient.remove("interface/bridge/vlan", id);
      log.info({ bridge: parsed.bridge, vlanIds }, "Bridge VLAN removed");
      return {
        content: withWarnings(`Removed ${key}.`, warnings),
        structuredContent: { action: "removed", bridge: parsed.bridge, vlanIds, id, warnings },
      };
    } catch (err) {
      throw toolError(err, context, "manage_bridge_vlan");
    }
  },
};

export const bridgeTools: ToolDefinition[] = [
  listBridgesTool,
  manageBridgeTool,
  manageBridgePortTool,
  listBridgePortsTool,
  listBridgeVlansTool,
  manageBridgeVlanTool,
];
