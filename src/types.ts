// ---------------------------------------------------------------------------
// MikroMCP - Shared type definitions
// ---------------------------------------------------------------------------

export interface MaintenanceWindow {
  days: Array<"Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun">;
  startTime: string;
  endTime: string;
  timezone: string;
}

// Device platform: RouterOS (default) or MikroTik switch firmware. "swos"
// covers both SwOS and SwOS Lite — one wire protocol, and the key dialect is
// detected per field from the device's own response.
export type DeviceType = "routeros" | "swos";

// Router configuration
export interface RouterConfig {
  id: string;
  host: string;
  port: number;
  deviceType?: DeviceType;
  tls: {
    enabled: boolean;
    rejectUnauthorized: boolean;
    ca?: string;
    fingerprint?: string;
  };
  credentials: {
    source: "env" | "vault";
    envPrefix?: string;
    vaultPath?: string;
  };
  tags: string[];
  rosVersion: string;
  sshPort?: number;
  sshFingerprint?: string;
  cmdAllow?: string[];
  cmdDeny?: string[];
  maintenanceWindows?: MaintenanceWindow[];
}

// Identity (for RBAC - simplified for v0.1)
export type Role = "readonly" | "operator" | "admin" | "superadmin";

export interface Identity {
  id: string;
  role: Role;
  allowedRouters: string[]; // empty = all (superadmin)
  allowedToolPatterns: string[];
}

// Tool framework types
export interface ToolRequest {
  tool: string;
  params: Record<string, unknown>;
  correlationId: string;
  identity: Identity;
  timestamp: string;
}

export interface DomainResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: MikroMCPErrorData;
}

export interface MikroMCPErrorData {
  category: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  recoverability: {
    retryable: boolean;
    retryAfterMs?: number;
    suggestedAction: string;
    alternativeTools?: string[];
  };
}

// RouterOS adapter types
export type RouterOSValue = string | number | boolean;

export interface RouterOSRecord {
  ".id": string;
  [key: string]: RouterOSValue;
}

export interface QueryOptions {
  filter?: Record<string, string>;
  proplist?: string[];
  limit?: number;
  offset?: number;
}

// Config diff types
export interface PropertyChange {
  property: string;
  before: string | null;
  after: string | null;
}

export interface SnapshotMeta {
  id: string;
  routerId: string;
  path: string;
  ts: string;
  filePath: string;
  recordCount: number;
}

export interface JournalEntry {
  id: string;
  ts: string;
  identityId: string;
  role: string;
  tool: string;
  routerId: string;
  params: Record<string, unknown>;
  phase: "attempt" | "success" | "failure";
  snapshotIds: string[];
  outcome?: string;
  durationMs?: number;
}

export interface RestorePlan {
  path: string;
  toCreate: RouterOSRecord[];
  toRemove: string[];
  toUpdate: Array<{ currentId: string; data: Record<string, string> }>;
  /**
   * Field values to write through `POST <path>/set`. Set-menu singletons
   * (ip/dns, system/ntp/client, container/config) carry no `.id`, so they can
   * only be restored as a whole-record write — never create/remove/update.
   */
  toSet?: Record<string, string>;
  warnings: string[];
}

export interface AuditEvent {
  type: "audit";
  ts: string;
  correlationId: string;
  identityId: string;
  role: Role;
  tool: string;
  routerId: string;
  phase: "attempt" | "success" | "failure";
  params: Record<string, unknown>;
  outcome?: string;
  durationMs?: number;
}
