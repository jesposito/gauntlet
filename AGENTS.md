# Contributing & Agent Instructions

This document covers how to work on Gauntlet — for humans and for AI coding agents. The repo's design assumes both will read it.

## Build & test

```bash
bun install
bunx playwright install chromium
bun run tsc --noEmit       # type check
bun test                   # 275+ unit tests
```

The test suite is fast (~25s including browser-suite setup). Run it on every change. Type-check passes mean the build passes — no separate build step.

## Code conventions

- **TypeScript strict mode.** `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on. Be defensive with array indexing; assign `undefined` only when the type allows it.
- **Zod schemas live in `src/<area>/schema.ts`.** Add `.describe()` strings — they get included in AI prompts via `ProposeOptions.schemaDescription`.
- **Every pure module has a `.test.ts` next to it.** Most regressions in this codebase were classifier-regex or signature-stability changes under refactor. Tests defend those cheaply.
- **No `any` without justification.** If you need it, comment why.
- **Naming truth.** A function that returns `string | undefined` doesn't `getX(): string`. A flag named `--no-cache` actually disables caching — not just "writes a flag somewhere".
- **One reason to change per file.** When a file grows past ~500 lines or 25 exports, consider splitting. (Soft ceiling, not a rule.)
- **No emojis in code or commits.** Voice is direct technical English; emojis are fine in user-facing UI strings only (e.g. PR comment severity badges).

## Commit style

Conventional Commits. Subject ≤ 72 chars, body explains the **why**:

```
feat(runner): wait for networkidle after goto so first observe sees the SPA

SPAs (SvelteKit / React / etc) render a near-empty shell at
DOMContentLoaded and only hydrate after JS executes. Without an explicit
wait, the first observe() inside the flow loop captures only the "Skip
to main content" stub.

Adds an 8s networkidle wait between goto and the first step. Caught
in real-world dogfood: a busy-creator persona on a customer admin
surface went from "abandoned at step 1 (no nav visible)" to actually
reaching the project edit page.
```

Reference beads IDs in commit messages when applicable: `Closes gauntlet-3w2`. The auto-tag workflow + beads sync pick these up.

## Pull requests

- PR title matches the conventional-commit subject of the squashed commit.
- PR body should reference any bead IDs and call out user-visible changes.
- All checks must be green before merge.
- For runner / report / scoring changes, include a before/after example from a dogfood run when possible. Concrete numbers travel.

## Issue tracking (beads)

This project uses [beads](https://github.com/beads-tracker/beads) for issue management. Beads syncs to Dolt, so issue history is queryable + branchable like data.

### Quick reference

```bash
bd ready                  # Find work with no blockers
bd show <id>              # Issue details
bd update <id> --claim    # Atomically claim work
bd close <id>             # Complete + record reason
bd dolt push              # Sync beads data to remote
```

### Rules

- Use `bd` for all task tracking. Do not use TodoWrite, TaskCreate, or markdown TODO lists.
- Run `bd prime` for the full command reference + session-close protocol.
- Use `bd remember` for persistent project knowledge. Do not create `MEMORY.md` files.

## Session completion checklist

Work is not complete until pushed to remote. Before ending a session:

1. **File issues for remaining work** with `bd create`.
2. **Run quality gates**: `bun run tsc --noEmit && bun test`.
3. **Close finished beads** with `bd close <id> --reason "..."`.
4. **Push everything**:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status   # must show "up to date with origin"
   ```
5. **Verify** beads + git both pushed.

If `git push` fails, fix the root cause and retry. Never end a session with local-only changes.

## Non-interactive shell ops

`cp` / `mv` / `rm` are aliased to interactive mode on some systems and will hang an agent indefinitely. Use the force flags:

```bash
cp -f  / mv -f  / rm -f
rm -rf  /  cp -rf
ssh -o BatchMode=yes
scp -o BatchMode=yes
apt-get -y
```

## Documentation

When changing user-visible behavior, update:

- [`README.md`](README.md) — feature is documented in the right section.
- [`CHANGELOG.md`](CHANGELOG.md) — Unreleased section gets an entry.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — if you added/moved/renamed a file or changed a phase boundary.
- [`docs/QUICKSTART.md`](docs/QUICKSTART.md) — only if the change affects the five-minute path.
- Help text in `src/cli.ts` — flags appear in `gauntlet help`.

A documentation change without code is fine. A code change without documentation is not.
