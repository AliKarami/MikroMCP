---
name: release
description: Release checklist for shipping a new MikroMCP version. Invoke when preparing, tagging, or publishing a release, bumping the version, or merging a release PR into main.
---

# Release checklist

Run when merging a release PR into `main`:

1. Move all items from `[Unreleased]` in `CHANGELOG.md` to a new `## [X.Y.Z] - YYYY-MM-DD` section.
2. `npm version <major|minor|patch>` — bumps `package.json` + `package-lock.json`. (`npm version` auto-runs `scripts/sync-version.mjs`, which regenerates `src/version.ts` **and** `site/src/data/version.ts`, so the mikromcp.com footer follows the release.)
3. Update README version badge: `version-v<X.Y.Z>`.
4. Update `server.json` — change BOTH the top-level `"version"` field AND `packages[0].version` to `"X.Y.Z"`.
5. Add the release to `ROADMAP.md` and mirror it in `docs/wiki/Roadmap.md` (flip `🔜` → `✅`, or add a section for a release that had no planned milestone). docs.mikromcp.com publishes the wiki copy.
6. Update `docs/wiki/Available-Tools.md` for any new/changed tools, and `site/src/data/content.ts` (`toolCount`, `features`, `examples`) for anything worth advertising on the landing page.
7. `npm test` — the lockstep tests fail if any doc, wiki page, or site file still states the old tool count or version.
8. Build both sites: `npm --prefix site run build && npm --prefix docs-site run build`.
9. Commit on the release branch: `chore: bump version to X.Y.Z`.
10. Open PR, squash-merge into `main`.
11. `git tag vX.Y.Z && git push origin vX.Y.Z`
12. CI `release.yml` auto-runs: builds binaries, pushes Docker images, creates GitHub Release (uses the release section from `CHANGELOG.md` as release notes).
13. Deploy the two sites (see `site/DEPLOY.md` and `docs-site/DEPLOY.md`).
