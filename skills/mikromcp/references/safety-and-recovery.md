# Safety & recovery

## The change lifecycle

1. **Inspect** with a `list_*`/`get_*` tool.
2. **Dry-run** the `manage_*` tool with `dryRun: true`. The result's
   `structuredContent.action` is `dry_run` and includes a `diff`.
3. **Confirm if required** (destructive tools): the first real call returns an
   `APPROVAL_REQUIRED` error carrying a `confirmationToken`. Re-issue the same
   call with that `confirmationToken`. Tokens are HMAC-signed and scoped to the
   tool+router+args; they are required in HTTP mode and for non-admin identities.
4. **Apply** and read the `action`: `created`, `updated`, or `removed`.

## Idempotency outcomes (all are SUCCESS unless noted)

| `action` | Meaning | What to do |
|---|---|---|
| `created` / `updated` / `removed` | The change was applied | Note the journal ID |
| `already_exists` | Identical resource already present | Nothing — desired state reached |
| `no_change` | Update requested but nothing differed | Nothing |
| `dry_run` | Preview only | Review `diff`, then apply for real |
| `CONFLICT` (error) | Resource exists with DIFFERENT config | Decide: remove existing first, or change your request. See the error's `details` (existing vs requested) and `alternativeTools` |

## Rollback

Write tools take a config snapshot and write a journal entry before applying.
- Find the journal ID in the apply result or the server's write journal.
- Undo with `rollback_change` (`dryRun: true` first to preview the restore plan).
- Requires `MIKROMCP_DATA_DIR` (defaults to `~/.mikromcp/data`).

## Circuit breaker & retries

- Each router has a circuit breaker. After repeated failures it "opens"
  (`CIRCUIT_OPEN`) and rejects calls until a cooldown elapses — wait and retry.
- Read tools auto-retry with backoff; write tools do not (to avoid duplicate
  side effects).

## Error → action table

| Category / code | Meaning | Next step |
|---|---|---|
| `VALIDATION` / `MISSING_ROUTER_ID` | Bad params, or no router resolved | Fix params; provide `routerId` or set `MIKROMCP_DEFAULT_ROUTER` |
| `NOT_FOUND` | Target resource/router absent | Verify with the matching `list_*`; check the id/name |
| `CONFLICT` | Exists with different config | Remove-then-recreate, or adjust the request (see above) |
| `PERMISSION_DENIED` | Identity lacks rights, or outside maintenance window | Use an allowed identity; wait for the window; check `details` |
| `APPROVAL_REQUIRED` | Destructive op needs confirmation | Re-issue with the returned `confirmationToken` |
| `ROUTER_UNREACHABLE` | Network/TLS failure to the router | Check host/port/TLS in `routers.yaml`; verify the router is up |
| `ROUTER_AUTH_FAILED` | Bad credentials | Fix `ROUTER_<PREFIX>_USER`/`_PASS`; pooled client is evicted automatically |
| `ROUTER_TIMEOUT` | Router too slow to respond | Retry; check router load |
| `ROUTER_ERROR` | RouterOS rejected the request | Read the message; verify the operation is valid for this ROS version |
| `ROUTER_BUSY` / `CIRCUIT_OPEN` | Breaker open after failures | Wait for cooldown, then retry |
| `INTERNAL` | Unexpected server error | Check server logs; not user-fixable |
| `CONFIGURATION` | Server misconfigured at startup | Fix `routers.yaml` / env vars |
