# Safety & recovery

## The change lifecycle

1. **Inspect** with a `list_*`/`get_*` tool.
2. **Dry-run** the `manage_*` tool with `dryRun: true`. The result's
   `structuredContent.action` is `dry_run` and includes a `diff`.
3. **Back up RouterOS** before the first real configuration change, following the
   backup workflow below. Backup creation itself does not need another backup.
4. **Confirm if required** (destructive tools): the first real call returns an
   `APPROVAL_REQUIRED` error carrying a `confirmationToken`. Tell the user what
   the call will change and on which router(s), then re-issue the same call with
   that `confirmationToken` once they agree — the token is not their approval. Tokens are HMAC-signed and scoped to the
   tool+router+args; `readonly` and `operator` identities need them whenever `MIKROMCP_CONFIRMATION_SECRET` is set, `admin`/`superadmin` skip per-router confirmation, and `bulk_execute` fan-outs of any write tool always need a fleet token.
5. **Apply** and read the `action`: `created`, `updated`, or `removed`.
6. **Verify** by re-reading the affected configuration and testing the intended
   function, then save and verify the post-change backup.

## RouterOS backups before and after changes

For each RouterOS router being changed:

1. Inspect `list_files` including directories and check available storage before
   choosing the backup location. If a `flash` directory is present, save inside
   it: files outside it are in RAM and lost on reboot. For devices without that
   directory, establish the device's persistent storage location instead of
   assuming a `flash/` path exists. Stop if persistence or capacity is unclear.
2. Before the first real configuration change, save an **encrypted binary system
   backup** in that persistent location. Use a unique name identifying the change,
   phase and time, such as `flash/change-<id>-pre-<timestamp>` when `flash/` is
   present; do not overwrite an earlier backup.
3. Use `list_files` on the same `routerId` to check that the exact `.backup` path
   exists in the selected location and its `size` is greater than zero. Stop
   before changing configuration if the backup cannot be created or this check
   fails. Allow for documented delayed flash writes before any planned reboot or
   power interruption; do not reboot just to test a backup.
4. After applying the change, re-read the affected settings and verify the
   intended function. Only after those checks pass, save a second encrypted
   backup in the same persistent location with a distinct `post` name and verify
   its exact path and nonzero size too.
   Report a failed post-change backup as an incomplete backup requirement.
5. Keep both files on the router and record their paths and verification results,
   without their contents or passwords. Do not download or delete them, or change
   backup retention, unless the operator explicitly authorizes that action.

`create_backup` passes `name` through to RouterOS `system/backup/save` and saves
`<name>.backup`; include the selected directory in `name`, without the extension.
See MikroTik's [Files storage details](https://manual.mikrotik.com/docs/system-information-and-utilities/files/#storage-details)
for persistent storage and delayed-write behavior. The tool does not select or
validate a persistent location for you.
Encryption requires a nonempty password; omitting it does not create an encrypted
backup. Its `password` argument is a literal value, not a secret reference. Keep
the real password out of prompts, source, examples, shell history and
model-visible tool-call arguments. Use client-side secret injection only if it
keeps the value out of conversation and tool history; MikroMCP's audit/journal
redaction does not protect client-side history. Otherwise, have the operator
create the encrypted backup directly in a trusted RouterOS UI, then verify the
file with `list_files`. Do not request a pasted password or substitute an
unencrypted backup.

File existence and size are checks that an artifact was saved, not proof it can
be restored. A binary system backup is different from `export_config`'s `.rsc`
script and the affected-path snapshots used by `rollback_change`; neither is a
substitute. The binary backup also excludes The Dude and User Manager databases,
which need their own backup mechanisms when present. Follow MikroTik's
[backup documentation](https://manual.mikrotik.com/docs/getting-started/configuration-management/backup/)
for coverage and same-device/same-version restore constraints. Restoring a binary
backup replaces configuration and reboots the router; it is a separate recovery
action, not this verification step.

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
| `APPROVAL_REQUIRED` | Destructive op or fleet write needs confirmation | Show the user the change, then re-issue with the returned `confirmationToken` |
| `ROUTER_UNREACHABLE` | Network/TLS failure to the router | Check host/port/TLS in `routers.yaml`; verify the router is up |
| `ROUTER_AUTH_FAILED` | Bad credentials | Fix `ROUTER_<PREFIX>_USER`/`_PASS`; pooled client is evicted automatically. Code `SSH_AUTH_FAILED` (message `The router rejected the SSH login`): only SSH-backed tools fail — `get_log` with `prefix: "login failure"` on that router names the user and transport; check the `ssh` policy, `/user ssh-keys` vs `/ip ssh password-authentication`, `sshPrivateKeyPath`, then restart the server. Don't invent the missing output: read the same data with REST `list_*`/`get_*` and say so. Code `SSH_HOST_KEY_MISMATCH`: the router presented a different SSH host key than `sshFingerprint` pins — a reset or re-keyed router, another device on the address, or an intercepted connection. Don't retry, and don't suggest copying `details.actual` into `routers.yaml`: give the user both fingerprints and ask them to confirm the router's key over a path they trust |
| `ROUTER_TIMEOUT` | Router too slow to respond | Retry; check router load |
| `ROUTER_ERROR` | RouterOS rejected the request | Read the message; verify the operation is valid for this ROS version |
| `ROUTER_BUSY` / `CIRCUIT_OPEN` | Breaker open after failures | Wait for cooldown, then retry |
| `INTERNAL` | Unexpected server error | Check server logs; not user-fixable |
| `CONFIGURATION` | Server misconfigured at startup | Fix `routers.yaml` / env vars |
