// Waits for the CHR container to answer the REST API, and on a fresh boot sets
// the admin password (MikroMCP's credential layer rejects empty passwords, so
// CHR's factory-default `admin` with no password is unusable until this runs).

import { chrConnection, pairConnection, pairEnabled } from "./helpers/targets.js";
import type { ChrEndpoint } from "./helpers/targets.js";

const READY_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 3_000;

type ProbeResult = "ready" | "unauthorized" | "down";

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

async function probe(target: ChrEndpoint, auth: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`http://${target.host}:${target.httpPort}/rest/system/resource`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return "ready";
    if (res.status === 401) return "unauthorized";
    return "down";
  } catch {
    return "down";
  }
}

async function setAdminPassword(target: ChrEndpoint): Promise<void> {
  const auth = basicAuth("admin", "");
  const usersRes = await fetch(`http://${target.host}:${target.httpPort}/rest/user`, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(10_000),
  });
  if (!usersRes.ok) {
    throw new Error(`Listing users failed: HTTP ${usersRes.status}`);
  }
  const users = (await usersRes.json()) as Array<Record<string, string>>;
  const admin = users.find((u) => u.name === "admin");
  if (!admin) {
    throw new Error("No admin user found on the CHR instance.");
  }

  // RouterOS closes the HTTP session when the authenticated user's own
  // password changes, answering 400 "Session closed" even though the change
  // applied — so the status code is meaningless here. The caller verifies by
  // probing with the new password.
  await fetch(
    `http://${target.host}:${target.httpPort}/rest/user/${encodeURIComponent(admin[".id"])}`,
    {
      method: "PATCH",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ password: target.password }),
      signal: AbortSignal.timeout(10_000),
    },
  ).catch(() => undefined);
}

/**
 * RouterOS 7.16+ has no OVPN server until an instance is added. Create a
 * disabled one so `get_ovpn_server` and the enable/disable lifecycle have a
 * record to work against.
 */
async function ensureOvpnServerInstance(target: ChrEndpoint): Promise<void> {
  const auth = basicAuth("admin", target.password);
  const base = `http://${target.host}:${target.httpPort}/rest/interface/ovpn-server/server`;
  const res = await fetch(base, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return;
  const records = (await res.json()) as unknown;
  if (Array.isArray(records) && records.length === 0) {
    await fetch(base, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ovpn-itest", disabled: "yes" }),
      signal: AbortSignal.timeout(10_000),
    });
  }
}

async function provisionTarget(target: ChrEndpoint): Promise<ProbeResult> {
  const provisionedAuth = basicAuth("admin", target.password);

  const provisioned = await probe(target, provisionedAuth);
  if (provisioned === "ready") {
    await ensureOvpnServerInstance(target);
    return "ready";
  }
  const factory = await probe(target, basicAuth("admin", ""));
  if (factory === "ready") {
    await setAdminPassword(target);
    if ((await probe(target, provisionedAuth)) === "ready") {
      await ensureOvpnServerInstance(target);
      return "ready";
    }
  }
  // Both credentials rejected: the router is up but was provisioned with a
  // different password — distinguish that from a container that is not up yet.
  return provisioned === "unauthorized" && factory === "unauthorized" ? "unauthorized" : "down";
}

export default async function globalSetup(): Promise<void> {
  const targets: ChrEndpoint[] = [chrConnection, ...(pairEnabled ? [pairConnection] : [])];
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const status: ProbeResult[] = targets.map(() => "down");

  while (Date.now() < deadline && status.some((s) => s !== "ready")) {
    await Promise.all(
      targets.map(async (target, i) => {
        if (status[i] === "ready") return;
        // A transient provisioning failure (user DB not up yet, timed-out
        // fetch) means "not ready yet", not "abort the whole run".
        status[i] = await provisionTarget(target).catch((err: unknown): ProbeResult => {
          // Log provisioning errors for troubleshooting (e.g., network issues,
          // container not running), but don't fail immediately — the CHR may
          // still be booting and these errors are expected during startup.
          if (process.env.MIKROMCP_LOG_LEVEL === "debug") {
            const endpoint = `http://${target.host}:${target.httpPort}`;
            console.debug(
              `[global-setup] Provisioning ${endpoint} failed (will retry):`,
              err instanceof Error ? err.message : String(err),
            );
          }
          return "down";
        });
      }),
    );
    if (status.some((s) => s !== "ready")) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  const failed = targets
    .map((t, i) => ({ target: t, status: status[i] }))
    .filter((f) => f.status !== "ready");
  if (failed.length > 0) {
    const lines = failed.map(({ target, status: s }) => {
      const endpoint = `http://${target.host}:${target.httpPort}/rest`;
      return s === "unauthorized"
        ? `${endpoint} is up but rejects both the factory-default and configured credentials — ` +
            "its admin password differs from MIKROMCP_ITEST_PASSWORD (likely a reused container); " +
            "recreate the container or set MIKROMCP_ITEST_PASSWORD to match."
        : `${endpoint} did not answer — start it with: docker compose -f docker-compose.test.yml up -d` +
            (pairEnabled ? " --profile pair" : "");
    });
    throw new Error(
      `RouterOS CHR not ready within ${READY_TIMEOUT_MS / 1000}s:\n${lines.join("\n")}`,
    );
  }
}
