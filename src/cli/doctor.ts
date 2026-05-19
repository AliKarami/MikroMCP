import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as net from "node:net";
import { createRequire } from "node:module";
import chalk from "chalk";
import { RouterRegistry } from "../config/router-registry.js";
import { getCredentials } from "../config/secrets.js";
import { RouterOSRestClient } from "../adapter/rest-client.js";
import { loadAppConfig } from "../config/app-config.js";
import { IdentityRegistry } from "../config/identity-registry.js";
import { MikroMCPError } from "../domain/errors/error-types.js";
import type { RouterConfig } from "../types.js";

const require = createRequire(import.meta.url);
const { version: localVersion } = require("../../package.json") as { version: string };

// ─── helpers ───────────────────────────────────────────────────────────────

interface CheckResult {
  passed: boolean;
  warning: boolean;
}

let results: CheckResult[] = [];

function ok(msg: string): void {
  console.log(chalk.green("✅ ") + msg);
  results.push({ passed: true, warning: false });
}

function warn(msg: string): void {
  console.log(chalk.yellow("⚠️  ") + msg);
  results.push({ passed: true, warning: true });
}

function fail(msg: string): void {
  console.log(chalk.red("❌ ") + msg);
  results.push({ passed: false, warning: false });
}

function indent(msg: string): void {
  console.log("  " + msg);
}

function indentOk(msg: string): void {
  console.log(chalk.green("  ✅ ") + msg);
}

function indentWarn(msg: string): void {
  console.log(chalk.yellow("  ⚠️  ") + msg);
}

function indentFail(msg: string): void {
  console.log(chalk.red("  ❌ ") + msg);
}

// ─── TCP probe ─────────────────────────────────────────────────────────────

function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ─── Node.js version check ─────────────────────────────────────────────────

function checkNodeVersion(): void {
  const raw = process.version; // e.g. "v22.14.0"
  const major = parseInt(raw.slice(1).split(".")[0], 10);
  if (major >= 22) {
    ok(`Node.js ${raw} (required: ≥22)`);
  } else {
    fail(`Node.js ${raw} — version ≥22 required (upgrade Node.js)`);
  }
}

// ─── Routers config ────────────────────────────────────────────────────────

function checkRoutersConfig(configPath: string): RouterRegistry | null {
  if (!existsSync(configPath)) {
    fail(`Config file not found: ${configPath}`);
    return null;
  }

  try {
    const registry = new RouterRegistry(configPath);
    const routers = registry.listRouters();
    ok(`Config: ${configPath} (${routers.length} router${routers.length !== 1 ? "s" : ""})`);
    return registry;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Config parse error: ${msg}`);
    return null;
  }
}

// ─── Env vars check ────────────────────────────────────────────────────────

function checkEnvVars(routers: RouterConfig[], transport: string): void {
  const missing: string[] = [];

  for (const router of routers) {
    const { source, envPrefix } = router.credentials;
    if (source === "env" && envPrefix) {
      const userKey = `${envPrefix}_USER`;
      const passKey = `${envPrefix}_PASS`;
      if (!process.env[userKey]) missing.push(userKey);
      if (!process.env[passKey]) missing.push(passKey);
    }
  }

  if (missing.length === 0) {
    ok(`Env vars: all router credentials present`);
  } else {
    const missingStr = missing.join(", ");
    fail(`Missing credential env vars: ${missingStr}`);

    // Suggest .env file if none exists
    if (!existsSync(".env") && !existsSync(".env.local")) {
      indent(chalk.dim("Hint: cp .env.example .env  — then fill in credentials"));
    }
  }

  if (transport === "http" && !process.env.MIKROMCP_CONFIRMATION_SECRET) {
    warn("MIKROMCP_CONFIRMATION_SECRET not set — required in HTTP mode");
  }
}

// ─── Per-router connectivity ───────────────────────────────────────────────

async function checkRouter(router: RouterConfig): Promise<void> {
  console.log();
  console.log(chalk.bold(`Router: ${router.id} (${router.host})`));

  // Resolve credentials
  let client: RouterOSRestClient;
  try {
    const creds = getCredentials(router);
    client = new RouterOSRestClient(router, creds);
  } catch (err) {
    const msg = err instanceof MikroMCPError ? err.message : String(err);
    indentFail(`Credentials error: ${msg}`);
    results.push({ passed: false, warning: false });
    return;
  }

  // REST reachability — GET system/resource
  const startMs = Date.now();
  try {
    type SysResource = { version?: string; "ros-version"?: string };
    const resources = await client.get<SysResource>("system/resource");
    const latencyMs = Date.now() - startMs;
    const resource = resources[0] ?? {};
    const rosVersion =
      (resource as Record<string, string>)["version"] ??
      (resource as Record<string, string>)["ros-version"] ??
      router.rosVersion;
    indentOk(`REST API reachable (RouterOS ${rosVersion}, ${latencyMs}ms)`);
    results.push({ passed: true, warning: false });

    // Read policy check — GET ip/address
    try {
      await client.get("ip/address");
      indentOk("read policy (ip/address accessible)");
      results.push({ passed: true, warning: false });
    } catch (readErr) {
      const code =
        readErr instanceof Error && "statusCode" in readErr
          ? (readErr as { statusCode: number }).statusCode
          : 0;
      if (code === 403 || code === 401) {
        indentWarn(`read policy: ip/address returned ${code} — check user permissions`);
        results.push({ passed: true, warning: true });
      } else {
        indentFail(`read policy: ip/address failed — ${readErr instanceof Error ? readErr.message : String(readErr)}`);
        results.push({ passed: false, warning: false });
      }
    }
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    indentFail(
      `REST API not reachable after ${latencyMs}ms — ${err instanceof Error ? err.message : String(err)}`,
    );
    results.push({ passed: false, warning: false });
  } finally {
    client.close();
  }

  // SSH reachability
  const sshPort = router.sshPort ?? 22;
  const sshReachable = await tcpProbe(router.host, sshPort);
  if (sshReachable) {
    indentOk(`SSH reachable on port ${sshPort}`);
    results.push({ passed: true, warning: false });
  } else {
    indentWarn(`SSH not reachable on port ${sshPort} — ping/traceroute/run_command may not work`);
    results.push({ passed: true, warning: true });
  }

  // FTP reachability
  const ftpReachable = await tcpProbe(router.host, 21);
  if (ftpReachable) {
    indentOk("FTP reachable on port 21");
    results.push({ passed: true, warning: false });
  } else {
    indentWarn("FTP not reachable on port 21 — upload_file will not work");
    results.push({ passed: true, warning: true });
  }
}

// ─── Identities config ─────────────────────────────────────────────────────

function checkIdentities(identitiesPath: string, transport: string): void {
  if (!process.env.MIKROMCP_IDENTITIES_PATH && identitiesPath === "config/identities.yaml") {
    // Default path not explicitly configured — skip unless file exists
    if (!existsSync(identitiesPath)) {
      return;
    }
  }

  if (!existsSync(identitiesPath)) {
    warn(`Identities file not found: ${identitiesPath}`);
    return;
  }

  try {
    const registry = new IdentityRegistry(identitiesPath);
    const identities = registry.getIdentities();

    if (identities.length === 0 && transport === "http") {
      warn(`Identities: file loaded but empty — HTTP mode requires at least one identity`);
    } else {
      ok(`Identities: ${identities.length} identity${identities.length !== 1 ? "ies" : ""} loaded`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Identities config error: ${msg}`);
  }
}

// ─── Claude Desktop registration ───────────────────────────────────────────

function checkClaudeDesktop(): void {
  const candidatePaths = [
    `${homedir()}/Library/Application Support/Claude/claude_desktop_config.json`,
    `${homedir()}/.config/Claude/claude_desktop_config.json`,
  ];

  const configPath = candidatePaths.find((p) => existsSync(p));

  if (!configPath) {
    warn("Claude Desktop config not found — mikromcp may not be registered");
    return;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;

    if ("mikromcp" in servers || "mikrotik-mcp-server" in servers) {
      ok("Claude Desktop: mikromcp registered");
    } else {
      warn(
        `Claude Desktop: mikromcp not registered in ${configPath}\n` +
          `  Add to mcpServers:\n` +
          `  {\n` +
          `    "mikromcp": {\n` +
          `      "command": "mikromcp",\n` +
          `      "args": ["serve"]\n` +
          `    }\n` +
          `  }`,
      );
    }
  } catch (err) {
    warn(`Could not parse Claude Desktop config: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Update check ──────────────────────────────────────────────────────────

async function checkForUpdates(): Promise<void> {
  try {
    const response = await fetch("https://registry.npmjs.org/mikromcp/latest", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      warn("Could not check for updates (registry returned non-OK status)");
      return;
    }
    const data = (await response.json()) as { version?: string };
    const latestVersion = data.version;

    if (!latestVersion) {
      warn("Could not check for updates (unexpected registry response)");
      return;
    }

    if (latestVersion === localVersion) {
      ok(`Up to date (v${localVersion})`);
    } else {
      warn(`Update available: ${localVersion} → ${latestVersion} — run: npm install -g mikromcp`);
    }
  } catch {
    warn("Could not check for updates (network error)");
  }
}

// ─── Main entry point ──────────────────────────────────────────────────────

export async function runDoctor(): Promise<void> {
  results = [];
  const appConfig = loadAppConfig();

  console.log(chalk.bold(`mikromcp doctor v${localVersion}`));
  console.log(chalk.dim("─────────────────────────────"));
  console.log();

  // 1. Node.js version
  checkNodeVersion();

  // 2. Routers config
  const configPath = appConfig.configPath;
  const registry = checkRoutersConfig(configPath);
  const routers = registry ? registry.listRouters() : [];

  // 3. Env vars
  if (routers.length > 0) {
    checkEnvVars(routers, appConfig.transport);
  }

  // 4. Per-router connectivity
  for (const router of routers) {
    await checkRouter(router);
  }

  // 5. Identities
  console.log();
  checkIdentities(appConfig.identitiesPath, appConfig.transport);

  // 6. Claude Desktop registration
  checkClaudeDesktop();

  // 7. Update check
  await checkForUpdates();

  // ─── Summary ─────────────────────────────────────────────────────────────

  console.log();
  console.log(chalk.dim("─────────────────────────────"));

  const passed = results.filter((r) => r.passed && !r.warning).length;
  const warnings = results.filter((r) => r.warning).length;
  const errors = results.filter((r) => !r.passed).length;

  const parts: string[] = [];
  parts.push(chalk.green(`${passed} check${passed !== 1 ? "s" : ""} passed`));
  if (warnings > 0) parts.push(chalk.yellow(`${warnings} warning${warnings !== 1 ? "s" : ""}`));
  if (errors > 0) parts.push(chalk.red(`${errors} error${errors !== 1 ? "s" : ""}`));

  console.log(parts.join(", "));

  if (errors > 0) {
    process.exitCode = 1;
  }
}
