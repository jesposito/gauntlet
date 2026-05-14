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
bun test                   # 275+ unit tests, ~25s
```

Type-check + tests are the build gate. There is no `bun run build`.

## Architecture overview

Six phases. First three are setup (one-time, then iterative). Last three are per-run execution + reporting.

1. **Phase A** — `src/init/project-reader.ts` reads README, package.json, fetches URLs, auto-probes common paths.
2. **Phase A2** — `src/init/surface-generator.ts` AI proposes audience-scoped surfaces.
3. **Phase B** — `src/init/persona-generator.ts` AI proposes personas grouped by surface. Curated interactively (`src/init/curate.ts`).
4. **Phase C** — `src/init/flow-generator.ts` AI proposes flows per persona, surface-aware. Curated interactively (`src/init/curate-flows.ts`).
5. **Phase D** — `src/runner/flow-supervisor.ts` spawns one `src/runner/flow-worker.ts` subprocess per flow (default; `--no-supervisor` flips to in-process). The worker calls `src/runner/flow-runner.ts` which executes the `observe → act → capture → judge` loop per step and streams every `GauntletEvent` back as JSON-line stdout.
6. **Phase E + F** — `src/report/` synthesizes per-persona + cross-persona + cross-surface reports and runs the vetting layer.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full file-by-file map and data-flow diagrams.

## Conventions specific to this project

- **Surface awareness is end-to-end.** Once a persona has `surface: <id>`, every downstream phase respects it. When adding a feature, ask: does this need to know which surface it's running on? If yes, thread `surfaceId` through.
- **Every AI call is cancellable.** `ProposeOptions.signal: AbortSignal` is plumbed through every provider. When adding a new AI call site (runner OR init), wrap it in `withCancellableTimeout` from `src/ai/with-cancellable-timeout.ts` so timeouts actually cancel the in-flight fetch.
- **Every Playwright resource is released.** `runFlow`, `runPersona`, `vetter.openSession`, `cross-surface.vetCrossSurfacePatterns`, `auth/capture` all wrap work in `try { ... } finally { closeWithTimeout(...) }`. New resources go in the same finally with the same swallow-on-timeout discipline.
- **Every long await is bounded, cancellable, or both.** Setup ops (`chromium.launch`, `newContext`, etc.) wrap through `setupOp()` which both bounds the wallclock and emits `setup_op_start` / `setup_op_end`. Inner capture ops have 5s sentinels. The supervisor watchdog (`src/runner/flow-supervisor.ts`) is the last-resort reaper — but don't lean on it; bound at the call site too.
- **Every event goes through `src/events.ts`.** When you need to surface progress to users, add a variant to the `GauntletEvent` union and emit through `setGlobalEventEmitter()`. Both renderers consume the same union; don't add a renderer-specific bypass.
- **Personas don't dramatize.** When editing prompts in `src/runner/step-judge.ts` or `src/init/flow-generator.ts`, preserve the "observable evidence" requirement. Aesthetic distaste is never a give-up trigger. `give_up_class` (`bug | confusing_ux | feature_gap | not_a_bug`) drives auto-downgrade in `src/report/generator.ts`.
- **Discriminated-union schemas at the AI boundary.** `LocatorPickSchema` (`match_kind`), `ActionPickSchema` (`action`), `StepVerdictSchema` (`status`) are all discriminated unions. New AI call shapes follow the same pattern so impossible LLM outputs fail at the schema boundary, not as runtime confusion downstream.
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
