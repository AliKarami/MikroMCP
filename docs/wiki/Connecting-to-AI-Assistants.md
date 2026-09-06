# Connecting MikroMCP to AI Assistants

This page covers how to register MikroMCP as an MCP server in Claude Code, Cursor, Codex, and any MCP client that supports HTTP transport.

**Before you start:** Complete [Getting-Started.md](Getting-Started.md) — MikroMCP must be installed and able to reach your router before connecting it to any assistant.

For Claude Desktop specifically, see [Connecting-to-Claude-Desktop.md](Connecting-to-Claude-Desktop.md).

---

## Claude Code (CLI)

Claude Code reads MCP server registrations from its config. The easiest way to register MikroMCP is with the `claude mcp add` command.

Make sure your router credentials are already exported in the environment:

```bash
export ROUTER_CORE01_USER=mcp-api
export ROUTER_CORE01_PASS=your-router-password
export MIKROMCP_CONFIG_PATH=/absolute/path/to/config/routers.yaml
```

If RouterOS accepts SSH keys but rejects password authentication, add
`sshUsername` and an absolute `sshPrivateKeyPath` to that router's
`routers.yaml` entry. The MCP client does not need the private key in its own
configuration; the MikroMCP child process reads it locally for SSH commands and
SFTP uploads. See
[Configuration](Configuration#per-router-ssh-sftp-and-ftp).

Register MikroMCP (npm global install):

```bash
claude mcp add mikromcp -- mikromcp serve
```

Or with a source build:

```bash
claude mcp add mikromcp -- node /absolute/path/to/MikroMCP/dist/main.js
```

Verify registration:

```bash
claude mcp list
```

You should see `mikromcp` in the list. On the next `claude` session start, all 122 MikroMCP tools will be available automatically.

To pass environment variables directly in the registration (useful if you do not want to rely on shell exports):

```bash
claude mcp add mikromcp \
  -e MIKROMCP_CONFIG_PATH=/path/to/config/routers.yaml \
  -e ROUTER_CORE01_USER=mcp-api \
  -e ROUTER_CORE01_PASS=your-router-password \
  -- mikromcp serve
```

---

## Cursor

Cursor supports MCP servers via a JSON config file in your project root.

Create or edit `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "mikromcp": {
      "command": "mikromcp",
      "args": ["serve"],
      "env": {
        "MIKROMCP_CONFIG_PATH": "/absolute/path/to/config/routers.yaml",
        "ROUTER_CORE01_USER": "mcp-api",
        "ROUTER_CORE01_PASS": "your-router-password"
      }
    }
  }
}
```

For a source build, use `node /path/to/dist/main.js` as the command.

Cursor auto-detects `.cursor/mcp.json` and loads the configured servers when you open the project. You do not need to restart Cursor — open Cursor's MCP panel to confirm MikroMCP appears and shows a green connected indicator.

For user-wide registration (not per-project), edit `~/.cursor/mcp.json` with the same structure.

---

## Codex

Set the `CODEX_MCP_SERVERS` environment variable before running `codex`:

```bash
export CODEX_MCP_SERVERS='[{"name":"mikromcp","command":"mikromcp","args":["serve"]}]'
export ROUTER_CORE01_USER=mcp-api
export ROUTER_CORE01_PASS=your-router-password
export MIKROMCP_CONFIG_PATH=/path/to/config/routers.yaml
codex
```

For a source build, replace `"command":"mikromcp","args":["serve"]` with `"command":"node","args":["/path/to/dist/main.js"]`.

To avoid re-exporting on every session, add these exports to your shell profile (`.zshrc`, `.bashrc`, etc.).

---

## Generic HTTP Transport (for remote/service deployments)

The stdio transport starts MikroMCP as a child process — simple for local use, but not suitable for shared deployments or when multiple clients need to connect to one MikroMCP instance. HTTP mode runs MikroMCP as a long-lived service that clients connect to over the network.

### Start MikroMCP in HTTP mode

```bash
export MIKROMCP_TRANSPORT=http
export MIKROMCP_PORT=3000
export MIKROMCP_BIND_HOST=127.0.0.1
export MIKROMCP_CONFIRMATION_SECRET="$(openssl rand -hex 32)"
export ROUTER_CORE01_USER=mcp-api
export ROUTER_CORE01_PASS=your-router-password
mikromcp serve
```

MikroMCP listens at `http://localhost:3000/mcp`.

Every HTTP request must include a bearer token:

```
Authorization: Bearer <token>
```

Tokens are bcrypt hashes stored in the identities file (`~/.mikromcp/identities.yaml`, or the path in `MIKROMCP_IDENTITIES_PATH`). See [Configuration → Identities](Configuration#identities-http-transport) for the file format and how to generate a token.

### Configure your MCP client for HTTP

Point your client at:

```
http://localhost:3000/mcp
```

In Claude Code:

```bash
claude mcp add mikromcp \
  --transport http \
  --header "Authorization: Bearer your-token-here" \
  http://localhost:3000/mcp
```

In Cursor's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mikromcp": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

---

## Using Docker

Docker is the recommended way to run MikroMCP in HTTP mode as a persistent service.

### Quick start

```bash
docker run -d \
  --name mikromcp \
  -e MIKROMCP_TRANSPORT=http \
  -e MIKROMCP_PORT=3000 \
  -e MIKROMCP_BIND_HOST=0.0.0.0 \
  -e MIKROMCP_CONFIG_PATH=/app/config/routers.yaml \
  -e MIKROMCP_IDENTITIES_PATH=/app/config/identities.yaml \
  -e MIKROMCP_CONFIRMATION_SECRET="$(openssl rand -hex 32)" \
  -e ROUTER_CORE01_USER=mcp-api \
  -e ROUTER_CORE01_PASS=your-router-password \
  -v "$(pwd)/config:/app/config:ro" \
  -p 3000:3000 \
  ghcr.io/alikarami/mikromcp:latest
```

The image sets no default config paths, so `MIKROMCP_CONFIG_PATH` and `MIKROMCP_IDENTITIES_PATH` must point into the mounted directory — without them the container looks in `/root/.mikromcp/` and starts with an empty router registry. The directory must contain a `routers.yaml` and an `identities.yaml`: HTTP mode has no anonymous access, so at least one identity is needed before any client can connect (see [Configuration → Identities](Configuration#identities-http-transport)). The container reads router credentials from environment variables as usual.

If a router entry uses `sshPrivateKeyPath`, that path must exist inside the
container. Mount only the required private key read-only and use the container
path in `routers.yaml`, for example:

```bash
-v "$HOME/.ssh/id_ed25519:/run/secrets/mikromcp_ssh_key:ro"
```

Then set `sshPrivateKeyPath: "/run/secrets/mikromcp_ssh_key"`. Do not mount the
entire `.ssh` directory.

Once running, point your MCP client at `http://localhost:3000/mcp` (or the host IP if the client is on a different machine).

### Docker Compose

For a more manageable setup, use Docker Compose:

```bash
cp docker-compose.example.yml docker-compose.yml
cp config/routers.example.yaml config/routers.yaml
cp config/identities.example.yaml config/identities.yaml
# Edit config/routers.yaml and create a .env with MIKROMCP_CONFIRMATION_SECRET and router credentials
docker compose up -d
```

### systemd service

To run MikroMCP as a systemd service on Linux:

Create `/etc/systemd/system/mikromcp.service`:

```ini
[Unit]
Description=MikroMCP MCP Server
After=network.target

[Service]
Type=simple
User=mikromcp
EnvironmentFile=/etc/mikromcp/env
ExecStart=/usr/local/bin/mikromcp serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Create `/etc/mikromcp/env`:

```
MIKROMCP_TRANSPORT=http
MIKROMCP_PORT=3000
MIKROMCP_BIND_HOST=127.0.0.1
MIKROMCP_CONFIG_PATH=/etc/mikromcp/routers.yaml
MIKROMCP_CONFIRMATION_SECRET=your-secret-here
ROUTER_CORE01_USER=mcp-api
ROUTER_CORE01_PASS=your-router-password
```

Enable and start:

```bash
sudo systemctl enable --now mikromcp
sudo systemctl status mikromcp
```

---

## Troubleshooting

**Tools not appearing in the assistant**
The MCP server did not register or start. Verify with `claude mcp list` (Claude Code) or check the assistant's MCP panel. Confirm the command and path are correct, and that `mikromcp` is in the PATH.

**"Connection refused" in HTTP mode**
MikroMCP is not running, or it bound to a different address. Check `MIKROMCP_BIND_HOST` — `127.0.0.1` is only reachable from localhost; use `0.0.0.0` if the client is on a different host.

**"401 Unauthorized" in HTTP mode**
The bearer token in the `Authorization` header does not match any identity in the identities file (`MIKROMCP_IDENTITIES_PATH`). Identities store bcrypt hashes, so compare the raw token you send with the one you hashed — re-generate and update the file if needed.

**"Invalid identity config" at startup**
The identities file does not match the schema — the message names the offending key. Common causes are an array instead of a map, a `tokenHash` field instead of `token`, or a missing `role`. See [Configuration → Identities](Configuration#identities-http-transport) for the expected shape.

**Router errors after connecting**
MikroMCP connected successfully but the router is unreachable. See the [RouterOS API Setup](RouterOS-API-Setup.md) page and the Troubleshooting section in [Getting-Started.md](Getting-Started.md).

## Usage skill

For best results, install the MikroMCP usage skill so the assistant knows how to
drive the tools safely (dry-run → confirm → rollback, fleet ops, diagnosis). See
[Using the Skill](Using-the-Skill.md).
