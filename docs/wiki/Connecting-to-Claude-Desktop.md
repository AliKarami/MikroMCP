# Connecting MikroMCP to Claude Desktop

This page shows how to register MikroMCP as an MCP server in Claude Desktop so you can manage your MikroTik routers from the Claude chat interface.

**Before you start:** Complete [Getting-Started.md](Getting-Started.md) — MikroMCP must be installed and able to reach your router before connecting it to Claude Desktop.

---

## Prerequisites

- MikroMCP installed (npm global or source build)
- Router credentials configured in `routers.yaml` and available as environment variables
- [Claude Desktop](https://claude.ai/download) installed

---

## Manual Setup

### 1. Find your Claude Desktop config file

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

If the file does not exist, create it. If it exists and is empty, start with `{}`.

### 2. Add MikroMCP to mcpServers

#### If MikroMCP is installed globally via npm

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

Replace `/absolute/path/to/config/routers.yaml` with the actual path to your `routers.yaml` file. Router credential keys (`ROUTER_CORE01_USER`, etc.) must match the `envPrefix` values in your `routers.yaml`.

#### If MikroMCP is cloned from source

```json
{
  "mcpServers": {
    "mikromcp": {
      "command": "node",
      "args": ["/absolute/path/to/MikroMCP/dist/main.js"],
      "env": {
        "MIKROMCP_CONFIG_PATH": "/absolute/path/to/MikroMCP/config/routers.yaml",
        "ROUTER_CORE01_USER": "mcp-api",
        "ROUTER_CORE01_PASS": "your-router-password"
      }
    }
  }
}
```

Use the full path to `node` if it is not in the system PATH when Claude Desktop launches (common on macOS with nvm or asdf):

```bash
which node   # e.g. /Users/you/.nvm/versions/node/v22.11.0/bin/node
```

#### Multiple routers

Add all router credentials in the `env` block — one pair per router:

```json
"env": {
  "MIKROMCP_CONFIG_PATH": "/path/to/config/routers.yaml",
  "ROUTER_CORE01_USER": "mcp-api",
  "ROUTER_CORE01_PASS": "password-for-core01",
  "ROUTER_EDGE01_USER": "mcp-api",
  "ROUTER_EDGE01_PASS": "password-for-edge01"
}
```

### 3. Restart Claude Desktop

Claude Desktop reads the config file at startup only. You must fully quit and reopen it:

- **macOS:** `Cmd+Q` (or Claude → Quit Claude), then reopen from Applications or the Dock.
- **Windows:** Right-click the tray icon → Quit, then reopen.
- **Linux:** Kill the process, then relaunch.

Simply closing the window is not enough — the process continues running in the background.

---

## Verify the Connection

After restarting, open a new conversation in Claude Desktop and type:

```
List the interfaces on my router
```

Claude should call the `list_interfaces` tool and return real data from your router. You will see the tool call appear in the conversation — this confirms MikroMCP is registered and communicating with your router.

If you have multiple routers defined in `routers.yaml`, include the router ID in your prompt:

```
Show me the firewall rules on core-01
```

---

## Troubleshooting

**"Tool not found" or no tool calls appear**
Claude Desktop was not fully restarted after editing the config. Quit completely and reopen. Also confirm the JSON in `claude_desktop_config.json` is valid — a syntax error silently prevents MCP servers from loading. Use a JSON validator if unsure.

**"Server not connecting" or MikroMCP tools are missing**
Open the Claude Desktop developer console (if available) or check system logs for MCP server startup errors. Common causes:
- `command` path is wrong or `mikromcp` is not in the PATH used by Claude Desktop
- `args` format is wrong — `"args": ["serve"]` is required, not `"args": []`
- `MIKROMCP_CONFIG_PATH` points to a file that does not exist

**"Connection refused" or "Authentication failed" errors in tool responses**
MikroMCP started successfully but cannot reach the router. Check:
- `ROUTER_*_USER` and `ROUTER_*_PASS` are correct in the `env` block
- The router IP and port in `routers.yaml` are reachable from this machine
- The RouterOS REST API is enabled — see [RouterOS-API-Setup.md](RouterOS-API-Setup.md)

**"Permission denied" errors in tool responses**
The RouterOS user lacks the required policy for that tool category. See the [Required Policies table](RouterOS-API-Setup.md#required-policies-by-tool-category).

---

## Next Steps

- Browse the full tool list in [Available-Tools.md](Available-Tools.md) to see what you can ask
- For HTTP mode (remote deployments, Docker, multiple clients), see [Connecting-to-AI-Assistants.md](Connecting-to-AI-Assistants.md#generic-http-transport-for-remoteservice-deployments)
