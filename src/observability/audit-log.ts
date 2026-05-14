import { appendFileSync } from "node:fs";
import { createLogger } from "./logger.js";
import type { AuditEvent } from "../types.js";

const log = createLogger("audit");

const SENSITIVE_KEYS = new Set(["password", "token", "secret", "authorization", "credentials"]);

export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redactParams(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const auditFilePath = process.env.MIKROMCP_AUDIT_LOG_PATH || undefined;

export function auditLog(event: AuditEvent): void {
  const safeEvent = { ...event, params: redactParams(event.params) };

  log.info(safeEvent, "audit");

  if (auditFilePath) {
    try {
      appendFileSync(auditFilePath, JSON.stringify(safeEvent) + "\n");
    } catch (err) {
      log.error({ err, auditFilePath }, "Failed to write audit event to file");
    }
  }
}
