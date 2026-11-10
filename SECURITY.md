# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a suspected vulnerability. Report it privately through a
[GitHub security advisory](https://github.com/AliKarami/MikroMCP/security/advisories/new) so a fix
can be prepared before details are public.

Include the affected version, the tool and parameters involved, and what an attacker gains that the
caller's identity was not already allowed to do.

## Scope

MikroMCP gives an MCP client typed, permission-checked access to RouterOS routers and SwOS switches.
Some tools are deliberately powerful: `run_command`, `run_script`, `manage_script`,
`manage_scheduled_job` and `upload_file` can run arbitrary RouterOS commands or script **on the
target router**, with the policies of the configured RouterOS user. That is their documented
purpose, not a vulnerability. They do not run anything on the machine hosting MikroMCP: SSH
commands are sent to the router over an SSH `exec` channel, and no local shell is involved.

Reports in scope include, for example:

- Running code or reading files on the **MikroMCP host**
- Bypassing `allowedRouters`, `allowedToolPatterns`, bearer-token auth, confirmation tokens or
  maintenance windows
- A read-only tool that can be made to change router state (as in the advisory fixed in 1.11, where `ping`, `traceroute` and `torch` let a parameter inject a RouterOS command)
- Credentials or configured secrets leaking into tool output, logs or the audit trail

To limit what a client can do with the powerful tools, see
[Security → Scoping arbitrary-command tools](docs/wiki/Security.md#scoping-arbitrary-command-tools).
