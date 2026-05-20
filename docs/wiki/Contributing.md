# Contributing

Contributions are welcome. Please read this page before opening a PR.

---

## Git Workflow

All work happens on branches — never commit directly to `main`.

```bash
git checkout -b feat/my-new-tool   # or fix/, chore/, docs/, refactor/
# make changes
npm test                           # must pass before pushing
git push -u origin feat/my-new-tool
# open a PR targeting main — squash merge
```

Branch naming uses kebab-case prefixes: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`.  
Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): summary`, `fix: summary`, etc.

---

## Adding a Tool

1. Create a file in `src/domain/tools/` (or add to an existing one).
2. Define the tool using the `ToolDefinition` interface — see the pattern in `CLAUDE.md` or any existing tool file.
3. Export it and add it to `allTools` in `src/domain/tools/index.ts`.
4. Add unit tests in `test/unit/` covering metadata, input schema, and all handler paths.
5. Document it in `docs/wiki/Available-Tools.md` with a parameter table and example prompt.
6. Add a line to `CHANGELOG.md` under `[Unreleased] → Added`.

Minimal tool skeleton:

```typescript
import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("my-tools");

const myInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  // all params need .describe() for AI clients
}).strict();  // always .strict()

const myTool: ToolDefinition = {
  name: "my_tool",
  title: "My Tool",
  description: "What this tool does. Mention idempotency and dry-run if applicable.",
  inputSchema: myInputSchema,
  annotations: {
    readOnlyHint: true,       // true → auto-retry enabled in tool-registry
    destructiveHint: false,   // true → circuit breaker trips on failure
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = myInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Doing thing");

    try {
      const records = await context.routerClient.get("ros/path", {});
      return {
        content: `Found ${records.length} things.`,
        structuredContent: { routerId: context.routerId, records },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "my_tool" });
    }
  },
};

export const myTools: ToolDefinition[] = [myTool];
```

---

## Coding Guidelines

- **Idempotency first** — write tools must check existing state before acting and return `already_exists` / `no_change` when nothing needs to be done.
- **Always support `dryRun`** on write tools — no exceptions.
- **Never log credentials** — they are resolved by `tool-registry.ts` and never reach handlers.
- **Always use `.strict()`** on Zod schemas — reject extra fields.
- **Enrich errors** — use `enrichError()` in every catch block; throw `MikroMCPError` directly for domain errors (`NOT_FOUND`, `CONFLICT`, `VALIDATION`).
- **No retry/circuit-breaker logic in handlers** — that is handled by `tool-registry.ts`.
- **ESM imports with `.js` extensions** — `from "../../adapter/rest-client.js"` even for `.ts` source.
- Run `npm run format && npm run lint` before pushing.

---

## PR Checklist

- [ ] `npm test` passes (vitest + tsc + eslint)
- [ ] New tool: `docs/wiki/Available-Tools.md` updated with parameter table and example prompt
- [ ] New tool: `CHANGELOG.md` `[Unreleased]` section updated
- [ ] Write tool: `dryRun` supported
- [ ] Write tool: idempotency check included
- [ ] Write tool: `snapshotPaths` set if the tool modifies a RouterOS path that should be rollback-able
- [ ] PR title follows Conventional Commits format
