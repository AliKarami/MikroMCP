import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  firmwareBoard,
  swosMaintenanceTools,
} from "../../../src/domain/tools/swos-maintenance-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { SwosClient } from "../../../src/adapter/swos-client.js";
import { decodeEndpoint, parseWireBlob } from "../../../src/adapter/swos-protocol.js";

const FULL = join(import.meta.dirname, "../../fixtures/swos-full");
const [saveTool, restoreTool, upgradeTool, passwordTool] = swosMaintenanceTools;
const hex = (s: string) => Buffer.from(s).toString("hex");

function sysBlob(version: string): string {
  return readFileSync(join(FULL, "sys.b"), "utf8")
    .trim()
    .replace(`ver:'${hex("2.19")}'`, `ver:'${hex(version)}'`);
}

function makeSwitch(opts: { version?: string; backup?: Buffer } = {}) {
  const uploads: { path: string; field: string; filename: string; data: Buffer }[] = [];
  const posts: { path: string; body: string }[] = [];
  const client = {
    get: vi.fn(async (ep: string) => decodeEndpoint(ep, sysBlob(opts.version ?? "2.19"))),
    readBlob: vi.fn(async () => parseWireBlob(sysBlob(opts.version ?? "2.19"))),
    changePassword: vi.fn(async () => undefined),
    getBinary: vi.fn(async () => opts.backup ?? Buffer.alloc(0)),
    postRaw: vi.fn(async (path: string, body: string) => {
      posts.push({ path, body });
      return "";
    }),
    postMultipart: vi.fn(async (path: string, field: string, filename: string, data: Buffer) => {
      uploads.push({ path, field, filename, data });
      return "";
    }),
  };
  return { client, uploads, posts };
}

let dataDir: string;
const swosDir = () => join(dataDir, "swos");

function makeContext(sw: ReturnType<typeof makeSwitch>, secrets: Record<string, string> = {}) {
  return {
    routerId: "switch-01",
    correlationId: "test-corr",
    swosClient: sw.client as unknown as SwosClient,
    deviceClient: sw.client,
    routerConfig: { credentials: { source: "env", envPrefix: "SWITCH_CORE" } },
    appConfig: { dataDir, configSecrets: {}, passwordSecrets: secrets },
  } as unknown as ToolContext;
}

const FIRMWARE = Buffer.alloc(73_168, 0x5a);

function stubDownloads(latest = "2.19.1779965265", status = 200, firmware = FIRMWARE) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith(".LATEST")) return new Response(latest, { status });
    return new Response(status === 200 ? firmware : "not found", { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mikromcp-swos-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("swosMaintenanceTools", () => {
  describe("metadata", () => {
    it("exports the four maintenance tools for the swos platform", () => {
      expect(swosMaintenanceTools.map((t) => t.name)).toEqual([
        "save_swos_backup",
        "restore_swos_backup",
        "upgrade_swos_firmware",
        "set_swos_password",
      ]);
      for (const tool of swosMaintenanceTools) expect(tool.platform).toBe("swos");
      // It writes a file on the server, so it is audited and never auto-retried.
      expect(saveTool.annotations.readOnlyHint).toBe(false);
      expect(saveTool.annotations.destructiveHint).toBe(false);
      expect(restoreTool.annotations.destructiveHint).toBe(true);
      expect(upgradeTool.annotations.destructiveHint).toBe(true);
      expect(upgradeTool.annotations.openWorldHint).toBe(true);
    });

    it("fills the defaults and rejects paths, odd board names and unknown fields", () => {
      expect(restoreTool.inputSchema.parse({ routerId: "switch-01", file: "a.swb" })).toMatchObject(
        {
          dryRun: true,
          saveCurrentFirst: true,
          force: false,
        },
      );
      expect(() =>
        restoreTool.inputSchema.parse({ routerId: "switch-01", file: "../a.swb" }),
      ).toThrow();
      expect(() =>
        restoreTool.inputSchema.parse({ routerId: "switch-01", file: "a/b.swb" }),
      ).toThrow();
      expect(upgradeTool.inputSchema.parse({ routerId: "switch-01" })).toMatchObject({
        allowPrerelease: false,
        force: false,
        dryRun: true,
      });
      expect(() =>
        upgradeTool.inputSchema.parse({ routerId: "switch-01", board: "CSS318G" }),
      ).toThrow();
      expect(() =>
        upgradeTool.inputSchema.parse({ routerId: "switch-01", version: "latest" }),
      ).toThrow();
      expect(() =>
        upgradeTool.inputSchema.parse({ routerId: "switch-01", reboot: true }),
      ).toThrow();
      expect(
        passwordTool.inputSchema.parse({ routerId: "switch-01", newPasswordSecret: "SWITCH_NEW" }),
      ).toMatchObject({ dryRun: true });
      expect(() =>
        passwordTool.inputSchema.parse({ routerId: "switch-01", newPasswordSecret: "switch-new" }),
      ).toThrow();
      expect(() => saveTool.inputSchema.parse({ routerId: "switch-01", file: "x" })).toThrow();
    });

    it("derives MikroTik's firmware board names", () => {
      expect(firmwareBoard("CSS318-16G-2S+IN")).toBe("css318g");
      expect(firmwareBoard("CRS318-16P-2S+")).toBe("css318p");
      expect(firmwareBoard("CRS326-24G-2S+")).toBe("css326");
      expect(firmwareBoard("CSS610-8G-2S+IN")).toBe("css610");
    });
  });

  describe("save_swos_backup", () => {
    it("saves the backup into the SwOS folder with its hash", async () => {
      const backup = Buffer.from([1, 2, 3, 255, 0]);
      const result = await saveTool.handler(
        { routerId: "switch-01" },
        makeContext(makeSwitch({ backup })),
      );
      const sc = result.structuredContent as { file: string; sha256: string; bytes: number };
      expect(sc.file).toMatch(/^switch-01_CSS318-16G-2S\+IN_2\.19_\d{8}-\d{6}\.swb$/);
      expect(readFileSync(join(swosDir(), sc.file))).toEqual(backup);
      expect(sc.bytes).toBe(5);
      expect(sc.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("reports a factory-default switch instead of saving an empty file", async () => {
      const result = await saveTool.handler({ routerId: "switch-01" }, makeContext(makeSwitch()));
      expect((result.structuredContent as Record<string, unknown>).action).toBe("default_config");
      expect(existsSync(swosDir())).toBe(false);
    });
  });

  describe("restore_swos_backup", () => {
    const place = (name: string, data: Buffer) => {
      mkdirSync(swosDir(), { recursive: true });
      writeFileSync(join(swosDir(), name), data);
    };

    it("refuses anything but a plain file name", async () => {
      for (const file of ["../etc/passwd", "a/b.swb", "/abs.swb", ".hidden"]) {
        await expect(
          restoreTool.handler({ routerId: "switch-01", file }, makeContext(makeSwitch())),
          file,
        ).rejects.toThrow(/plain file name/);
      }
    });

    it("reports a restore the reboot cut short as sent, not failed", async () => {
      place("golden.swb", Buffer.from("golden-backup"));
      const sw = makeSwitch({ backup: Buffer.from("current-config") });
      sw.client.postMultipart.mockRejectedValueOnce(
        Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      );
      const result = await restoreTool.handler(
        { routerId: "switch-01", file: "golden.swb", dryRun: false },
        makeContext(sw),
      );
      expect(result.structuredContent).toMatchObject({ action: "sent_unconfirmed" });
      expect((result.structuredContent as { safetyCopy: string }).safetyCopy).toMatch(
        /pre-restore/,
      );
    });

    it("names the safety copy when the restore fails", async () => {
      place("golden.swb", Buffer.from("golden-backup"));
      const sw = makeSwitch({ backup: Buffer.from("current-config") });
      sw.client.postMultipart.mockRejectedValueOnce(new Error("HTTP 500"));
      await expect(
        restoreTool.handler(
          { routerId: "switch-01", file: "golden.swb", dryRun: false },
          makeContext(sw),
        ),
      ).rejects.toMatchObject({ details: { safetyCopy: expect.stringMatching(/pre-restore/) } });
    });

    it("names a file that is not in the SwOS folder", async () => {
      await expect(
        restoreTool.handler({ routerId: "switch-01", file: "nope.swb" }, makeContext(makeSwitch())),
      ).rejects.toMatchObject({ code: "SWOS_FILE_NOT_FOUND" });
    });

    it("previews by default without touching the switch", async () => {
      place("golden.swb", Buffer.from("backup"));
      const sw = makeSwitch();
      const result = await restoreTool.handler(
        { routerId: "switch-01", file: "golden.swb" },
        makeContext(sw),
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(sw.uploads).toEqual([]);
    });

    it("saves the current configuration, then uploads the backup as field 'file'", async () => {
      place("golden.swb", Buffer.from("golden-backup"));
      const sw = makeSwitch({ backup: Buffer.from("current-config") });
      const result = await restoreTool.handler(
        { routerId: "switch-01", file: "golden.swb", dryRun: false },
        makeContext(sw),
      );
      const sc = result.structuredContent as { safetyCopy: string };
      expect(readFileSync(join(swosDir(), sc.safetyCopy), "utf8")).toBe("current-config");
      expect(sw.uploads).toEqual([
        {
          path: "backup.swb",
          field: "file",
          filename: "golden.swb",
          data: Buffer.from("golden-backup"),
        },
      ]);
    });
  });

  describe("restore_swos_backup origin check", () => {
    const backup = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const put = (name: string) => {
      mkdirSync(swosDir(), { recursive: true });
      writeFileSync(join(swosDir(), name), backup);
    };

    it("refuses a backup saved from another switch or model unless forced", async () => {
      put("switch-02_CSS318-16G-2S+IN_2.19_20261014-120000.swb");
      put("switch-01_CSS610-8G-2S+IN_2.19_20261014-120000.swb");
      const sw = makeSwitch();
      await expect(
        restoreTool.handler(
          { routerId: "switch-01", file: "switch-02_CSS318-16G-2S+IN_2.19_20261014-120000.swb" },
          makeContext(sw),
        ),
      ).rejects.toMatchObject({ code: "SWOS_BACKUP_MISMATCH" });
      await expect(
        restoreTool.handler(
          { routerId: "switch-01", file: "switch-01_CSS610-8G-2S+IN_2.19_20261014-120000.swb" },
          makeContext(sw),
        ),
      ).rejects.toMatchObject({ code: "SWOS_BACKUP_MISMATCH" });
      const forced = await restoreTool.handler(
        {
          routerId: "switch-01",
          file: "switch-02_CSS318-16G-2S+IN_2.19_20261014-120000.swb",
          force: true,
        },
        makeContext(sw),
      );
      expect((forced.structuredContent as { action: string }).action).toBe("dry_run");
    });

    it("accepts a backup from this switch and a file not named by save_swos_backup", async () => {
      put("switch-01_CSS318-16G-2S+IN_2.19_20261014-120000.swb");
      put("golden.swb");
      const sw = makeSwitch();
      for (const file of ["switch-01_CSS318-16G-2S+IN_2.19_20261014-120000.swb", "golden.swb"]) {
        const result = await restoreTool.handler({ routerId: "switch-01", file }, makeContext(sw));
        expect((result.structuredContent as { action: string }).action).toBe("dry_run");
      }
    });
  });

  describe("upgrade_swos_firmware", () => {
    it("resolves the latest stable release and downloads it over HTTPS", async () => {
      const fetchMock = stubDownloads();
      const sw = makeSwitch({ version: "2.17p" });
      const result = await upgradeTool.handler({ routerId: "switch-01" }, makeContext(sw));
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc).toMatchObject({
        action: "dry_run",
        board: "css318g",
        currentVersion: "2.17p",
        targetVersion: "2.19",
        file: "swos-css318g-2.19.bin",
        bytes: FIRMWARE.length,
      });
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
        "https://download.mikrotik.com/swos/css318g.LATEST",
        "https://download.mikrotik.com/swos/2.19/swos-css318g-2.19.bin",
      ]);
      // A dry run writes nothing, the downloaded image included.
      expect(existsSync(join(swosDir(), "swos-css318g-2.19.bin"))).toBe(false);
      expect(sw.posts).toEqual([]);
      expect(sw.uploads).toEqual([]);
    });

    it("prepares the boot area, then uploads the image as field 'blob'", async () => {
      stubDownloads();
      const sw = makeSwitch({ version: "2.18" });
      const result = await upgradeTool.handler(
        { routerId: "switch-01", dryRun: false },
        makeContext(sw),
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("upgraded");
      expect(sw.posts).toEqual([{ path: "pboot", body: "*" }]);
      expect(sw.uploads).toHaveLength(1);
      expect(sw.uploads[0]).toMatchObject({
        path: "upgrade",
        field: "blob",
        filename: "swos-css318g-2.19.bin",
      });
    });

    it("does nothing when the switch already runs the target version", async () => {
      stubDownloads();
      const sw = makeSwitch({ version: "2.19" });
      const result = await upgradeTool.handler(
        { routerId: "switch-01", dryRun: false },
        makeContext(sw),
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("no_change");
      expect(sw.uploads).toEqual([]);
    });

    it("treats the preinstalled backup firmware (2.19p) as needing the upgrade", async () => {
      stubDownloads();
      const result = await upgradeTool.handler(
        { routerId: "switch-01" },
        makeContext(makeSwitch({ version: "2.19p" })),
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
    });

    it("refuses a release candidate unless allowed", async () => {
      stubDownloads();
      await expect(
        upgradeTool.handler(
          { routerId: "switch-01", version: "2.20rc3" },
          makeContext(makeSwitch({ version: "2.18" })),
        ),
      ).rejects.toMatchObject({ code: "SWOS_PRERELEASE_REFUSED" });
    });

    it("refuses a download that is not a firmware image", async () => {
      stubDownloads("2.19.1", 200, Buffer.from("<html>error page</html>".padEnd(20_000)));
      await expect(
        upgradeTool.handler(
          { routerId: "switch-01" },
          makeContext(makeSwitch({ version: "2.18" })),
        ),
      ).rejects.toMatchObject({ code: "SWOS_FIRMWARE_INVALID" });
    });

    it("reports the URL when MikroTik's server has no such file", async () => {
      stubDownloads("2.19.1", 404);
      await expect(
        upgradeTool.handler(
          { routerId: "switch-01" },
          makeContext(makeSwitch({ version: "2.18" })),
        ),
      ).rejects.toMatchObject({ code: "SWOS_DOWNLOAD_FAILED" });
    });

    it("refuses a local firmware file built for another model", async () => {
      mkdirSync(swosDir(), { recursive: true });
      writeFileSync(join(swosDir(), "swos-css326-2.19.bin"), FIRMWARE);
      await expect(
        upgradeTool.handler(
          { routerId: "switch-01", file: "swos-css326-2.19.bin" },
          makeContext(makeSwitch({ version: "2.18" })),
        ),
      ).rejects.toMatchObject({ code: "SWOS_FIRMWARE_MODEL_MISMATCH" });
    });

    it("takes only MikroTik's own file names for a local image", async () => {
      mkdirSync(swosDir(), { recursive: true });
      writeFileSync(join(swosDir(), "firmware.bin"), FIRMWARE);
      await expect(
        upgradeTool.handler(
          { routerId: "switch-01", file: "firmware.bin" },
          makeContext(makeSwitch({ version: "2.18" })),
        ),
      ).rejects.toMatchObject({ code: "SWOS_FIRMWARE_FILE_NAME" });
    });

    it("refuses a version that disagrees with the file name", async () => {
      mkdirSync(swosDir(), { recursive: true });
      writeFileSync(join(swosDir(), "swos-css318g-2.19.bin"), FIRMWARE);
      await expect(
        upgradeTool.handler(
          { routerId: "switch-01", file: "swos-css318g-2.19.bin", version: "2.20" },
          makeContext(makeSwitch({ version: "2.18" })),
        ),
      ).rejects.toMatchObject({ code: "SWOS_VERSION_MISMATCH" });
    });

    it("refuses a board that disagrees with the model unless forced", async () => {
      stubDownloads();
      await expect(
        upgradeTool.handler(
          { routerId: "switch-01", board: "css610" },
          makeContext(makeSwitch({ version: "2.18" })),
        ),
      ).rejects.toMatchObject({ code: "SWOS_FIRMWARE_MODEL_MISMATCH" });
      const forced = await upgradeTool.handler(
        { routerId: "switch-01", board: "css610", force: true },
        makeContext(makeSwitch({ version: "2.18" })),
      );
      expect((forced.structuredContent as { board: string }).board).toBe("css610");
    });

    it("refuses a model string that is not a board name instead of using it in a path", async () => {
      const sw = makeSwitch({ version: "2.18" });
      const evil = Buffer.from("/../../../tmp/evil").toString("hex");
      const odd = sysBlob("2.18").replace(/brd:'[0-9a-f]*'/, `brd:'${evil}'`);
      sw.client.get.mockImplementation(async (ep: string) => decodeEndpoint(ep, odd));
      await expect(
        upgradeTool.handler({ routerId: "switch-01" }, makeContext(sw)),
      ).rejects.toMatchObject({ code: "SWOS_BOARD_UNKNOWN" });
    });

    it("refuses a download larger than a firmware image before buffering it", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith(".LATEST")) return new Response("2.19", { status: 200 });
        return new Response(FIRMWARE, {
          status: 200,
          headers: { "content-length": String(64 * 1024 * 1024) },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        upgradeTool.handler(
          { routerId: "switch-01" },
          makeContext(makeSwitch({ version: "2.18" })),
        ),
      ).rejects.toMatchObject({ code: "SWOS_DOWNLOAD_TOO_LARGE" });
      expect(fetchMock.mock.calls.every((c) => c[1]?.redirect === "error")).toBe(true);
    });

    it("saves the image owner-only, in an owner-only folder, before flashing", async () => {
      stubDownloads();
      const sw = makeSwitch({ version: "2.18" });
      await upgradeTool.handler({ routerId: "switch-01", dryRun: false }, makeContext(sw));
      const { statSync } = await import("node:fs");
      expect(statSync(swosDir()).mode & 0o777).toBe(0o700);
      expect(statSync(join(swosDir(), "swos-css318g-2.19.bin")).mode & 0o777).toBe(0o600);
    });

    it("keeps a three-part version from the LATEST file intact", async () => {
      stubDownloads("2.17.1");
      const result = await upgradeTool.handler(
        { routerId: "switch-01" },
        makeContext(makeSwitch({ version: "2.16" })),
      );
      expect(result.structuredContent).toMatchObject({ targetVersion: "2.17.1" });
    });

    it("reports an upload the reboot cut short as sent, not failed", async () => {
      stubDownloads();
      const sw = makeSwitch({ version: "2.18" });
      sw.client.postMultipart.mockRejectedValueOnce(
        Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      );
      const result = await upgradeTool.handler(
        { routerId: "switch-01", dryRun: false },
        makeContext(sw),
      );
      expect(result.structuredContent).toMatchObject({ action: "sent_unconfirmed" });
    });

    it("flashes a local file without going online, taking the version from its name", async () => {
      const fetchMock = stubDownloads();
      mkdirSync(swosDir(), { recursive: true });
      writeFileSync(join(swosDir(), "swos-css318g-2.19.bin"), FIRMWARE);
      const sw = makeSwitch({ version: "2.18" });
      const result = await upgradeTool.handler(
        { routerId: "switch-01", file: "swos-css318g-2.19.bin", dryRun: false },
        makeContext(sw),
      );
      expect(result.structuredContent).toMatchObject({ action: "upgraded", targetVersion: "2.19" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sw.uploads[0].data).toEqual(FIRMWARE);
    });
  });

  describe("set_swos_password", () => {
    const params = (extra: Record<string, unknown> = {}) => ({
      routerId: "switch-01",
      newPasswordSecret: "SWITCH_NEW_PASS",
      ...extra,
    });

    it("names a secret that is not set", async () => {
      await expect(passwordTool.handler(params(), makeContext(makeSwitch()))).rejects.toMatchObject(
        {
          code: "SWOS_PASSWORD_SECRET_MISSING",
        },
      );
    });

    it("refuses passwords the web UI would refuse", async () => {
      for (const bad of ["", "sixteen-chars-xx", "pässwort"]) {
        await expect(
          passwordTool.handler(params(), makeContext(makeSwitch(), { SWITCH_NEW_PASS: bad })),
          bad,
        ).rejects.toMatchObject({ code: "SWOS_PASSWORD_INVALID" });
      }
    });

    it("previews by default and never shows the password", async () => {
      const sw = makeSwitch();
      const result = await passwordTool.handler(
        params(),
        makeContext(sw, { SWITCH_NEW_PASS: "n3w-pass" }),
      );
      expect(result.structuredContent).toMatchObject({ action: "dry_run", field: "pwd" });
      expect(JSON.stringify(result)).not.toContain("n3w-pass");
      expect(sw.client.changePassword).not.toHaveBeenCalled();
    });

    it("changes the password and says which variable to update", async () => {
      const sw = makeSwitch();
      const result = await passwordTool.handler(
        params({ dryRun: false }),
        makeContext(sw, { SWITCH_NEW_PASS: "n3w-pass" }),
      );
      expect(sw.client.changePassword).toHaveBeenCalledWith("n3w-pass", "pwd");
      expect(result.content).toContain("SWITCH_CORE_PASS");
      expect(JSON.stringify(result)).not.toContain("n3w-pass");
    });
  });
});
