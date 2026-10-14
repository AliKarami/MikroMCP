// ---------------------------------------------------------------------------
// MikroMCP - SwOS backup, restore and firmware upgrade
//
// These drive the same endpoints as the web UI's System and Upgrade tabs:
//   * GET  /backup.swb               -> the switch's own (opaque) backup file
//   * POST /backup.swb  field "file" -> restore it; the switch reboots
//   * POST /pboot "*", then POST /upgrade field "blob" -> flash firmware
// Local files live in <dataDir>/swos/ and are named, never given as paths, so
// a remote MCP client cannot point the server at an arbitrary file.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import { createLogger } from "../../observability/logger.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { requireSwosClient } from "./swos-tools.js";
import type { SwosClient } from "../../adapter/swos-client.js";
import { MAX_SWOS_PASSWORD_LENGTH } from "../../adapter/swos-protocol.js";

const log = createLogger("swos-maintenance-tools");

/** MikroTik's download server; the web UI fetches the same files over plain HTTP. */
const DOWNLOAD_BASE = "https://download.mikrotik.com/swos";
const FIRMWARE_MIN_BYTES = 16 * 1024;
const FIRMWARE_MAX_BYTES = 8 * 1024 * 1024;
/** Flashing can take a while before the switch answers the upload. */
const UPGRADE_TIMEOUT_MS = 120_000;
const RESTORE_TIMEOUT_MS = 60_000;

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const fileName = z
  .string()
  .regex(FILE_NAME, "a plain file name inside the server's SwOS folder, no path");

function swosDir(context: ToolContext): string {
  return join(context.appConfig.dataDir, "swos");
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function swosError(
  category: ErrorCategory,
  code: string,
  message: string,
  suggestedAction: string,
  details?: Record<string, unknown>,
): MikroMCPError {
  return new MikroMCPError({
    category,
    code,
    message,
    details,
    recoverability: { retryable: false, suggestedAction },
  });
}

/**
 * The switch reboots right after a restore or firmware upload, often before it
 * answers the POST. A timeout or a dropped connection at that point means "sent,
 * outcome unknown", not "failed".
 */
function lostToReboot(err: unknown): boolean {
  if (err instanceof MikroMCPError) return err.category === ErrorCategory.ROUTER_TIMEOUT;
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    (err instanceof Error && /socket hang up/i.test(err.message))
  );
}

/**
 * A path inside the SwOS folder. Names are validated, but the model string a
 * switch reports (plain HTTP) also ends up in file names, so the resolved path
 * is checked as well.
 */
function insideSwosDir(context: ToolContext, name: string): string {
  const dir = resolve(swosDir(context));
  const path = resolve(dir, name);
  if (!path.startsWith(dir + sep) || path === dir) {
    throw swosError(
      ErrorCategory.VALIDATION,
      "SWOS_FILE_NAME_INVALID",
      `"${name}" does not name a file inside the server's SwOS folder.`,
      "Use a plain file name without path separators.",
    );
  }
  return path;
}

async function readLocal(context: ToolContext, name: string): Promise<Buffer> {
  const path = insideSwosDir(context, name);
  try {
    return await readFile(path);
  } catch {
    throw swosError(
      ErrorCategory.NOT_FOUND,
      "SWOS_FILE_NOT_FOUND",
      `No file "${name}" in ${swosDir(context)}.`,
      "Use a file saved by save_swos_backup or downloaded by upgrade_swos_firmware, or copy it into that folder.",
    );
  }
}

/** Backups hold the switch's credentials: the folder and its files are owner-only. */
async function saveLocal(context: ToolContext, name: string, data: Buffer): Promise<string> {
  const path = insideSwosDir(context, name);
  await mkdir(swosDir(context), { recursive: true, mode: 0o700 });
  await writeFile(path, data, { mode: 0o600 });
  return path;
}

interface SwitchIdentity {
  model: string;
  version: string;
}

async function identify(client: SwosClient): Promise<SwitchIdentity> {
  const sys = (await client.get("sys.b")) as Record<string, unknown>;
  return { model: String(sys.model ?? "unknown"), version: String(sys.version ?? "unknown") };
}

/**
 * The name MikroTik files a model's firmware under. The web UI derives it from
 * the model prefix (CRS -> CSS); the CSS318 variants are the exception, their
 * files are swos-css318g (16G) and swos-css318p (16P).
 */
const BOARD_EXCEPTIONS: Record<string, string> = {
  "CSS318-16G-2S+IN": "css318g",
  "CSS318-16G-2S+": "css318g",
  "CRS318-16P-2S+": "css318p",
};

const BOARD_NAME = /^[a-z0-9]+$/;

export function firmwareBoard(model: string): string {
  return BOARD_EXCEPTIONS[model] ?? model.split("-")[0].replace(/^CRS/, "CSS").toLowerCase();
}

/**
 * The board derived from what the switch reports, validated: the model string
 * comes over plain HTTP, so it is not allowed to shape a path or a URL unless it
 * looks like a board name.
 */
function derivedBoard(model: string): string {
  const board = firmwareBoard(model);
  if (!BOARD_NAME.test(board)) {
    throw swosError(
      ErrorCategory.VALIDATION,
      "SWOS_BOARD_UNKNOWN",
      `Cannot derive a firmware board name from the model "${model}" the switch reports.`,
      "Pass `board` explicitly (e.g. css318g), with force: true if the model string is odd.",
      { model },
    );
  }
  return board;
}

/** The backup file names save_swos_backup writes: <routerId>_<model>_<version>_<stamp>.swb */
const BACKUP_FILE = /^(.+)_(.+)_([^_]+)_\d{8}-\d{6}\.swb$/;

async function fetchOk(url: string, what: string, maxBytes?: number): Promise<Response> {
  let response: Response;
  try {
    // No redirects: a download that moves off MikroTik's server is refused, not followed.
    response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
  } catch (err) {
    throw swosError(
      ErrorCategory.INTERNAL,
      "SWOS_DOWNLOAD_FAILED",
      `Could not fetch the ${what} from ${url}: ${err instanceof Error ? err.message : String(err)}`,
      "Check that the MikroMCP host can reach download.mikrotik.com, or place the firmware file in the SwOS folder and pass `file`.",
    );
  }
  if (!response.ok) {
    throw swosError(
      ErrorCategory.NOT_FOUND,
      "SWOS_DOWNLOAD_FAILED",
      `MikroTik's server answered ${response.status} for the ${what} at ${url}.`,
      "Check the version and board (pass `board` to override the derived name).",
      { url, status: response.status },
    );
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (maxBytes !== undefined && length > maxBytes) {
    throw swosError(
      ErrorCategory.VALIDATION,
      "SWOS_DOWNLOAD_TOO_LARGE",
      `The ${what} at ${url} is ${length} bytes, more than a SwOS image can be.`,
      "Check the URL; a firmware image is well under 8 MB.",
      { url, bytes: length },
    );
  }
  return response;
}

// ---------------------------------------------------------------------------
// save_swos_backup
// ---------------------------------------------------------------------------

const saveBackupSchema = z.object({ routerId }).strict();

const saveSwosBackupTool: ToolDefinition = {
  name: "save_swos_backup",
  title: "Save SwOS Backup",
  description:
    "Download the switch's own configuration backup (backup.swb, the file the web UI's Save Backup produces) into the server's SwOS folder. The file is MikroTik's opaque format: it restores only through restore_swos_backup or the web UI, on the same model. A switch on factory defaults has nothing to save. Writes a file on the server (owner-only), so it is audited like a write.",
  inputSchema: saveBackupSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  platform: "swos",
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    saveBackupSchema.parse(params);
    const client = requireSwosClient(context);
    try {
      const { model, version } = await identify(client);
      const data = await client.getBinary("backup.swb");
      if (data.length === 0) {
        return {
          content: `${context.routerId} runs its default configuration; there is no backup to save.`,
          structuredContent: { routerId: context.routerId, action: "default_config" },
        };
      }
      const file = `${context.routerId}_${model}_${version}_${stamp()}.swb`.replace(
        /[^A-Za-z0-9._+-]/g,
        "_",
      );
      const path = await saveLocal(context, file, data);
      const hash = sha256(data);
      log.info({ routerId: context.routerId, path, bytes: data.length }, "SwOS backup saved");
      return {
        content: `Saved the backup of ${context.routerId} (${model}, SwOS ${version}) as ${file} (${data.length} bytes, sha256 ${hash}).`,
        structuredContent: {
          routerId: context.routerId,
          action: "saved",
          file,
          path,
          bytes: data.length,
          sha256: hash,
          model,
          version,
        },
      };
    } catch (err) {
      throw toolError(err, context, "save_swos_backup");
    }
  },
};

// ---------------------------------------------------------------------------
// restore_swos_backup
// ---------------------------------------------------------------------------

const restoreBackupSchema = z
  .object({
    routerId,
    file: fileName.describe("Backup file in the server's SwOS folder (from save_swos_backup)."),
    dryRun: z.boolean().default(true).describe("Check the file and the switch without restoring."),
    saveCurrentFirst: z
      .boolean()
      .default(true)
      .describe("Save the switch's current backup before restoring, so the restore can be undone."),
    force: z
      .boolean()
      .default(false)
      .describe(
        "Restore a backup whose file name says it came from another switch or model (as named by save_swos_backup).",
      ),
  })
  .strict();

const restoreSwosBackupTool: ToolDefinition = {
  name: "restore_swos_backup",
  title: "Restore SwOS Backup",
  description:
    "Restore a backup.swb file from the server's SwOS folder onto the switch, as the web UI's Restore Backup does. The switch replaces its whole configuration and reboots, so it is unreachable for a while, and its address may change to the one in the backup. By default the current configuration is saved first. dryRun defaults to true.",
  inputSchema: restoreBackupSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  platform: "swos",
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = restoreBackupSchema.parse(params);
    const client = requireSwosClient(context);
    const data = await readLocal(context, parsed.file);
    if (data.length === 0) {
      throw swosError(
        ErrorCategory.VALIDATION,
        "SWOS_BACKUP_EMPTY",
        `${parsed.file} is empty.`,
        "Pick a backup saved from a configured switch.",
      );
    }
    let safetyCopy: string | undefined;
    try {
      const { model, version } = await identify(client);
      const named = BACKUP_FILE.exec(parsed.file);
      if (named && !parsed.force) {
        const [, fileRouter, fileModel] = named;
        const safeModel = model.replace(/[^A-Za-z0-9._+-]/g, "_");
        const mismatch =
          fileRouter !== context.routerId
            ? `switch "${fileRouter}", not "${context.routerId}"`
            : fileModel !== safeModel
              ? `model ${fileModel}, not ${safeModel}`
              : undefined;
        if (mismatch) {
          throw swosError(
            ErrorCategory.VALIDATION,
            "SWOS_BACKUP_MISMATCH",
            `${parsed.file} was saved from ${mismatch}.`,
            "Pick the backup of this switch, or pass force: true if it is meant for it.",
            { file: parsed.file, routerId: context.routerId, model },
          );
        }
      }
      const facts = {
        routerId: context.routerId,
        file: parsed.file,
        bytes: data.length,
        sha256: sha256(data),
        model,
        version,
      };
      if (parsed.dryRun) {
        return {
          content:
            `DRY RUN — would restore ${parsed.file} (${data.length} bytes) onto ${context.routerId} (${model}, SwOS ${version}). ` +
            "The switch would reboot. Backups only restore onto the model they came from.",
          structuredContent: { ...facts, action: "dry_run", dryRun: true },
        };
      }

      if (parsed.saveCurrentFirst) {
        const current = await client.getBinary("backup.swb");
        if (current.length > 0) {
          safetyCopy = `${context.routerId}_pre-restore_${stamp()}.swb`;
          await saveLocal(context, safetyCopy, current);
        }
      }
      try {
        await client.postMultipart("backup.swb", "file", parsed.file, data, RESTORE_TIMEOUT_MS);
      } catch (err) {
        if (!lostToReboot(err)) throw err;
        return {
          content:
            `Sent ${parsed.file} to ${context.routerId}, but the switch dropped the connection before confirming; it is probably rebooting into the restored configuration.` +
            (safetyCopy ? ` Its previous configuration was saved as ${safetyCopy}.` : "") +
            " Check it with get_swos_status once it answers again.",
          structuredContent: { ...facts, action: "sent_unconfirmed", dryRun: false, safetyCopy },
        };
      }
      log.info({ routerId: context.routerId, file: parsed.file }, "SwOS backup restored");
      return {
        content:
          `Restored ${parsed.file} onto ${context.routerId}; the switch is rebooting.` +
          (safetyCopy ? ` Its previous configuration was saved as ${safetyCopy}.` : "") +
          " Check it with get_swos_status once it answers again.",
        structuredContent: { ...facts, action: "restored", dryRun: false, safetyCopy },
      };
    } catch (err) {
      const enriched = toolError(err, context, "restore_swos_backup");
      if (!safetyCopy) throw enriched;
      throw new MikroMCPError({
        category: enriched.category,
        code: enriched.code,
        message: `${enriched.message} The configuration before the restore attempt was saved as ${safetyCopy}.`,
        details: { ...enriched.details, safetyCopy },
        recoverability: enriched.recoverability,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// upgrade_swos_firmware
// ---------------------------------------------------------------------------

const VERSION = /^\d+\.\d+(\.\d+)?([a-z]+\d*)?$/;

const upgradeSchema = z
  .object({
    routerId,
    version: z
      .string()
      .regex(VERSION, "a SwOS version such as 2.19")
      .optional()
      .describe("Target version. Defaults to the latest stable release for this model."),
    file: fileName
      .optional()
      .describe(
        "Use this firmware file from the server's SwOS folder instead of downloading one (offline upgrade).",
      ),
    board: z
      .string()
      .regex(/^[a-z0-9]+$/)
      .optional()
      .describe("Firmware board name, e.g. css318g. Derived from the model when omitted."),
    allowPrerelease: z
      .boolean()
      .default(false)
      .describe("Allow a release candidate or beta version."),
    force: z
      .boolean()
      .default(false)
      .describe("Flash a `board` that differs from the one derived from the switch's model."),
    dryRun: z
      .boolean()
      .default(true)
      .describe("Resolve, download and check the firmware without flashing it."),
  })
  .strict();

/**
 * "2.19.1779965265" (version + build time) -> "2.19". The build time is a Unix
 * timestamp, so only a long last segment is stripped; "2.17.1" stays as it is.
 */
function stripBuild(latest: string): string {
  const parts = latest.trim().split(".");
  return parts.length > 2 && /^\d{6,}$/.test(parts[parts.length - 1])
    ? parts.slice(0, -1).join(".")
    : parts.join(".");
}

/** MikroTik's firmware file name: swos-<board>-<version>.bin. */
const FIRMWARE_FILE = /^swos-([a-z0-9]+)-(\d+\.\d+(?:\.\d+)?(?:[a-z]+\d*)?)\.bin$/;

const upgradeSwosFirmwareTool: ToolDefinition = {
  name: "upgrade_swos_firmware",
  title: "Upgrade SwOS Firmware",
  description:
    "Upgrade a SwOS switch's firmware the way the web UI's Upgrade tab does. Resolves the latest stable version for the model from MikroTik's download server (or takes `version`), downloads swos-<board>-<version>.bin over HTTPS into the server's SwOS folder (or uses `file`), checks it, then flashes it; the switch reboots. Refuses release candidates unless allowPrerelease is true. A switch still on its preinstalled backup firmware (a version ending in 'p', which cannot save configuration) counts as needing the upgrade. dryRun defaults to true.",
  inputSchema: upgradeSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  platform: "swos",
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = upgradeSchema.parse(params);
    const client = requireSwosClient(context);
    try {
      const { model, version: current } = await identify(client);
      const derived = derivedBoard(model);
      if (parsed.board !== undefined && parsed.board !== derived && !parsed.force) {
        throw swosError(
          ErrorCategory.VALIDATION,
          "SWOS_FIRMWARE_MODEL_MISMATCH",
          `board ${parsed.board} does not match this ${model}, which takes ${derived}.`,
          "Drop `board`, or pass force: true if the derived name is wrong for this model.",
          { model, derived, board: parsed.board },
        );
      }
      const board = parsed.board ?? derived;

      let target = parsed.version;
      let data: Buffer;
      let file: string;
      let source: string;
      if (parsed.file) {
        file = parsed.file;
        // Only MikroTik's own file names: the board and version checks need them.
        const named = FIRMWARE_FILE.exec(file);
        if (!named) {
          throw swosError(
            ErrorCategory.VALIDATION,
            "SWOS_FIRMWARE_FILE_NAME",
            `${file} is not named like a SwOS image (swos-<board>-<version>.bin).`,
            "Keep MikroTik's file name, e.g. swos-css318g-2.19.bin.",
          );
        }
        if (named[1] !== board) {
          throw swosError(
            ErrorCategory.VALIDATION,
            "SWOS_FIRMWARE_MODEL_MISMATCH",
            `${file} is firmware for ${named[1]}, but this ${model} takes ${board}.`,
            "Use the file for this model. If the board name is wrong, pass `board` with force: true.",
          );
        }
        if (target !== undefined && target !== named[2]) {
          throw swosError(
            ErrorCategory.VALIDATION,
            "SWOS_VERSION_MISMATCH",
            `${file} holds version ${named[2]}, but version ${target} was requested.`,
            "Drop `version`, or pick the file for that version.",
          );
        }
        target = named[2];
        data = await readLocal(context, file);
        source = `file ${file}`;
      } else {
        if (target === undefined) {
          const latestUrl = `${DOWNLOAD_BASE}/${board}.LATEST`;
          target = stripBuild(await (await fetchOk(latestUrl, "latest version")).text());
        }
        if (!VERSION.test(target)) {
          throw swosError(
            ErrorCategory.VALIDATION,
            "SWOS_VERSION_INVALID",
            `MikroTik reported "${target}" as the latest version, which is not a version number.`,
            "Pass `version` explicitly.",
          );
        }
        file = `swos-${board}-${target}.bin`;
        source = `${DOWNLOAD_BASE}/${target}/${file}`;
        data = Buffer.from(
          await (await fetchOk(source, "firmware", FIRMWARE_MAX_BYTES)).arrayBuffer(),
        );
      }

      if (/[a-z]/.test(target) && !parsed.allowPrerelease) {
        throw swosError(
          ErrorCategory.VALIDATION,
          "SWOS_PRERELEASE_REFUSED",
          `${target} is not a stable release.`,
          "Pick a stable version, or pass allowPrerelease: true.",
        );
      }
      if (
        data.length < FIRMWARE_MIN_BYTES ||
        data.length > FIRMWARE_MAX_BYTES ||
        data.subarray(0, 1).toString() === "<"
      ) {
        throw swosError(
          ErrorCategory.VALIDATION,
          "SWOS_FIRMWARE_INVALID",
          `${file} (${data.length} bytes) does not look like a SwOS firmware image.`,
          "Download the .bin for this model from mikrotik.com/download and pass it as `file`.",
          { bytes: data.length },
        );
      }
      const facts = {
        routerId: context.routerId,
        model,
        board,
        currentVersion: current,
        targetVersion: target,
        source,
        file,
        bytes: data.length,
        sha256: sha256(data),
      };

      if (current === target) {
        return {
          content: `${context.routerId} already runs SwOS ${current}.`,
          structuredContent: { ...facts, action: "no_change" },
        };
      }
      if (parsed.dryRun) {
        return {
          content:
            `DRY RUN — would upgrade ${context.routerId} (${model}) from SwOS ${current} to ${target} ` +
            `using ${file} (${data.length} bytes, sha256 ${facts.sha256}, from ${source}). The switch would reboot.`,
          structuredContent: { ...facts, action: "dry_run", dryRun: true },
        };
      }
      // A dry run writes nothing, not even the downloaded image.
      if (!parsed.file) await saveLocal(context, file, data);

      // The web UI asks the switch to prepare its boot area before the upload.
      await client.postRaw("pboot", "*");
      try {
        await client.postMultipart("upgrade", "blob", file, data, UPGRADE_TIMEOUT_MS);
      } catch (err) {
        if (!lostToReboot(err)) throw err;
        return {
          content:
            `Sent ${file} to ${context.routerId}, but the switch dropped the connection before confirming; it is probably flashing and rebooting. ` +
            `Check that get_swos_status reports SwOS ${target} once it answers again.`,
          structuredContent: { ...facts, action: "sent_unconfirmed", dryRun: false },
        };
      }
      log.info({ routerId: context.routerId, file, target }, "SwOS firmware uploaded");
      return {
        content:
          `Uploaded ${file} to ${context.routerId}; the switch flashes it and reboots. ` +
          `Check that get_swos_status reports SwOS ${target} once it answers again.`,
        structuredContent: { ...facts, action: "upgraded", dryRun: false },
      };
    } catch (err) {
      throw toolError(err, context, "upgrade_swos_firmware");
    }
  },
};

// ---------------------------------------------------------------------------
// set_swos_password
// ---------------------------------------------------------------------------

const setPasswordSchema = z
  .object({
    routerId,
    newPasswordSecret: z
      .string()
      .regex(/^[A-Z0-9_]+$/)
      .describe(
        "Name of the server secret holding the new password: NAME for MIKROMCP_PASSWORD_<NAME>. The password itself never passes through the conversation, and a switch config cannot reference it.",
      ),
    dryRun: z
      .boolean()
      .default(true)
      .describe("Check the secret and the switch without changing the password."),
  })
  .strict();

const setSwosPasswordTool: ToolDefinition = {
  name: "set_swos_password",
  title: "Set SwOS Password",
  description: `Change a SwOS switch's admin password, as the web UI's Password Change does. The new password comes from the server secret MIKROMCP_PASSWORD_<newPasswordSecret>, never from the conversation; the current one is the router's configured credential. Passwords are ASCII, at most ${MAX_SWOS_PASSWORD_LENGTH} characters. After the change this call's client keeps working with the new password, but the server rebuilds the client from the router's configured credential ({PREFIX}_PASS) after any authentication failure or restart, so that variable must be updated right away. On SwOS Lite the switch does not answer the change; the result is confirmed by logging in with the new password. dryRun defaults to true.`,
  inputSchema: setPasswordSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  platform: "swos",
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = setPasswordSchema.parse(params);
    const client = requireSwosClient(context);
    const secretName = `MIKROMCP_PASSWORD_${parsed.newPasswordSecret}`;
    const newPassword = context.appConfig.passwordSecrets[parsed.newPasswordSecret];
    if (newPassword === undefined) {
      throw swosError(
        ErrorCategory.CONFIGURATION,
        "SWOS_PASSWORD_SECRET_MISSING",
        `${secretName} is not set in the MikroMCP server's environment.`,
        `Set ${secretName} to the new password and restart the server, then call this again.`,
      );
    }
    // Same limits as the web UI: a longer or non-ASCII password would be cut
    // at the 32-byte buffer and set to something nobody can type back.
    if (newPassword.length === 0 || newPassword.length > MAX_SWOS_PASSWORD_LENGTH) {
      throw swosError(
        ErrorCategory.VALIDATION,
        "SWOS_PASSWORD_INVALID",
        `The new password in ${secretName} must be 1 to ${MAX_SWOS_PASSWORD_LENGTH} characters.`,
        `Shorten ${secretName}.`,
      );
    }
    if (!/^[\x20-\x7e]+$/.test(newPassword)) {
      throw swosError(
        ErrorCategory.VALIDATION,
        "SWOS_PASSWORD_INVALID",
        `The new password in ${secretName} has characters SwOS does not accept (printable ASCII only).`,
        `Change ${secretName}.`,
      );
    }

    const envPrefix = context.routerConfig.credentials.envPrefix;
    const updateHint = envPrefix
      ? `Set ${envPrefix}_PASS to the new password now: the server falls back to it after an authentication failure or a restart.`
      : "Update the router's configured password now: the server falls back to it after an authentication failure or a restart.";
    try {
      const sys = await client.readBlob("sys.b");
      const field = "ver" in sys || "brd" in sys ? "pwd" : "i01";
      const { model } = await identify(client);
      if (parsed.dryRun) {
        return {
          content: `DRY RUN — would change the admin password of ${context.routerId} (${model}) to the value of ${secretName}. ${updateHint}`,
          structuredContent: { routerId: context.routerId, action: "dry_run", dryRun: true, field },
        };
      }
      await client.changePassword(newPassword, field);
      log.info({ routerId: context.routerId }, "SwOS admin password changed");
      return {
        content: `Changed the admin password of ${context.routerId}; this server now authenticates with the new one. ${updateHint}`,
        structuredContent: { routerId: context.routerId, action: "changed", dryRun: false },
      };
    } catch (err) {
      throw toolError(err, context, "set_swos_password");
    }
  },
};

export const swosMaintenanceTools: ToolDefinition[] = [
  saveSwosBackupTool,
  restoreSwosBackupTool,
  upgradeSwosFirmwareTool,
  setSwosPasswordTool,
];
