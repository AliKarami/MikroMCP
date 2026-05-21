import { appendFile } from "node:fs/promises";
import { createLogger } from "./logger.js";
import type { AuditEvent } from "../types.js";

const log = createLogger("audit");

const SENSITIVE_KEYS = new Set([
  "password",
  "pass",
  "token",
  "secret",
  "authorization",
  "credentials",
  "privatekey",
  "presharedkey",
  "psk",
  "passphrase",
  "community",
  "apikey",
  "confirmationsecret",
]);

export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redactParams(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function auditLog(event: AuditEvent, auditLogPath?: string): void {
  const safeEvent = { ...event, params: redactParams(event.params) };
  log.info(safeEvent, "audit");
  if (auditLogPath) {
    appendFile(auditLogPath, JSON.stringify(safeEvent) + "\n").catch((err) => {
      log.error({ err, auditLogPath }, "Failed to write audit event to file");
    });
  }
}
