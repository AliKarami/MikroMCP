export const SITE = {
  name: "MikroMCP",
  domain: "https://mikromcp.com",
  tagline: "AI-native network automation for MikroTik RouterOS",
  github: "https://github.com/AliKarami/MikroMCP",
  docs: "https://docs.mikromcp.com",
  toolCount: 117,
};

export const features = [
  { icon: "compass", title: "Router management", body: "System status, clock, reboot, packages, files, scripts, scheduler jobs, containers." },
  { icon: "globe", title: "Network operations", body: "Interfaces, VLANs, IP addresses, DHCP leases, DNS static records, bridge ports, WiFi clients." },
  { icon: "flame", title: "Firewall & policy", body: "Filter/NAT rules, mangle rules, address lists, route tables, routing rules." },
  { icon: "route", title: "Routing visibility", body: "Static routes, routing tables, BGP peers, OSPF neighbors." },
  { icon: "lock", title: "Secure access", body: "HTTP bearer auth, bcrypt token hashes, RBAC, router/tool restrictions, confirmation tokens." },
  { icon: "activity", title: "Diagnostics", body: "Router-originated ping, traceroute, torch, log filtering, guarded SSH command execution." },
  { icon: "shield", title: "Change safety", body: "Dry-run, idempotent writes, snapshots, write journal, plan_changes, apply_plan, rollback_change." },
  { icon: "settings", title: "Production behavior", body: "Retries for read tools, per-router circuit breakers, correlation IDs, structured logs, audit logs." },
  { icon: "puzzle", title: "MCP compatibility", body: "stdio for desktop clients, Streamable HTTP and legacy SSE for remote or service-style clients." },
];

export const examples = [
  { label: "Router Inspection", prompt: "Use MikroMCP to inspect core-01. Summarize system resources, RouterOS version, running interfaces, active routes, DNS settings, and recent warning/error logs. Flag anything that looks operationally risky." },
  { label: "Firewall Management", prompt: "List firewall filter and NAT rules on edge-01. Identify disabled rules, overlapping port forwards, broad accept rules, and anything without comments. Do not change anything yet." },
  { label: "Safe Route Change", prompt: "Dry-run a route on core-01 for 10.20.0.0/16 via 192.168.88.1 in the main table. Show the exact planned diff and tell me whether an existing route conflicts." },
  { label: "WireGuard", prompt: "Show WireGuard peers on branch-02. Sort by last handshake age and flag peers that have not handshaken recently or have no transfer counters." },
  { label: "Diagnostics", prompt: "Check interface health on edge-01, then run ping and traceroute from the router to 1.1.1.1. If packet loss is present, use torch on the WAN interface for a short traffic snapshot." },
  { label: "Plan / Apply / Rollback", prompt: "Create a change plan that adds a DNS record and a firewall address-list entry on edge-01. Use dry-run first, explain the plan, then wait for approval before applying anything." },
];

export const faqs = [
  { q: "What is MikroMCP?", a: "MikroMCP is an open-source Model Context Protocol (MCP) server that exposes MikroTik RouterOS as 117 typed, auditable tools — letting AI assistants inspect, diagnose, and safely operate routers in natural language instead of improvising CLI commands." },
  { q: "How is it different from the RouterOS API?", a: "The RouterOS REST/API exposes raw endpoints. MikroMCP wraps them in schema-validated, idempotent, dry-run-able tools with RBAC, audit logging, snapshots, and rollback — the safety layer an LLM needs before it touches production gear." },
  { q: "How is it different from SSH automation?", a: "Instead of brittle SSH scripts that screen-scrape CLI output, MikroMCP returns structured, typed results with confirmation gates and per-router circuit breakers. SSH is used only where REST can't reach — ping, traceroute, torch, and guarded run_command." },
  { q: "Does it work with Claude, Cursor, and Codex?", a: "Yes. MikroMCP speaks MCP over stdio and HTTP/SSE, so Claude Desktop, Claude Code, Cursor, Codex, and any MCP-compatible client can drive RouterOS directly." },
  { q: "Is it safe to run against production routers?", a: "MikroMCP is built for it: dry-run previews, idempotent writes, snapshots, rollback, confirmation tokens, per-router circuit breakers, RBAC, and audit logging. Use least-privilege RouterOS users and verified TLS." },
  { q: "Which RouterOS versions are supported?", a: "RouterOS 7.x, which provides the REST API MikroMCP uses." },
];
