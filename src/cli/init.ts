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
  routerUser: string;
  routerPass: string;
  tags: string[];
  rosVersion: string;
  createIdentity: boolean;
  identityId: string;
  role: string;
  allowedRouters: string;
  allowedToolPatterns: string;
  rawToken: string;
  tokenHash: string;
  transport: string;
  envPath: string;
  configDir: string;
  writeEnv: boolean;
  writeRoutersYaml: boolean;
  writeIdentitiesYaml: boolean;
  registerClaudeDesktop: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mikromcpDir(): string {
  return join(homedir(), ".mikromcp");
}

function defaultAuditLogPath(): string {
  return join(mikromcpDir(), "audit.ndjson");
}

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

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function collectRouterInfo(): Promise<
  Omit<
    CollectedData,
    | "createIdentity"
    | "identityId"
    | "role"
    | "allowedRouters"
    | "allowedToolPatterns"
    | "rawToken"
    | "tokenHash"
    | "transport"
    | "envPath"
    | "configDir"
    | "writeEnv"
    | "writeRoutersYaml"
    | "writeIdentitiesYaml"
    | "registerClaudeDesktop"
  >
> {
  console.log(chalk.bold("\n── Router configuration ──────────────────────────────────────────"));

  const routerId = await input({
    message: "Router ID (e.g. core-01):",
    validate: validateRouterId,
  });

  const host = await input({
    message: "Host / IP (e.g. 192.168.88.1):",
    validate: (v) => (v.trim().length > 0 ? true : "Host is required"),
  });

  const portStr = await input({
    message: "Port:",
    default: "443",
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
    validate: (v) => (v.trim().length > 0 ? true : "Env prefix is required"),
  });

  const routerUser = await input({
    message: `Router username (${envPrefix}_USER):`,
    validate: (v) => (v.trim().length > 0 ? true : "Username is required"),
  });

  const routerPass = await input({
    message: `Router password (${envPrefix}_PASS):`,
    validate: (v) => (v.trim().length > 0 ? true : "Password is required"),
  });

  const tagsRaw = await input({
    message: "Tags (comma-separated, optional):",
    default: "",
  });
  const tags = splitTags(tagsRaw);

  const rosVersion = await input({
    message: "RouterOS version:",
    default: "7",
    validate: (v) => (v.trim().length > 0 ? true : "Version is required"),
  });

  return { routerId, host, port, tlsEnabled, rejectUnauthorized, envPrefix, routerUser, routerPass, tags, rosVersion };
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
    validate: (v) => (v.trim().length > 0 ? true : "Identity ID is required"),
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

async function collectTransport(): Promise<string> {
  console.log(chalk.bold("\n── Transport ────────────────────────────────────────────────────"));
  const transport = await select({
    message: "Transport mode:",
    choices: [
      { value: "stdio", name: "stdio  — launched by Claude Desktop or an MCP client (recommended)" },
      { value: "http", name: "http   — standalone HTTP server with bearer-token auth" },
    ],
    default: "stdio",
  });

  if (transport === "http") {
    console.log(
      chalk.yellow(
        "\n  ⚠  HTTP mode requires every request to include:\n" +
          "     Authorization: Bearer <token>\n" +
          "  Set MIKROMCP_CONFIRMATION_SECRET in ~/.mikromcp/.env and create an identity above.",
      ),
    );
  }

  return transport;
}

async function collectEnvPreference(): Promise<boolean> {
  return confirm({
    message: "Write credentials to ~/.mikromcp/.env? (No = inject env vars at runtime)",
    default: true,
  });
}

async function collectClaudeDesktopPreference(): Promise<boolean> {
  console.log(chalk.bold("\n── Claude Desktop integration ───────────────────────────────────"));
  return confirm({ message: "Register with Claude Desktop?", default: true });
}

// ---------------------------------------------------------------------------
// Write actions
// ---------------------------------------------------------------------------

function writeRoutersYaml(data: CollectedData): boolean {
  const filePath = join(data.configDir, "routers.yaml");

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

  mkdirSync(data.configDir, { recursive: true });
  writeFileSync(filePath, yamlStringify(parsed, { lineWidth: 0 }));
  return true;
}

function writeIdentitiesYaml(data: CollectedData): boolean {
  const filePath = join(data.configDir, "identities.yaml");

  const newEntry: IdentityYamlEntry = {
    token: data.tokenHash,
    role: data.role,
    allowedRouters:
      data.allowedRouters === "*" ? ["*"] : data.allowedRouters.split(",").map((s) => s.trim()),
    allowedToolPatterns:
      data.allowedToolPatterns === "*"
        ? ["*"]
        : data.allowedToolPatterns.split(",").map((s) => s.trim()),
  };

  let parsed: IdentitiesYaml = { identities: {} };

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf-8");
    parsed = (yamlParse(raw) as IdentitiesYaml) ?? { identities: {} };
    if (!parsed.identities) parsed.identities = {};
  }

  parsed.identities[data.identityId] = newEntry;

  mkdirSync(data.configDir, { recursive: true });
  writeFileSync(filePath, yamlStringify(parsed, { lineWidth: 0 }));
  return true;
}

function writeDotEnv(data: CollectedData): void {
  const userKey = `${data.envPrefix}_USER`;
  const passKey = `${data.envPrefix}_PASS`;
  const auditLogPath = defaultAuditLogPath();
  const confirmationSecret = data.transport === "http" ? randomBytes(32).toString("hex") : "";

  const lines = [
    "# ── Router credentials ───────────────────────────────────────────────",
    `${userKey}=${data.routerUser}`,
    `${passKey}=${data.routerPass}`,
    "",
    "# ── Transport ────────────────────────────────────────────────────────",
    `# stdio  → launched directly by Claude Desktop or another MCP client`,
    `# http   → standalone server mode with bearer-token auth`,
    `MIKROMCP_TRANSPORT=${data.transport}`,
    "",
    "# ── Config paths ─────────────────────────────────────────────────────",
    `MIKROMCP_CONFIG_PATH=${join(data.configDir, "routers.yaml")}`,
    `MIKROMCP_IDENTITIES_PATH=${join(data.configDir, "identities.yaml")}`,
    "",
    "# ── Logging ──────────────────────────────────────────────────────────",
    "# Levels: trace | debug | info | warn | error",
    "MIKROMCP_LOG_LEVEL=info",
    `MIKROMCP_AUDIT_LOG_PATH=${auditLogPath}`,
    "",
    "# ── HTTP transport (only used when MIKROMCP_TRANSPORT=http) ──────────",
    "MIKROMCP_PORT=3000",
    `MIKROMCP_CONFIRMATION_SECRET=${confirmationSecret}`,
    "",
    "# ── RBAC (optional, for stdio with identity enforcement) ─────────────",
    "# MIKROMCP_STDIO_IDENTITY=",
  ];

  const content = lines.join("\n") + "\n";

  mkdirSync(data.configDir, { recursive: true });

  if (existsSync(data.envPath)) {
    const existing = readFileSync(data.envPath, "utf-8");
    writeFileSync(data.envPath, existing.endsWith("\n") ? existing + "\n" + content : existing + "\n\n" + content);
  } else {
    writeFileSync(data.envPath, content);
  }

}

function registerClaudeDesktop(): { registered: boolean; snippet?: string } {
  const configPath = findClaudeDesktopConfig();

  const entry = {
    command: "mikromcp",
    args: ["serve"],
  };

  if (!configPath) {
    const snippet = JSON.stringify({ mcpServers: { mikromcp: entry } }, null, 2);
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
  (config.mcpServers as Record<string, unknown>)["mikromcp"] = entry;

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

  // Step 1: router config
  const routerInfo = await collectRouterInfo();

  // Step 2: identity
  const identityInfo = await collectIdentityInfo();

  const configDir = mikromcpDir();
  const envPath = join(configDir, ".env");

  // Step 3: transport mode
  const transport = await collectTransport();

  // Step 4: .env opt-in
  const writeEnv = await collectEnvPreference();

  // Step 5: confirm routers.yaml write when file already exists
  let writeRouters = true;
  const routersYamlPath = join(configDir, "routers.yaml");
  if (existsSync(routersYamlPath)) {
    console.log(chalk.bold("\n── Config files ─────────────────────────────────────────────────"));
    writeRouters = await confirm({
      message: "routers.yaml already exists. Add this router to it?",
      default: true,
    });
  }

  // Step 6: Claude Desktop
  const registerDesktop = await collectClaudeDesktopPreference();

  // Assemble full data object
  const data: CollectedData = {
    ...routerInfo,
    ...identityInfo,
    transport,
    envPath,
    configDir,
    writeEnv,
    writeRoutersYaml: writeRouters,
    writeIdentitiesYaml: identityInfo.createIdentity,
    registerClaudeDesktop: registerDesktop,
  };

  console.log(chalk.bold("\n── Writing files ────────────────────────────────────────────────"));

  const summary: string[] = [];

  if (data.writeRoutersYaml) {
    writeRoutersYaml(data);
    summary.push(`routers.yaml written to ${data.configDir}`);
    console.log(chalk.green(`  ✔  ${join(data.configDir, "routers.yaml")}`));
  }

  if (data.writeIdentitiesYaml) {
    writeIdentitiesYaml(data);
    summary.push(`identities.yaml written to ${data.configDir}`);
    console.log(chalk.green(`  ✔  ${join(data.configDir, "identities.yaml")}`));
  }

  if (data.writeEnv) {
    writeDotEnv(data);
    summary.push(`.env written to ${data.envPath}`);
    console.log(chalk.green(`  ✔  ${data.envPath}`));
  }

  let desktopRegistered = false;
  if (data.registerClaudeDesktop) {
    const result = registerClaudeDesktop();
    desktopRegistered = result.registered;
    if (desktopRegistered) {
      summary.push("Claude Desktop registered");
      console.log(chalk.green("  ✔  Claude Desktop registered"));
    }
  }

  console.log(chalk.bold.cyan("\n✅  Setup complete!\n"));
  for (const item of summary) {
    console.log(chalk.green(`  ✅  ${item}`));
  }
  if (data.createIdentity && data.rawToken) {
    console.log(
      chalk.bold.yellow(`  ✅  Bearer token: ${data.rawToken} (save this — it won't be shown again)`),
    );
  }

  console.log(chalk.bold("\nNext steps:"));
  console.log(chalk.dim(`  1. Fill in router credentials in ${data.envPath}`));
  console.log(chalk.dim("  2. Run: mikromcp doctor"));
  console.log(chalk.dim("  3. Restart Claude Desktop to load the MCP server"));
  console.log();
}
