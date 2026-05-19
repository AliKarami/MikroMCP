# Getting Started with MikroMCP

## Overview

MikroMCP is a [Model Context Protocol](https://modelcontextprotocol.io) server that connects AI assistants like Claude, Cursor, and Codex directly to your MikroTik RouterOS infrastructure. Instead of copying CLI snippets from chat into a terminal, your AI assistant calls typed, validated tools that talk to the router's REST API — with dry-run previews, idempotency checks, and audit logs built in.

This guide takes you from zero to a working AI ↔ router connection. You will need about 15 minutes and shell access to your router.

---

## Prerequisites

- **MikroTik router running RouterOS 7.x** (the REST API requires ROS 7)
- **Node.js 22 or newer** — download from [nodejs.org](https://nodejs.org)
- **An AI assistant**: Claude Desktop, Claude Code, Cursor, or Codex

---

## Step 1 — Enable the RouterOS REST API

The REST API must be enabled on your router before MikroMCP can connect. See [RouterOS-API-Setup.md](RouterOS-API-Setup.md) for the full walkthrough including TLS, firewall rules, and user policies.

Quick version using the RouterOS CLI:

```
/ip service enable api-ssl
/ip service set api-ssl port=443
```

Then create a dedicated API user (never use `admin` for automation):

```
/user add name=mcp-api group=full password=choose-a-strong-password
```

For a read-only setup (list/inspect tools only), use `group=read` instead.

---

## Step 2 — Install MikroMCP

### Option A: npm (recommended)

```bash
npm install -g mikromcp
```

After installation, `mikromcp` is available as a global command.

### Option B: Clone from source

```bash
git clone https://github.com/AliKarami/MikroMCP.git
cd MikroMCP
npm install
npm run build
```

With the source install, replace `mikromcp` with `node /path/to/MikroMCP/dist/main.js` in all commands below.

---

## Step 3 — Configure Your Router

Create the configuration file that tells MikroMCP how to reach your router:

```bash
# If you cloned from source:
cp config/routers.example.yaml config/routers.yaml

# If you installed via npm, create config/routers.yaml in your working directory:
mkdir -p config
```

Edit `config/routers.yaml`:

```yaml
routers:
  core-01:
    host: "10.0.0.1"        # your router's IP address
    port: 443                 # api-ssl port (default 443)
    tls:
      enabled: true
      rejectUnauthorized: false   # set true once you have a valid cert or fingerprint
    credentials:
      source: "env"
      envPrefix: "ROUTER_CORE01"  # env vars: ROUTER_CORE01_USER / ROUTER_CORE01_PASS
    tags: ["core"]
    rosVersion: "7.14"
```

Set your credentials as environment variables. The easiest way is a `.env` file:

```bash
# .env
ROUTER_CORE01_USER=mcp-api
ROUTER_CORE01_PASS=choose-a-strong-password
```

Load it before starting MikroMCP:

```bash
export $(grep -v '^#' .env | xargs)
```

---

## Step 4 — Verify Your Connection

Test that MikroMCP can reach the router:

```bash
# stdio mode — start the server and check it loads without errors
MIKROMCP_LOG_LEVEL=debug node dist/main.js 2>&1 | head -20
```

Or send a direct test using the RouterOS REST API:

```bash
curl -sk https://10.0.0.1/rest/system/resource \
  --user mcp-api:your-password | python3 -m json.tool
```

If this returns router resource data (uptime, CPU, memory), MikroMCP will be able to connect.

**Common issues:**

| Symptom | Cause | Fix |
|---|---|---|
| `Connection refused` | REST API not enabled or wrong port | Run `/ip service print` on the router; enable `api-ssl` |
| `SSL handshake failed` | TLS mismatch | Set `rejectUnauthorized: false` in `routers.yaml` for self-signed certs |
| `401 Unauthorized` | Wrong credentials | Double-check `ROUTER_CORE01_USER` and `ROUTER_CORE01_PASS` |
| `403 Forbidden` | User lacks `rest-api` policy | See [RouterOS-API-Setup.md](RouterOS-API-Setup.md) — required policies table |

---

## Step 5 — Connect to Your AI Assistant

- **Claude Desktop** → see [Connecting-to-Claude-Desktop.md](Connecting-to-Claude-Desktop.md)
- **Claude Code (CLI)** → see [Connecting-to-AI-Assistants.md](Connecting-to-AI-Assistants.md#claude-code-cli)
- **Cursor** → see [Connecting-to-AI-Assistants.md](Connecting-to-AI-Assistants.md#cursor)
- **Codex** → see [Connecting-to-AI-Assistants.md](Connecting-to-AI-Assistants.md#codex)
- **Remote / Docker / service deployment** → see [Connecting-to-AI-Assistants.md](Connecting-to-AI-Assistants.md#generic-http-transport-for-remoteservice-deployments)

---

## Step 6 — Try It Out

Once connected, paste these prompts into your AI assistant to confirm everything works:

```
List all interfaces on my router
```

```
Show me the firewall rules on core-01
```

```
What's the CPU and memory usage right now?
```

```
Are there any active DHCP leases?
```

```
Ping 8.8.8.8 from core-01 and tell me the round-trip time
```

You should see the assistant call MikroMCP tools and return real data from your router. Each tool call appears in the assistant's tool-use panel so you can see exactly what was sent.

---

## Troubleshooting

**"Connection refused" on port 443**
The RouterOS REST API (api-ssl) is not running, or a firewall is blocking the port. On the router: `/ip service print` — confirm `api-ssl` shows `enabled`. Add a firewall rule if MikroMCP runs on a separate host; see [RouterOS-API-Setup.md](RouterOS-API-Setup.md#firewall--allow-api-access).

**"Authentication failed" / 401**
Check that `ROUTER_CORE01_USER` and `ROUTER_CORE01_PASS` are exported in the environment where MikroMCP runs. Variable names must match the `envPrefix` in `routers.yaml` — prefix `ROUTER_CORE01` → variables `ROUTER_CORE01_USER` and `ROUTER_CORE01_PASS`.

**"Router not found"**
The `routerId` you used in the prompt (`core-01`) does not match a key in `routers.yaml`. Router IDs are case-sensitive.

**"Permission denied" / 403**
The RouterOS user lacks the `rest-api` policy, or the specific tool requires additional policies (e.g. `write`, `test`, `ssh`). See the [Required Policies table](RouterOS-API-Setup.md#required-policies-by-tool-category) in RouterOS-API-Setup.md.

**Tools not appearing in the assistant**
The MCP server did not register successfully. Check the server logs for startup errors. For Claude Desktop, make sure you fully quit and reopened the app after editing the config — `Cmd+Q` on macOS, not just closing the window.
