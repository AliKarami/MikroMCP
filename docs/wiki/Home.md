# MikroMCP

A production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives AI assistants safe, structured access to MikroTik RouterOS devices. 118 typed tools. Dry-run on every write. Idempotency built in.

---

## Why it matters

Raw router CLI access is the wrong abstraction for AI agents. RouterOS is powerful, but asking an LLM to improvise shell commands against production gear is risky. MikroMCP gives agents a controlled tool surface instead:

| Instead of...                                | MikroMCP gives you...                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Hand-written RouterOS CLI snippets from chat | Typed MCP tools with strict Zod validation                                                                     |
| Blind config changes                         | Dry-run previews, idempotency checks, snapshots, and rollback tooling                                          |
| One-off scripts per router                   | A multi-router registry with per-router credentials, tags, TLS, SSH, and maintenance windows                   |
| Raw network access for every assistant       | RBAC identities, bearer tokens for HTTP mode, tool allowlists, and audit trails                                |
| Fragile troubleshooting workflows            | Router-originated ping, traceroute, torch, logs, interfaces, DHCP, firewall, routes, WiFi, WireGuard, and more |

---

## Getting started

| Page | What's in it |
|---|---|
| [Getting Started](Getting-Started) | Install, configure, and connect in 15 minutes |
| [RouterOS API Setup](RouterOS-API-Setup) | Enable the REST API, create a user, configure TLS and firewall |
| [Configuration](Configuration) | Router registry YAML, credentials, all environment variables |
| [Running](Running) | Development and production run commands |

## Connecting to an AI assistant

| Page | What's in it |
|---|---|
| [Connecting to Claude Desktop](Connecting-to-Claude-Desktop) | Register MikroMCP in Claude Desktop |
| [Connecting to AI Assistants](Connecting-to-AI-Assistants) | Claude Code, Cursor, Codex, HTTP/Docker/systemd |
| [Using the Skill](Using-the-Skill) | Install the usage skill so your assistant drives MikroMCP safely |

## Reference

| Page | What's in it |
|---|---|
| [Available Tools](Available-Tools) | All 118 tools — parameters, defaults, example prompts |
| [Architecture](Architecture) | System layers, request pipeline, auth model |
| [Error Handling](Error-Handling) | Error categories, retry engine, circuit breaker |
| [Security](Security) | Threat model, RouterOS/credential/RBAC hardening, audit, vulnerability reporting |

## Contributing

| Page | What's in it |
|---|---|
| [Development](Development) | Project structure, scripts, MCP Inspector workflow |
| [Contributing](Contributing) | Adding tools, coding conventions, PR checklist |
| [Roadmap](Roadmap) | Completed milestones and guiding principles |
