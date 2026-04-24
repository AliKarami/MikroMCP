# MikroMCP

A production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives AI assistants (Claude, Cursor, etc.) safe, structured access to MikroTik RouterOS devices via the RouterOS REST API.

---

## What it does

MikroMCP exposes MikroTik router management as MCP tools. An AI assistant connected to MikroMCP can query system status, list interfaces, manage VLANs, IP addresses, DHCP leases, static routes, and firewall rules — all through natural language, with the server enforcing validation, idempotency, and safety guardrails.

Key characteristics:

- **Read-only tools auto-retry** with exponential backoff + jitter
- **Write tools are idempotent** — creating something that already exists returns success, not an error
- **Dry-run mode** on all write tools — preview changes before applying
- **Circuit breaker** per router — trips after N consecutive failures, self-heals after cooldown
- **Structured + human-readable responses** — every tool returns both a text summary and a JSON `structuredContent` block
- **Zero secrets in config** — credentials come from environment variables
- **Multi-router** — manage any number of routers from a single server instance

---

## Quick start

**Requirements:** Node.js >= 22, MikroTik RouterOS 7.x with REST API enabled.

```bash
git clone https://github.com/AliKarami/MikroMCP.git
cd MikroMCP
npm install && npm run build
cp config/routers.example.yaml config/routers.yaml
# Edit config/routers.yaml with your router details
export ROUTER_CORE01_USER=mcp-api
export ROUTER_CORE01_PASS=your-password
npm start
```

Then add to Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mikrotik": {
      "command": "node",
      "args": ["/absolute/path/to/MikroMCP/dist/main.js"],
      "env": {
        "MIKROMCP_CONFIG_PATH": "/absolute/path/to/MikroMCP/config/routers.yaml",
        "ROUTER_CORE01_USER": "mcp-api",
        "ROUTER_CORE01_PASS": "your-password"
      }
    }
  }
}
```

For the full walkthrough including router user setup, see the **[Setup Guide](https://github.com/AliKarami/MikroMCP/wiki/Setup-Guide)**.

---

## Available tools

| Tool | Description |
|---|---|
| `get_system_status` | CPU, memory, uptime, identity |
| `list_interfaces` | Network interfaces with filtering and pagination |
| `create_vlan` | Create VLAN interfaces (idempotent) |
| `manage_ip_address` | Add / update / remove IP addresses |
| `list_dhcp_leases` | DHCP lease table with filtering |
| `list_routes` | Routing table with active/static filters |
| `manage_route` | Add or remove static routes (idempotent) |
| `list_firewall_rules` | Filter/NAT rules in evaluation order |
| `manage_firewall_rule` | Add / remove / disable / enable firewall rules |

Full parameter tables and example prompts: **[Available Tools](https://github.com/AliKarami/MikroMCP/wiki/Available-Tools)**

---

## Documentation

- [Architecture](https://github.com/AliKarami/MikroMCP/wiki/Architecture)
- [Setup Guide](https://github.com/AliKarami/MikroMCP/wiki/Setup-Guide)
- [Configuration](https://github.com/AliKarami/MikroMCP/wiki/Configuration)
- [Running](https://github.com/AliKarami/MikroMCP/wiki/Running)
- [Connecting to an MCP Client](https://github.com/AliKarami/MikroMCP/wiki/Connecting-to-an-MCP-Client)
- [Available Tools](https://github.com/AliKarami/MikroMCP/wiki/Available-Tools)
- [Error Handling](https://github.com/AliKarami/MikroMCP/wiki/Error-Handling)
- [Development](https://github.com/AliKarami/MikroMCP/wiki/Development)
- [Contributing](https://github.com/AliKarami/MikroMCP/wiki/Contributing)
- [Roadmap](https://github.com/AliKarami/MikroMCP/wiki/Roadmap)

---

## License

MIT — see [LICENSE](LICENSE).
