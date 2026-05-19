import { input, confirm, select } from "@inquirer/prompts";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import bcrypt from "bcryptjs";
import chalk from "chalk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RouterYamlEntry {
  host: string;
  port: number;
  tls: { enabled: boolean; rejectUnauthorized: boolean };
  credentials: { source: string; envPrefix: string };
  tags: string[];
  rosVersion: string;
}

interface IdentityYamlEntry {
  token: string;
  role: string;
  allowedRouters: string[];
  allowedToolPatterns: string[];
}

interface RoutersYaml {
  routers: Record<string, RouterYamlEntry>;
}

interface IdentitiesYaml {
  identities: Record<string, IdentityYamlEntry>;
}

interface CollectedData {
  routerId: string;
  host: string;
  port: number;
  tlsEnabled: boolean;
  rejectUnauthorized: boolean;
  envPrefix: string;
  tags: string[];
  rosVersion: string;
  createIdentity: boolean;
  identityId: string;
  role: string;
  allowedRouters: string;
  allowedToolPatterns: string;
  rawToken: string;
  tokenHash: string;
  writeEnv: boolean;
  writeRoutersYaml: boolean;
  writeIdentitiesYaml: boolean;
  registerClaudeDesktop: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function suggestEnvPrefix(routerId: string): string {
  return "ROUTER_" + routerId.toUpperCase().replace(/-/g, "_");
}

function validateRouterId(val: string): boolean | string {
  if (/^[a-zA-Z0-9-]+$/.test(val)) return true;
  return "Router ID must only contain alphanumeric characters and hyphens";
}

function splitTags(val: string): string[] {
  return val
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function findClaudeDesktopConfig(): string | null {
  const candidates = [
    join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    join(homedir(), ".config", "Claude", "claude_desktop_config.json"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function appendToGitignore(projectRoot: string, entry: string): void {
  const gitignorePath = join(projectRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.split("\n").some((line) => line.trim() === entry)) {
      writeFileSync(gitignorePath, content.endsWith("\n") ? content + entry + "\n" : content + "\n" + entry + "\n");
    }
  } else {
    writeFileSync(gitignorePath, entry + "\n");
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function collectRouterInfo(): Promise<Omit<CollectedData, "createIdentity" | "identityId" | "role" | "allowedRouters" | "allowedToolPatterns" | "rawToken" | "tokenHash" | "writeEnv" | "writeRoutersYaml" | "writeIdentitiesYaml" | "registerClaudeDesktop">> {
  console.log(chalk.bold("\n── Router configuration ──────────────────────────────────────────"));

  const routerId = await input({
    message: "Router ID (e.g. core-01):",
    validate: validateRouterId,
  });

  const host = await input({
    message: "Host / IP (e.g. 192.168.1.1):",
    validate: (v) => v.trim().length > 0 ? true : "Host is required",
  });

  const portStr = await input({
    message: "Port:",
    default: "80",
    validate: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 65535 ? true : "Port must be 1–65535";
    },
  });
  const port = Number(portStr);

  const tlsEnabled = await confirm({ message: "Enable TLS?", default: false });

  let rejectUnauthorized = true;
  if (tlsEnabled) {
    rejectUnauthorized = await confirm({
      message: "Reject unauthorized TLS certificates (rejectUnauthorized)?",
      default: true,
    });
    if (!rejectUnauthorized) {
      console.log(
        chalk.yellow(
          "  ⚠  Warning: TLS certificate validation is DISABLED. " +
            "Consider setting tls.fingerprint to pin the server certificate.",
        ),
      );
    }
  }

  const suggestedPrefix = suggestEnvPrefix(routerId);
  const envPrefix = await input({
    message: "Credential env prefix:",
    default: suggestedPrefix,
    validate: (v) => v.trim().length > 0 ? true : "Env prefix is required",
  });

  const tagsRaw = await input({
    message: "Tags (comma-separated, optional):",
    default: "",
  });
  const tags = splitTags(tagsRaw);

  const rosVersion = await input({
    message: "RouterOS version:",
    default: "7",
    validate: (v) => v.trim().length > 0 ? true : "Version is required",
  });

  return { routerId, host, port, tlsEnabled, rejectUnauthorized, envPrefix, tags, rosVersion };
}

async function collectIdentityInfo(): Promise<{
  createIdentity: boolean;
  identityId: string;
  role: string;
  allowedRouters: string;
  allowedToolPatterns: string;
  rawToken: string;
  tokenHash: string;
}> {
  console.log(chalk.bold("\n── Identity / HTTP transport ────────────────────────────────────"));

  const createIdentity = await confirm({
    message: "Create an identity for HTTP transport?",
    default: false,
  });

  if (!createIdentity) {
    return {
      createIdentity: false,
      identityId: "",
      role: "",
      allowedRouters: "",
      allowedToolPatterns: "",
      rawToken: "",
      tokenHash: "",
    };
  }

  const identityId = await input({
    message: "Identity ID (e.g. claude):",
    validate: (v) => v.trim().length > 0 ? true : "Identity ID is required",
  });

  const role = await select({
    message: "Role:",
    choices: [
      { value: "superadmin", name: "superadmin" },
      { value: "admin", name: "admin" },
      { value: "operator", name: "operator (default)" },
      { value: "readonly", name: "readonly" },
    ],
    default: "operator",
  });

  const allowedRouters = await input({
    message: "Allowed routers (comma-separated or * for all):",
    default: "*",
  });

  const allowedToolPatterns = await input({
    message: "Allowed tool patterns (comma-separated or * for all):",
    default: "*",
  });

  const rawToken = randomBytes(32).toString("hex");
  console.log(chalk.green(`\n  Generated token: ${chalk.bold(rawToken)}`));
  console.log(chalk.yellow("  ⚠  Save this token — it will NOT be shown again.\n"));

  const tokenHash = await bcrypt.hash(rawToken, 12);

  return {
    createIdentity: true,
    identityId,
    role,
    allowedRouters,
    allowedToolPatterns,
    rawToken,
    tokenHash,
  };
}

async function collectEnvPreference(_data: Partial<CollectedData>): Promise<boolean> {
  console.log(chalk.bold("\n── Environment file ─────────────────────────────────────────────"));
  return confirm({ message: "Write env vars to .env?", default: true });
}

async function collectClaudeDesktopPreference(): Promise<boolean> {
  console.log(chalk.bold("\n── Claude Desktop integration ───────────────────────────────────"));
  return confirm({ message: "Register with Claude Desktop?", default: true });
}

// ---------------------------------------------------------------------------
// Write actions
// ---------------------------------------------------------------------------

function writeRoutersYaml(data: CollectedData, configDir: string): boolean {
  const filePath = join(configDir, "routers.yaml");

  const newEntry: RouterYamlEntry = {
    host: data.host,
    port: data.port,
    tls: {
      enabled: data.tlsEnabled,
      rejectUnauthorized: data.rejectUnauthorized,
    },
    credentials: {
      source: "env",
      envPrefix: data.envPrefix,
    },
    tags: data.tags,
    rosVersion: data.rosVersion,
  };

  let parsed: RoutersYaml = { routers: {} };

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf-8");
    parsed = (yamlParse(raw) as RoutersYaml) ?? { routers: {} };
    if (!parsed.routers) parsed.routers = {};
  }

  parsed.routers[data.routerId] = newEntry;

  mkdirSync(configDir, { recursive: true });
  writeFileSync(filePath, yamlStringify(parsed, { lineWidth: 0 }));
  return true;
}

function writeIdentitiesYaml(data: CollectedData, configDir: string): boolean {
  const filePath = join(configDir, "identities.yaml");

  const newEntry: IdentityYamlEntry = {
    token: data.tokenHash,
    role: data.role,
    allowedRouters: data.allowedRouters === "*" ? ["*"] : data.allowedRouters.split(",").map((s) => s.trim()),
    allowedToolPatterns: data.allowedToolPatterns === "*" ? ["*"] : data.allowedToolPatterns.split(",").map((s) => s.trim()),
  };

  let parsed: IdentitiesYaml = { identities: {} };

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf-8");
    parsed = (yamlParse(raw) as IdentitiesYaml) ?? { identities: {} };
    if (!parsed.identities) parsed.identities = {};
  }

  parsed.identities[data.identityId] = newEntry;

  mkdirSync(configDir, { recursive: true });
  writeFileSync(filePath, yamlStringify(parsed, { lineWidth: 0 }));
  return true;
}

function writeDotEnv(data: CollectedData, projectRoot: string): void {
  const envPath = join(projectRoot, ".env");

  const lines: string[] = [];
  lines.push(`ROUTER_${data.envPrefix.replace(/^ROUTER_/, "")}_USER=`);
  lines.push(`ROUTER_${data.envPrefix.replace(/^ROUTER_/, "")}_PASS=`);

  // Normalise: if envPrefix already starts with ROUTER_ these would double;
  // instead derive consistently from envPrefix itself.
  const userKey = `${data.envPrefix}_USER`;
  const passKey = `${data.envPrefix}_PASS`;

  if (data.createIdentity) {
    lines.push("MIKROMCP_TRANSPORT=http");
    lines.push("MIKROMCP_CONFIRMATION_SECRET=");
  }

  const block = [`${userKey}=`, `${passKey}=`, ...(data.createIdentity ? ["MIKROMCP_TRANSPORT=http", "MIKROMCP_CONFIRMATION_SECRET="] : [])].join("\n") + "\n";

  if (existsSync(envPath)) {
    const existing = readFileSync(envPath, "utf-8");
    writeFileSync(envPath, existing.endsWith("\n") ? existing + block : existing + "\n" + block);
  } else {
    writeFileSync(envPath, block);
  }

  appendToGitignore(projectRoot, ".env");
  console.log(chalk.dim(`  Edit .env and fill in your router credentials`));
}

function registerClaudeDesktop(_projectRoot: string): { registered: boolean; snippet?: string } {
  const configPath = findClaudeDesktopConfig();

  const entry = {
    command: "mikromcp",
    args: ["serve"],
  };

  if (!configPath) {
    const snippet = JSON.stringify({ mcpServers: { "mikrotik-mcp-server": entry } }, null, 2);
    console.log(
      chalk.yellow(
        "\n  Could not find Claude Desktop config file. Add the following to your claude_desktop_config.json:\n",
      ),
    );
    console.log(chalk.dim(snippet));
    return { registered: false, snippet };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.backup-${timestamp}`;
  copyFileSync(configPath, backupPath);

  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as Record<string, unknown>;

  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }
  (config.mcpServers as Record<string, unknown>)["mikrotik-mcp-server"] = entry;

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(chalk.dim(`  Backed up to ${backupPath}`));
  console.log(chalk.dim("  Restart Claude to apply."));

  return { registered: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runInit(): Promise<void> {
  console.log(chalk.bold.cyan("\n🔧  MikroMCP — Interactive Setup Wizard\n"));

  const projectRoot = process.cwd();
  const configDir = join(projectRoot, "config");

  // Step 1: router config
  const routerInfo = await collectRouterInfo();

  // Step 2: identity
  const identityInfo = await collectIdentityInfo();

  // Step 3: .env
  const writeEnv = await collectEnvPreference({ ...routerInfo, ...identityInfo });

  // Step 4: confirm routers.yaml write
  let writeRouters = true;
  const routersYamlPath = join(configDir, "routers.yaml");
  if (existsSync(routersYamlPath)) {
    console.log(chalk.bold("\n── Config files ─────────────────────────────────────────────────"));
    writeRouters = await confirm({
      message: "config/routers.yaml already exists. Add this router to it?",
      default: true,
    });
  }

  // Step 5: Claude Desktop
  const registerDesktop = await collectClaudeDesktopPreference();

  // Assemble full data object
  const data: CollectedData = {
    ...routerInfo,
    ...identityInfo,
    writeEnv,
    writeRoutersYaml: writeRouters,
    writeIdentitiesYaml: identityInfo.createIdentity,
    registerClaudeDesktop: registerDesktop,
  };

  console.log(chalk.bold("\n── Writing files ────────────────────────────────────────────────"));

  const summary: string[] = [];

  // Write routers.yaml
  if (data.writeRoutersYaml) {
    writeRoutersYaml(data, configDir);
    summary.push(`config/routers.yaml updated`);
    console.log(chalk.green("  ✔  config/routers.yaml written"));
  }

  // Write identities.yaml
  if (data.writeIdentitiesYaml) {
    writeIdentitiesYaml(data, configDir);
    summary.push(`config/identities.yaml updated`);
    console.log(chalk.green("  ✔  config/identities.yaml written"));
  }

  // Write .env
  if (data.writeEnv) {
    writeDotEnv(data, projectRoot);
    summary.push(`.env created (fill in ${data.envPrefix}_USER and ${data.envPrefix}_PASS)`);
    console.log(chalk.green("  ✔  .env written"));
  }

  // Register Claude Desktop
  let desktopRegistered = false;
  if (data.registerClaudeDesktop) {
    const result = registerClaudeDesktop(projectRoot);
    desktopRegistered = result.registered;
    if (desktopRegistered) {
      summary.push("Claude Desktop registered");
      console.log(chalk.green("  ✔  Claude Desktop registered"));
    }
  }

  // Final summary
  console.log(chalk.bold.cyan("\n✅  Setup complete!\n"));
  for (const item of summary) {
    console.log(chalk.green(`  ✅  ${item}`));
  }
  if (data.createIdentity && data.rawToken) {
    console.log(chalk.bold.yellow(`  ✅  Bearer token: ${data.rawToken} (save this — it won't be shown again)`));
  }

  console.log(chalk.bold("\nNext steps:"));
  console.log(chalk.dim(`  1. Edit .env and fill in router credentials`));
  console.log(chalk.dim("  2. Run: npm start"));
  console.log(chalk.dim("  3. Verify: mikromcp doctor"));
  console.log();
}
