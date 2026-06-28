# Architecture

How Gauntlet's pieces compose, what hands off to what, and where to extend.

## The six phases

Every Gauntlet run flows through six phases. The first three are setup (one-time per project, then iterative); the last three are per-run execution and reporting.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  Phase A          Phase A2         Phase B          Phase C             │
│  Project read ─►  Surfaces    ─►   Personas   ─►   Flows                │
│                                                                         │
│  README +         AI proposes      AI proposes      AI proposes 2–4     │
│  package.json     surfaces from    8–12 candidates  flows per persona,  │
│  + landings       evidence;        grouped by       respecting the      │
│  + auto-probe     user curates     surface; user    surface's features  │
│  /admin /login    accept/reject    curates again    + excluded_features │
│  /pricing ...     /edit/regen                                           │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │   .gauntlet/surfaces/<id>.yaml                                  │    │
│  │   .gauntlet/personas/<id>.yaml                                  │    │
│  │   .gauntlet/flows/<id>.yaml                                     │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

                              ▼  gauntlet run

┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  Phase D                              Phase E                Phase F    │
│  Execution (per persona × flow)   ─►  Per-persona      ─►    Vetting    │
│                                       reports                layer      │
│  For each step:                                                         │
│    observe (AI; confidence-gated)     Aggregate              Replay     │
│    act (Playwright; bounded)           each persona's        every      │
│    capture (screenshot + DOM           findings; cross-      finding;   │
│             + AX-tree + axe +          persona patterns      [VERIFIED] │
│             + console + network)       within run            or         │
│    judge (AI; observable evidence)                           [regressed]│
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │   .gauntlet/runs/<ts>/                                          │    │
│  │     REPORT.md  +  report.json                                   │    │
│  │     <persona>/<flow>/                                           │    │
│  │       flow-result.json  +  video/  +  steps/0000/...            │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

                              ▼  gauntlet cross-report

┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  Aggregate signatures across surfaces. Patterns appearing on ≥2         │
│  surfaces are almost always design-system tokens or systemic UX gaps    │
│  (fix once, not N times).                                               │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │   .gauntlet/CROSS-REPORT.md  +  cross-report.json               │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## File-by-file map

### `src/cli.ts` + `src/cli/flag-parsers.ts`

Single-file CLI dispatcher. Parses argv, dispatches to `cmdInit`, `cmdFlows`, `cmdRun`, etc. Each command function lives in `cli.ts` itself (no per-command file) because the dispatch logic is small and keeping it together makes the help text + flag inventory easy to keep consistent. `parseArgs` is exported and `main()` is guarded by `import.meta.main` so tests can import without firing the CLI.

`buildEmitter()` multiplexes a text renderer over a JSONL renderer (when `--events-log` is set) and wires `setGlobalEventEmitter` via dynamic import so producers (CachingProvider, setup-op helper) reach the renderer without callback threading. Five long-running commands (`run`, `report`, `init`, `flows`, `seed`) accept `--events-log <path>` and `--no-color`; `run` additionally accepts `--record-video` and `--no-supervisor`; `init` and `flows` additionally accept `--focus <text>`. `cmdRun` defaults to `runFlowSupervised` (per-flow worker process); `--no-supervisor` flips back to in-process `runFlow`. Phase headers (`phase_start` / `phase_end`) fire around init / flows / run / vet / report.

`flag-parsers.ts` provides `parsePositiveIntFlag` / `parseOptionalBoundedIntFlag` — strict numeric parsing that rejects `NaN`, negatives, zero, decimals, scientific notation, and over-cap values at startup. Replaces every `Number(...)` flag callsite.

### `src/ai/`

Provider abstraction.

- `provider.ts` — `AiProvider` interface with one method: `propose<T>(opts: ProposeOptions<T>): Promise<T>`. `ProposeOptions` carries `messages`, `schema`, `schemaName`, `schemaDescription`, optional `maxTokens` / `temperature`, optional `purpose: AiCallPurpose` (`surface_gen | persona_gen | flow_gen | observe | act | judge`), **and `signal: AbortSignal`** so callers can cancel hung fetches. The wrapping `CachingProvider.propose` emits `ai_call_start` / `ai_call_end` (correlated by `callId`, with `cached: boolean`) through the global event emitter.
- `cache.ts` — Disk cache (`.gauntlet/cache/ai/<sha256>.json`, mode `0600`). Keyed on the canonical JSON of `(provider, model, messages, schemaName, schemaDescription, maxTokens, temperature)`. Tracks `hits / misses / writes` for the run summary.
- `with-cancellable-timeout.ts` — Shared helper that wraps a propose call in an `AbortController` so a hung AI fetch is actually cancelled (not just abandoned). Used by every `src/init/*-generator.ts` call site (default 120s) and ported from the runner's earlier inline copy.
- `preflight.ts` — `preflightProvider()` runs one bounded (~16-token), cancellable `propose()` to validate a provider key before a run. Returns `{ ok: true }` / `{ ok: false, error }` and never throws. `gauntlet doctor` uses it to fail fast on a dead/expired key instead of a mid-run 401.
- `anthropic.ts`, `openai.ts`, `google.ts`, `ollama.ts` — One adapter per provider. Each threads `opts.signal` into its underlying `fetch`. The active provider is picked from the model name prefix. All four throw `Error` with message starting `<provider> output failed schema "<name>":` on Zod rejection — `proposeActionWithRecovery` in the runner detects that substring and degrades to `no_match` rather than failing the flow.

### `src/init/`

Setup (Phases A, A2, B, C).

- `project-reader.ts` — `readProject({ cwd, urls, probePaths })`. Reads `README.md`, `package.json`, fetches each `--url`, runs the auto-probe, returns a `ProjectContext` with `landings: LandingPageContext[]`. Each landing includes `reachable`, `statusCode`, and `hint` (e.g. `"appears to require login"` for pages with a password input). Bounded to ~30 KB total into the AI context.
- `probe-paths.ts` — `planProbeCandidates(urls)` + `probeAll(candidates)`. Generates `/admin /login /pricing /dashboard /signin /app /_/login` per origin, parallel-fetches with 5 s cap, keeps 200/301/302/401/403, drops 404s silently.
- `surface-generator.ts` — AI call that turns the `ProjectContext` into 1–6 surfaces. Prompt instructs the AI to surface auth-walled views (admin panels, customer dashboards) even when only marketing landings were fetched, using README evidence.
- `persona-generator.ts` — AI call that proposes personas grouped by surface. Each candidate has `surface: <id>`. `candidateToPersona()` preserves the `surface` field through to the written yaml.
- `flow-generator.ts` — AI call that proposes flows for one persona. Surface-aware: the prompt includes `features` and `excluded_features` so the AI won't propose flows targeting unavailable capabilities.
- `curate.ts`, `curate-flows.ts` — Interactive accept/reject/edit/regen loops. Use `$EDITOR` for edits.
- `seed.ts` — `seedProject({ provider, urls, ... })`. Non-interactive Phase A+A2+B+C orchestration. Used by `gauntlet seed`, `gauntlet bench`, and the per-project dogfood scripts.

### `src/persona/`, `src/surface/`, `src/flow/`

Schemas + loaders for the three curated artifact types. Each has:

- `schema.ts` — Zod schema with descriptive `.describe()` strings.
- `loader.ts` — Read/write/list under `.gauntlet/<type>/`. Idempotent: re-running `init` augments rather than replaces.

The flow schema has optional `feature`, `tags`, `paths` fields that drive `gauntlet run` filters. The flow filter (`src/flow/filter.ts`) is pure and unit-tested.

### `src/auth/capture.ts`

`captureAuth({ cwd, surfaceId, url })` launches headed Chromium, waits for user to log in + press `Enter` in the terminal, calls `context.storageState()`, writes the JSON to `.gauntlet/auth/<id>.json` with `mode 0600` and the directory created `mode 0700`. Also exports `resolveAuthStatePath(cwd, authState)` which the runner uses to locate the file at run time (or skip with a warning if missing). Both close paths are bounded (8s) and the body lives in `try { ... } finally { ... }` so an exception before close can't leak a Chromium handle. `BrowserLauncher` test seam mirrors `src/runner/browser.ts`.

### `src/target/pr.ts`

`resolvePrUrl(prArg, cwd)` for `gauntlet run --pr <num>`:

1. Try `.gauntlet/config.json` `pr_url_template` first. Substitutes `{number}`, `{pr}`, `{branch}`, `{ref}`. Branch is **slugged** before interpolation (lowercase, non-alnum → `-`, 63-char DNS-label cap) so a hostile branch name can't produce a host-confusable URL.
2. Fall back to scanning the PR's comments for known preview-URL patterns (Vercel / Netlify / Render / Cloudflare Pages / Fly).
3. Validate the final URL: only `http(s)`, only a well-formed hostname. Reject anything else.

### `src/events.ts`

The single source of truth for in-process telemetry. `GauntletEvent` is a discriminated union covering `phase_start` / `phase_end`, `ai_call_start` / `ai_call_end`, `vet_start` / `vet_url_*` / `vet_finding` / `vet_end`, `setup_op_start` / `setup_op_end`, `flow_*`, `heartbeat`, `warn`, `error`. `flowEventBridge(emit)` adapts the legacy in-runner `FlowEvent` shape onto the union so the runner's existing event sites don't need a wholesale refactor. Every event carries a numeric `ts`. Producers use `setGlobalEventEmitter(fn)` so `CachingProvider` and the setup-op helper can emit without threading callbacks through 20 call sites; the supervised execution model pins one process per flow so per-flow correlation is implicit.

### `src/renderers/`

Two independent consumers of the event stream.

- `text.ts` — Terminal renderer. ANSI spinner during AI calls + axe scans, per-persona color + shortname (last kebab segment with collision fallback), per-phase headers (`[Phase init]`, `[Phase flows]`, `[Phase run]`, `[Phase vet]`, `[Phase report]`). Drops ANSI on non-TTY (CI / piped) and falls back to plain timestamped lines. Honors `--no-color` and `NO_COLOR`. Quiet mode keeps phase headers but suppresses per-step detail.
- `jsonl.ts` — One event per line, every line carries `ts`. Wired by `--events-log <path>` for Claude (or any agent / CI) to tail a file as gauntlet runs.

### `src/runner/`

Execution (Phase D).

- `flow-runner.ts` — The main loop. `runFlow({ url, persona, flow, ... })`. Launches chromium (every setup op wrapped in `setupOp()` which emits `setup_op_start` / `setup_op_end` and inner-bounds the wallclock — launch 45s, context/page 30s, CDP 15s, network emulate 10s, `goto` 60s), sets persona-aware viewport + user agent + network throttling, threads `storageState` if the surface needs auth, runs the per-step loop, writes `flow-result.json`. Wallclock alarm fires `FLOW_WALLCLOCK_BUDGET_MS` after launch and force-closes the browser if anything wedges. `recordVideo` defaults OFF — opt-in via `FlowRunOptions.recordVideo` / `--record-video` because Playwright's ffmpeg `gracefulClose()` has no internal deadline. `classifyFlowError` reclassifies wallclock-induced rejections to `outcome: "timeout"` so on-disk `flow-result.json` matches the in-memory `FlowRunResult`. All resources released in `finally`.
- `flow-worker.ts` — Subprocess entry point. Reads JSON input from `argv[2]`, wires `setGlobalEventEmitter` + `flowEventBridge` to write every event as one JSON line on stdout, calls `runFlow`, emits final `{"type":"flow_result","result":<FlowRunResult>}`. SIGTERM/SIGINT handlers attempt clean Playwright release before exit.
- `flow-supervisor.ts` — Parent-side `runFlowSupervised(input, opts)`. Spawns the worker `detached: true` (POSIX `setsid` → own process group) so `process.kill(-pid)` reaps the entire tree (worker + chromium + any rogue ffmpeg). Reads child stdout line-by-line, demuxes `flow_result` / `flow_error` / `GauntletEvent` (also bridges `FlowEvent` shape to the legacy `onFlowEvent` for the run-loop counter in `cli.ts`). 5s watchdog interval checks `Date.now() - lastEventAt > silenceBudgetMs` (default 75s); on silence emits a warn event, SIGTERMs `-pid`, then SIGKILLs after `killGraceMs` (default 2s). Synthesizes `outcome=timeout` / `outcome=error` `FlowRunResult` on kill or non-zero exit. Default execution path for `gauntlet run`; flip back with `--no-supervisor` for in-process debugging.
- `browser.ts` — Legacy single-step capture (pre-flows path; used when `--no-flows` or no curated flows exist for the persona).
- `step-judge.ts` — `judgeStep({ provider, page, step, ... })` AI call that returns `success | in_progress | give_up` with evidence. The system prompt is strict: `give_up` requires observable evidence (action failed, expected element absent, named give-up criterion observably fired). `StepVerdictSchema` is a discriminated union — `give_up` requires both `give_up_reason` and `give_up_class` (`bug | confusing_ux | feature_gap | not_a_bug`); permissive `RawStepVerdictSchema` parses provider-sloppy AI output (accepts explicit `null` on the optional fields), and `normalizeVerdict` promotes to the strict shape with missing class defaulting to `"bug"`. Persona voice is for narration tone, not abandonment trigger. Defaults to `in_progress` when uncertain.
- `capture.ts` — `captureStep(page, cdp, ctx, stepIndex)` writes screenshot, DOM, AX-tree, axe JSON, console + network logs to `steps/NNNN/`. Returns a `StepCapture` for downstream judgment. Each inner op (`page.content` / CDP `Accessibility.*` / `page.title`) is wrapped with sentinel-on-timeout (5s) so partial capture is always preferred over a hang.
- `axe-scan.ts` — `runAxe(page)` wraps `@axe-core/playwright`, tags violations with `thirdParty` / `thirdPartySource` (via `third-party-axe.ts`), and includes the persona-rule → axe-rule mapping (`PERSONA_RULE_TO_AXE_ID`).
- `third-party-axe.ts` — Detect axe nodes inside third-party iframe content (frame-pierced target chain) or matching known embed/CMP class prefixes (YouTube, Vimeo, Stripe Elements, Cloudflare Turnstile, reCAPTCHA, hCaptcha, Calendly, Intercom, Typeform, OneTrust, Cookiebot, Osano, TrustArc, Termly, Klaro, CookieYes).
- `external-host.ts` — Detect console errors whose message references an external host. Returns the hostname so callers can downgrade severity.
- `console-class.ts` — `classifyConsoleMessage(text)` buckets every console error into one of 8 classes (`csp_violation` with directive extracted, `extension_blocked`, `preload_unused`, `mixed_content`, `cookie_policy`, `network_error`, `uncaught_exception`, `unknown`).
- `page-settle.ts` — `waitForDomSettle(page, { quietMs, timeoutMs })`. Runs a `MutationObserver` inside the page, resolves after `quietMs` of zero mutations, capped by `timeoutMs`. Replaces `page.waitForLoadState("networkidle")` which is unreliable on SPAs that poll.
- `network-profiles.ts` — Bandwidth + latency profiles for `fast-fiber`, `home-wifi`, `slow-3g`, `office-wifi`, `intermittent`. Used via CDP `Network.emulateNetworkConditions`.
- `failure-reasons.ts` — Enum of every failure category the runner emits.

### `src/agent/`

The action loop primitives.

- `dom-outline.ts` — Walks the page's accessibility tree + DOM, returns a numbered `OutlineElement[]` of visible interactive elements (`<summary>` is included so persona judges see disclosure copy). New `getPageText(page, max)` returns a compressed innerText snippet that supplements the role-only outline; observe and judge both consume it so stat-cards, plain-text help, and synonyms don't read as missing.
- `actions.ts` — `observe(ctx, instruction)`, `act(ctx, instruction)`, `extract(ctx, instruction, schema)`. Each is an AI call against the outline + page-text snippet. `ActionContext` carries `signal` (for cancellation) and `recentSteps` (last 3 `(intent, action, outcome)` tuples; the AI sees its prior attempts so it doesn't loop on a target that already failed).
- `LocatorPickSchema` is a discriminated union on `match_kind: "element" | "text" | "none"`. Element matches drive `act`; text matches short-circuit to a synthetic success verdict; `none` is the only failure path. `ActionPickSchema` is a discriminated union on `action` (with `value` required only for `fill` / `press` / `select`). Both schemas include a required `confidence: 0–100`; below 60 degrades to `no_match` rather than committing to a wrong locator. `proposeActionWithRecovery` catches `"output failed schema"` rejections and degrades to `no_match` so a model decline lands as a normal observe loop, not an `outcome=error` flow.

### `src/report/`

Reporting (Phases E, F).

- `schema.ts` — Zod `Finding`, `PersonaReport`, `RunReport`, `CrossSurfacePattern`, `FailureEventSchema`, `FlowResultFileSchema`. Findings carry an optional `surfaceId` so the vetter can resolve `auth_state`, plus optional `category: bug | confusing_ux | feature_gap | not_a_bug` propagated from the judge's `give_up_class`.
- `io.ts` — `readFlowResultOrWarn` / `readRunReportOrWarn` / `readJsonValidatedOrWarn`. Persisted JSON is read through Zod, never as `as`-cast. A corrupt single artifact warns and skips; an N-flow report no longer fails on one bad file.
- `generator.ts` — `buildPersonaReport(runDir, personaId)`. Reads each flow's `flow-result.json` via `io.ts`, dedups within a flow + across flows (axe rules keyed by `rule + url`), applies severity overrides (external-host console → minor, third-party axe → minor, `category=not_a_bug` / `category=feature_gap` → minor), and returns `PersonaReport`.
- `rollup.ts` — Cross-persona patterns within a single run.
- `cross-surface.ts` — Cross-surface patterns across multiple runs. Signature for non-axe findings includes the URL's path family + a normalized-message hash so unrelated `console_error` events on different routes don't collapse into one pattern. Optional `vetCrossSurfacePatterns()` replays the top-N axe patterns across each surface's `base_url` (auth-aware via `storageState`) and tags them `verified` iff they re-fire on a majority of surfaces. Both close paths (context, browser) are wrapped in 8s `closeWithTimeout`.
- `vetter.ts` — `vetAll(findings, { cwd, emit?, perFindingBudgetMs? })`. Groups findings by `(url, auth_state)`, opens one Playwright context per group with `storageState` when the originating surface needs auth, replays axe / console-error checks, tags each finding `verified` / `regressed` / `subjective` / `could_not_replay`. Emits `vet_start` / `vet_url_*` / `vet_finding` / `vet_end` boundary events with a 5s heartbeat during axe scans (the loop survived a 25-min hang against an audplexus run that had no progress signal). Each `openSession` is wrapped in `withVetTimeout` (default 60s) and partial contexts are released via bounded `raceWithTimeout`. Both `closeSession` and `browser.close` are bounded too — orphaned contexts (parent chromium gone) used to freeze the post-`vetAll` close path indefinitely. `runAxe` defensively races `AxeBuilder.analyze()` against a 30s timeout (cheaper than the 5-min flow alarm; honest about the limit since axe's in-page runtime has no abort API — the supervisor remains the actual reaper for a hung axe pass).
- `render-markdown.ts` — `REPORT.md` with severity badges + artifact paths + per-finding `category` badge when set.
- `build.ts` — Top-level orchestrator: `buildReport({ runDir, vet, emit? })` ties generator + rollup + vetter + render together. `cmdRun` and `cmdReport` thread `emit` through so the vetter heartbeat reaches users (without that thread, it lights up tests but goes silent in production).

### `src/bench/runner.ts`

`gauntlet bench` harness. Loops over `bench/sites.json` (12 public SaaS sites by default), runs `seedProject` + `runFlow` per site in a scratch dir under `bench-tmp/<name>/`, aggregates into `.gauntlet/bench/bench-<date>.{md,json}`.

### `src/comment/render.ts`

`gauntlet comment` body builder. Pure function: `renderPrComment({ report, prNumber, maxFindings, artifactBase, ... })` → markdown. Findings ordered critical → minor, persona-abandon events highlighted, per-persona flow outcome rollup. The CLI command shells out to `gh pr comment --body <rendered>` once the body is built.

## Data flow

### One run, one persona, one flow

```
.gauntlet/surfaces/marketing.yaml          .gauntlet/personas/mary.yaml
       │                                            │
       └────────────────┬───────────────────────────┘
                        │
                        ▼
                 gauntlet run --surface marketing
                        │
                        ▼
              ┌─────────────────────────────┐
              │  cli.ts / cmdRun            │
              │   buildEmitter() ─► text +  │
              │                    optional │
              │                    jsonl    │
              │                    (events- │
              │                    log)     │
              └─────────────┬───────────────┘
                            │  per flow
                            ▼
              ┌──────────────────────────────────────┐
              │  flow-supervisor.runFlowSupervised   │
              │   spawn(flow-worker, detached:true)  │
              │   ◄── stdout: GauntletEvent JSON     │
              │       lines + flow_result            │
              │   5s watchdog: silence > 75s         │
              │     ─► SIGTERM -pid; SIGKILL +2s     │
              │       (kills worker + chromium       │
              │        + any rogue ffmpeg)           │
              └─────────────┬────────────────────────┘
                            │
                            ▼ (subprocess)
              ┌──────────────────────────────────────┐
              │  flow-worker.ts                      │
              │   setGlobalEventEmitter(stdout-emit) │
              │   runFlow({ url, persona, flow })    │
              │     ┌────────────────────────────┐   │
              │     │ setupOp browser_launch 45s │   │
              │     │ setupOp new_context    30s │   │
              │     │ setupOp new_page       30s │   │
              │     │ setupOp cdp_session    15s │   │
              │     │ setupOp network_emul.  10s │   │
              │     │ setupOp goto           60s │   │
              │     └────────────────────────────┘   │
              │     ┌────────────────────────────┐   │
              │     │ for each step:             │   │
              │     │   observe (match_kind:     │   │
              │     │     element|text|none)     │   │
              │     │   act (only if element)    │   │
              │     │   waitForDomSettle         │   │
              │     │   captureStep              │   │
              │     │   judgeStep                │   │
              │     └────────────────────────────┘   │
              │   ai_call_start / ai_call_end on     │
              │     every CachingProvider.propose    │
              │   wallclock alarm @ FLOW_BUDGET_MS   │
              │     ─► force-close + classify        │
              │        outcome="timeout"             │
              └──────────────┬───────────────────────┘
                             │
                             ▼
                       flow-result.json
                             │
                             ▼ (parent process)
                       generator.ts (io.ts: read via Zod)
                             │
                             ▼
                       PersonaReport
                             │
                             ▼
                       vetter.ts ─► vet_url_axe_start / end
                             │       (5s heartbeat; per-finding
                             │        60s budget; bounded close)
                             ▼
                       REPORT.md   /   report.json
```

The text renderer prints `[Phase run]` on `phase_start`, then `setup browser_launch  done  0.1s` lines as setup-ops emit, then `AI live 3.1s` / `AI cache 0.2s` as AI calls land, then per-flow step lines, then `[Phase vet]` and the spinner during axe scans. The JSONL renderer writes the same events one-per-line for tail-and-parse consumers. Both are independent.

### Failure flow

```
                            outcome=…
                                 │
            ┌─────────┬──────────┼──────────┬──────────┐
            ▼         ▼          ▼          ▼          ▼
        completed  abandoned  patience_  timeout    error
                              exceeded
            │         │          │          │          │
            │         │          │          │          │
            │     observable    persona   flow        flow
            │     give_up       waited    body        body
            │     evidence      longer    wedged      threw
            │     fired         than      (wallclock  (caught
            │                   patience  alarm /     by per-
            │                   threshold step        flow
            │                             timeout)    isolation
            │                                         in cli.ts;
            │                                         flow-result
            │                                         still
            │                                         written)
            │
            └─► AI judge confirmed step success_criteria
                or final step in flow completed.
```

## Where to extend

| Adding... | Touch... |
|---|---|
| A new AI provider | `src/ai/<provider>.ts` + register in `src/ai/index.ts`. |
| A new behavior template | `src/persona/templates/<id>.yaml`. The persona generator picks it up automatically. |
| A new third-party-embed false-positive class | `THIRD_PARTY_PREFIXES` in `src/runner/third-party-axe.ts`. |
| A new console-error category | `classifyConsoleMessage` in `src/runner/console-class.ts`. |
| A new persona-rule → axe rule mapping | `PERSONA_RULE_TO_AXE_ID` in `src/runner/axe-scan.ts`. |
| A new vetting strategy | `vetFromSession` in `src/report/vetter.ts`. |
| A new bench site | `bench/sites.json`. |
| A new PR-comment platform pattern | `PREVIEW_URL_PATTERNS` in `src/target/pr.ts`. |
| A new CLI subcommand | `cmd<Name>` function + dispatch case in `src/cli.ts` + help text. |

## Invariants

- **Surface awareness is end-to-end.** Once a persona has `surface: <id>`, every downstream phase respects it: flow generation reads `features`/`excluded_features`, run threads `storageState`, generator stamps `surfaceId` on findings, vetter loads the right `auth_state` for replay, cross-surface report buckets by surface.
- **Every AI call is cancellable.** Every provider threads `opts.signal` into its `fetch`. `withCancellableTimeout` wraps every runner AI call and every `src/init/*-generator.ts` propose call (default 120s) so timeouts actually cancel the in-flight fetch.
- **Every Playwright resource is released.** `runFlow`, `runPersona`, `vetter.openSession`, `cross-surface.vetCrossSurfacePatterns`, and `auth/capture.captureAuth` all wrap work in `try { ... } finally { closeWithTimeout(...) }`. A wallclock alarm force-closes the browser if the body never returns. The supervisor is the last-resort reaper: a worker that never closes its browser still has its process group SIGKILLed.
- **Every long await is bounded, cancellable, or both.** Setup ops have per-op wallclocks. AI calls run under `withCancellableTimeout`. Inner capture ops (`page.content`, CDP `Accessibility.*`, `page.title`) have 5s sentinels. `AxeBuilder.analyze()` is raced against 30s. All close paths swallow on 8s timeout. The supervisor watchdog backs the whole stack: 75s of silence kills the worker's process group.
- **Every finding is replayable.** Generator stamps `replayStrategy` on each finding (`axe_recheck` / `navigation_only` / `flow_replay` / `none`). The vetter uses that strategy to decide how to verify.
- **Every event is on one wire.** `src/events.ts` is the single union; producers emit through `setGlobalEventEmitter`; `text` and `jsonl` renderers consume independently.
- **Personas don't dramatize.** The judge prompt rejects aesthetic distaste as a give-up trigger. Persona voice is for evidence narration only. Give-ups are categorized into `bug | confusing_ux | feature_gap | not_a_bug`; the last two auto-downgrade severity.

## Tests

```bash
bun test
```

275 tests across 33 files. Each pure module has its own `.test.ts` next to it. Runner integration coverage lives in `src/runner/flow-runner.test.ts` (hermetic — `mock.module("playwright", ...)` + a `FakeProvider` that drains a typed response queue) and `src/runner/flow-supervisor.test.ts` (subprocess happy-path / silence-kill / non-zero-exit). Most other coverage is at the unit boundary (schema validation, filter logic, classifier accuracy, signature stability, event lifecycle ordering).

When extending: write the unit test before the wiring. Most regressions caught in this codebase were from changes to classifier regexes or signature stability under refactor — exactly the surface area unit tests defend cheaply.
