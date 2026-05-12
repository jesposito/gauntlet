# Project Instructions for AI Agents

This file gives AI coding agents the project-specific context they need beyond the general conventions in [`AGENTS.md`](AGENTS.md).

## What this project is

Gauntlet is an MIT-licensed Bun/TypeScript CLI. It drives Playwright with AI personas against any web app and produces forensic accessibility / UX reports. See [`README.md`](README.md) for the user-facing story and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system map.

The single most important file is [`src/cli.ts`](src/cli.ts) — every subcommand dispatches from there. Most user-visible changes touch it.

## Build & test

```bash
bun install
bunx playwright install chromium
bun run tsc --noEmit       # type check (strict mode + exactOptionalPropertyTypes + noUncheckedIndexedAccess)
bun test                   # 115+ unit tests, ~600ms
```

Type-check + tests are the build gate. There is no `bun run build`.

## Architecture overview

Six phases. First three are setup (one-time, then iterative). Last three are per-run execution + reporting.

1. **Phase A** — `src/init/project-reader.ts` reads README, package.json, fetches URLs, auto-probes common paths.
2. **Phase A2** — `src/init/surface-generator.ts` AI proposes audience-scoped surfaces.
3. **Phase B** — `src/init/persona-generator.ts` AI proposes personas grouped by surface. Curated interactively (`src/init/curate.ts`).
4. **Phase C** — `src/init/flow-generator.ts` AI proposes flows per persona, surface-aware. Curated interactively (`src/init/curate-flows.ts`).
5. **Phase D** — `src/runner/flow-runner.ts` executes the `observe → act → capture → judge` loop per step.
6. **Phase E + F** — `src/report/` synthesizes per-persona + cross-persona + cross-surface reports and runs the vetting layer.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full file-by-file map and data-flow diagrams.

## Conventions specific to this project

- **Surface awareness is end-to-end.** Once a persona has `surface: <id>`, every downstream phase respects it. When adding a feature, ask: does this need to know which surface it's running on? If yes, thread `surfaceId` through.
- **Every AI call is cancellable.** `ProposeOptions.signal: AbortSignal` is plumbed through every provider. When adding a new AI call site in the runner, wrap it in `withCancellableTimeout` so timeouts actually cancel.
- **Every Playwright resource is released.** `runFlow` already wraps all work in `try { ... } finally { closeWithTimeout }`. New resources go in the same finally.
- **Personas don't dramatize.** When editing prompts in `src/runner/step-judge.ts` or `src/init/flow-generator.ts`, preserve the "observable evidence" requirement. Aesthetic distaste is never a give-up trigger.
- **Noise is a first-class problem.** Before adding a new finding category, decide its severity-downgrade rules. See `src/runner/third-party-axe.ts`, `src/runner/external-host.ts`, `src/runner/console-class.ts` for the existing classifier patterns.

## Where to add things

| Adding... | Touch... |
|---|---|
| New AI provider | `src/ai/<name>.ts` + register in `src/ai/index.ts` |
| New behavior template | `src/persona/templates/<id>.yaml` |
| New third-party-embed false-positive class | `THIRD_PARTY_PREFIXES` in `src/runner/third-party-axe.ts` |
| New console-error category | `classifyConsoleMessage` in `src/runner/console-class.ts` |
| New CLI subcommand | `cmd<Name>` function + dispatch case + help text in `src/cli.ts` |
| New bench site | `bench/sites.json` |

Always add the unit test next to the module first. Most regressions caught in this codebase came from changes to classifier regexes or signature stability under refactor — tests defend those cheaply.

## Beads + session-completion rules

See [`AGENTS.md`](AGENTS.md) for the full beads workflow. Short version: every session ends with `bun run tsc --noEmit && bun test && git push && bd dolt push`. Work is not complete until both are pushed.
