# Separate SSH Key Authentication Design

## Goal

Allow MikroMCP to keep using the existing RouterOS REST username and password
while SSH-backed tools authenticate with a separate username and private key.
Register both home routers without enabling SSH password authentication.

## Approved outcome

- REST authentication remains `mcp-api` plus a per-router password.
- SSH authentication uses user `admin` and `/home/anmax/.ssh/id_sel`.
- RouterOS SSH password authentication stays disabled on HMaster and is disabled
  on HSlave only after key access is positively verified.
- HMaster and HSlave are both present in the MikroMCP router registry.
- Existing installations that omit the new SSH fields keep password-based SSH
  behavior for backward compatibility.

## Configuration contract

Router entries gain two optional fields:

```yaml
sshUsername: "admin"
sshPrivateKeyPath: "/absolute/path/to/private-key"
```

`sshUsername` overrides only the SSH username. `sshPrivateKeyPath` selects
public-key authentication for SSH-backed tools. When the key path is present,
MikroMCP must not send the REST password to the SSH server. Relative paths and
tilde expansion are not part of this change; deployments use an absolute path.

If `sshPrivateKeyPath` is absent, MikroMCP retains the current behavior and uses
the resolved REST username and password for SSH.

## Security boundaries

- Private-key contents are read locally and passed directly to the SSH client.
- Private-key contents are never returned by `list_routers` and never logged.
- The configuration stores only a filesystem path, not key material.
- Existing SSH host-key fingerprint verification remains applicable.
- No RouterOS service is exposed to a wider source range by this change.
- No inline private key or key passphrase setting is introduced.

## Live rollout

1. Build and test the patched MikroMCP in an isolated worktree.
2. Back up the active registry and environment file with their current modes.
3. Add separate SSH settings and host-key fingerprints for both routers.
4. Ensure HSlave has a dedicated `mcp-api` REST credential without printing the
   generated password.
5. Install the tested package into the existing npm-global location.
6. Verify REST and SSH-backed reads independently on HMaster, then HSlave.
7. Disable SSH password authentication on HSlave after key authentication has
   passed, and verify key access again.

## Rollback

- Restore the backed-up registry and environment file.
- Reinstall MikroMCP 1.10.0 from the unchanged `main` checkout.
- If the final HSlave hardening step causes unexpected access loss, use the
  already-open key-authenticated session to restore its previous SSH setting.
