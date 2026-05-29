# Using the MikroMCP Skill

MikroMCP ships a Claude Code **skill** at `skills/mikromcp/` that teaches an AI
assistant to drive the tools safely — picking the right tool, running
dry-run → confirm → apply changes, fleet rollouts, and error recovery. It links to
official MikroTik documentation rather than copying it.

## Install (personal use)

Symlink (or copy) the skill into your Claude Code skills directory:

```bash
ln -s "$PWD/skills/mikromcp" ~/.claude/skills/mikromcp
# or: cp -r skills/mikromcp ~/.claude/skills/mikromcp
```

Restart Claude Code; the skill activates automatically when you work with MikroTik
routers through MikroMCP.

## What's inside

- `SKILL.md` — entry point: golden safety rules, intent→tool quick index, core
  workflows.
- `references/tool-map.md` — every tool by family with its REST path.
- `references/safety-and-recovery.md` — change lifecycle, idempotency, rollback,
  error→action table.
- `references/routeros-docs.md` — curated links into help.mikrotik.com.

The tool-map is kept in lockstep with the server's tools by a test in
`test/unit/skill/tool-map-sync.test.ts` (runs under `npm test`).
