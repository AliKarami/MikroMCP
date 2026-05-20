# Error Handling

## Error Categories

Every error MikroMCP returns includes a machine-readable `category`, `code`, and `recoverability` block:

| Category | When it appears |
|---|---|
| `VALIDATION` | Invalid input parameters (Zod schema rejection) |
| `NOT_FOUND` | Resource does not exist on the router |
| `CONFLICT` | Resource exists but with different configuration |
| `ROUTER_UNREACHABLE` | Network connectivity failure |
| `ROUTER_AUTH_FAILED` | Bad credentials or insufficient RouterOS policy |
| `ROUTER_TIMEOUT` | Request timed out |
| `ROUTER_BUSY` | Circuit breaker is open — router is being protected |
| `CONFIGURATION` | Missing or invalid server configuration |
| `MAINTENANCE_WINDOW` | Write tool called outside a declared maintenance window |

## Error Response Shape

```json
{
  "category": "CONFLICT",
  "code": "ROUTE_CONFLICT",
  "message": "Route 10.0.0.0/8 via 192.168.1.1 already exists with distance=5. Requested distance=1.",
  "details": {
    "existing": { "distance": "5", "disabled": "false" },
    "requested": { "distance": "1", "disabled": "false" }
  },
  "recoverability": {
    "retryable": false,
    "suggestedAction": "Remove the existing route first, or use manage_route with action=remove before re-adding.",
    "alternativeTools": ["manage_route with action=remove"]
  }
}
```

Retryable errors include a `retryAfterMs` hint. The AI assistant uses the `suggestedAction` and `alternativeTools` fields to decide what to try next without user input.

---

## Retry Engine

Read-only tools automatically retry on transient network errors (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`) and HTTP 5xx responses.

Backoff formula: `min(baseDelay × 2^attempt + jitter, maxDelay)`

Defaults: 3 attempts, 200 ms base delay, 5 s cap.

Write tools skip the retry layer to prevent double-firing a partial write.

---

## Circuit Breaker

Per-router, three-state (closed → open → half-open):

| State | Behaviour |
|---|---|
| **Closed** (normal) | All requests pass through |
| **Open** (tripped) | All requests fail immediately with `ROUTER_BUSY`; no traffic sent to the router |
| **Half-open** (probing) | After 30 s cooldown, one probe request is allowed through |

The breaker opens after 5 consecutive failures. It closes on the first successful probe. `VALIDATION`, `NOT_FOUND`, and `CONFLICT` errors do not count as failures — only genuine connectivity or server errors trip it.

Each router has an independent circuit breaker — one unreachable router does not affect tools targeting other routers.

---

## Idempotency and Dry-Run

All write tools check existing state before acting and return a structured `action` field in the response:

| `action` value | Meaning |
|---|---|
| `created` / `added` | New resource was created |
| `updated` | Existing resource was modified |
| `removed` | Resource was deleted |
| `already_exists` | Resource already matches requested config — no change made |
| `no_change` | Resource already in requested state — no change made |
| `already_removed` | Resource did not exist — no change made |
| `dry_run` | `dryRun: true` was set — change was previewed but not applied |
| `would_fail` | `plan_changes` predicted this step would fail |

Use `dryRun: true` on any write tool to preview the planned change without touching the router.
