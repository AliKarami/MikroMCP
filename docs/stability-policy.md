# MikroMCP Stability Policy

This document defines the stability contract for MikroMCP v1.0 and later. It tells you what you can rely on across upgrades and what may change without notice.

---

## Scope

### Covered surfaces (stability guaranteed)

| Surface | Examples |
|---|---|
| **Tool names** | `list_routes`, `manage_firewall_rule`, `ping` |
| **Required input fields** | `routerId`, field names and their types as declared in each tool's Zod schema |
| **Optional input fields** (once shipped) | `dryRun`, `limit`, `filter` — their names, types, and default values |
| **`structuredContent` fields** | Top-level keys (`routerId`, `action`, `records`, etc.) and their types |
| **`action` enum values** | `"created"`, `"updated"`, `"deleted"`, `"already_exists"`, `"dry_run"` |
| **Error categories** | `ErrorCategory` values that callers are expected to handle (`NOT_FOUND`, `CONFLICT`, `VALIDATION`, `AUTH`, `NETWORK`, `CIRCUIT_OPEN`) |
| **Transport protocol** | stdio (JSON-RPC 2.0), HTTP/SSE (`POST /mcp`, `GET /mcp`) |

### Not covered (may change without notice)

- Log message text and structure (pino output format, field names)
- Internal error codes and sub-codes not documented as caller-handleable
- Circuit breaker configuration defaults and tuning
- RouterOS REST path mapping (`/ip/route`, etc.) — internal implementation detail
- The structure of `config/routers.yaml` fields not documented in README
- TypeScript types exported from `src/` — not a public API
- Metrics and observability endpoints
- Anything explicitly marked `@experimental` in a tool description (see below)

---

## Versioning

MikroMCP follows [Semantic Versioning 2.0.0](https://semver.org).

| Version bump | When it happens |
|---|---|
| **Patch** (0.0.x) | Bug fixes, performance improvements, documentation corrections, internal refactoring with no visible behavior change |
| **Minor** (0.x.0) | New tools, new optional input fields, new `structuredContent` fields, new error detail fields, new configuration options — all additive, backward compatible |
| **Major** (x.0.0) | Any breaking change to a covered surface (see below) |

---

## Breaking changes

The following are **always** breaking changes and require a major version bump:

- Removing or renaming a tool
- Removing or renaming a required input field
- Changing the type of any input field (e.g., `string` → `number`)
- Removing a `structuredContent` field that was previously present in all responses from a tool
- Changing an `action` enum value (e.g., renaming `"created"` → `"added"`)
- Removing an `ErrorCategory` value or renaming it
- Changing the HTTP transport endpoint paths (`/mcp`)
- Removing support for a transport type (stdio, HTTP/SSE)
- Tightening input validation in a way that rejects previously-valid inputs (e.g., lowering a `max` bound)

---

## Non-breaking changes

The following are **never** breaking and may ship in a minor release:

- Adding a new tool
- Adding a new optional input field (with a default value)
- Adding a new field to `structuredContent` output
- Adding a new field to error `details`
- Adding a new `action` value for a new operation type
- Adding a new `ErrorCategory`
- Relaxing input validation (e.g., raising a `max` bound, accepting a new enum value)
- Adding a new environment variable for optional configuration
- Performance improvements and retry/circuit-breaker tuning
- Improved error messages (text content is not a stable surface)

---

## Deprecation policy

1. A field or tool scheduled for removal is marked as **deprecated** in its description string in the same minor release that introduces the replacement.
2. It is **removed no sooner than the next major release** — at least one full minor cycle must pass between the deprecation notice and removal.
3. Deprecated items are listed in `CHANGELOG.md` under a `### Deprecated` heading for the minor release that introduced the deprecation.
4. Callers should migrate before the next major release. The release notes for every major version will include a migration guide covering all removed items.

---

## Experimental surface

Any tool or field whose description string contains `@experimental` is **exempt from all stability guarantees**. Experimental items may be renamed, re-schemed, or removed in any release, including patch releases. They exist to gather feedback and are not recommended for production automation until the `@experimental` tag is removed.

When an experimental item is promoted to stable it will be noted in the changelog. The `@experimental` tag will be removed from the description and the item becomes subject to the full policy above.

---

## Questions and feedback

Open an issue on [GitHub](https://github.com/AliKarami/MikroMCP/issues) if you encounter an undocumented breaking change or have questions about this policy.
