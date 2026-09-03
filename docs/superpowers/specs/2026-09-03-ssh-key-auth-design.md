# Separate SSH Key Authentication Design

## Goal

Allow MikroMCP to keep using the existing RouterOS REST username and password
while SSH-backed commands and SFTP uploads authenticate with a separate
username and private key.

## Approved outcome

- REST authentication remains `mcp-api` plus a per-router password.
- SSH authentication can use a dedicated username and an absolute private-key
  path.
- Operators can keep RouterOS SSH password authentication disabled after they
  verify key access.
- Existing installations that omit the new SSH fields keep password-based SSH
  behavior for backward compatibility.

## Configuration contract

Router entries gain two optional fields:

```yaml
sshUsername: "admin"
sshPrivateKeyPath: "/absolute/path/to/private-key"
```

`sshUsername` overrides the username for SSH and SFTP. `sshPrivateKeyPath`
selects public-key authentication for both clients. When the key path is
present, MikroMCP must not send the REST password to either client. Relative
paths and tilde expansion are not part of this change; deployments use an
absolute path.

If `sshPrivateKeyPath` is absent, MikroMCP retains the current behavior and uses
the resolved REST username and password for SSH and SFTP. The plaintext FTP
fallback continues to use REST credentials.

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
4. Ensure each router has a dedicated REST credential without printing its
   password.
5. Install the tested package.
6. Verify REST and SSH-backed reads on each router.
7. Disable SSH password authentication after key authentication passes, then
   verify key access again.

## Rollback

- Restore the backed-up registry and environment file.
- Reinstall MikroMCP 1.10.0 from the unchanged `main` checkout.
- If the final hardening step causes access loss, use the open key-authenticated
  session to restore the previous SSH setting.
