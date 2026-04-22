// ---------------------------------------------------------------------------
// MikroMCP - Shared type definitions
// ---------------------------------------------------------------------------

// Router configuration
export interface RouterConfig {
  id: string;
  host: string;
  port: number;
  tls: { enabled: boolean; rejectUnauthorized: boolean; ca?: string };
  credentials: {
    source: "env" | "vault";
    envPrefix?: string;
    vaultPath?: string;
  };
  tags: string[];
  rosVersion: string;
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
export interface RouterOSRecord {
  ".id": string;
  [key: string]: string;
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

export interface ConfigSnapshot {
  id: string;
  routerId: string;
  capturedAt: string;
  sections: Record<string, ConfigSection>;
}

export interface ConfigSection {
  path: string;
  records: Array<{
    routerOsId: string;
    properties: Record<string, string>;
  }>;
}
