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

### `src/cli.ts`

Single-file CLI dispatcher. Parses argv, dispatches to `cmdInit`, `cmdFlows`, `cmdRun`, etc. Each command function lives in `cli.ts` itself (no per-command file) because the dispatch logic is small and keeping it together makes the help text + flag inventory easy to keep consistent.

### `src/ai/`

Provider abstraction.

- `provider.ts` — `AiProvider` interface with one method: `propose<T>(opts: ProposeOptions<T>): Promise<T>`. `ProposeOptions` carries `messages`, `schema`, `schemaName`, `schemaDescription`, optional `maxTokens` / `temperature`, **and `signal: AbortSignal`** so callers can cancel hung fetches.
- `cache.ts` — Disk cache (`.gauntlet/cache/ai/<sha256>.json`, mode `0600`). Keyed on the canonical JSON of `(provider, model, messages, schemaName, schemaDescription, maxTokens, temperature)`. Tracks `hits / misses / writes` for the run summary.
- `anthropic.ts`, `openai.ts`, `google.ts`, `ollama.ts` — One adapter per provider. Each threads `opts.signal` into its underlying `fetch`. The active provider is picked from the model name prefix.

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

`captureAuth({ cwd, surfaceId, url })` launches headed Chromium, waits for user to log in + press `Enter` in the terminal, calls `context.storageState()`, writes the JSON to `.gauntlet/auth/<id>.json` with `mode 0600` and the directory created `mode 0700`. Also exports `resolveAuthStatePath(cwd, authState)` which the runner uses to locate the file at run time (or skip with a warning if missing).

### `src/target/pr.ts`

`resolvePrUrl(prArg, cwd)` for `gauntlet run --pr <num>`:

1. Try `.gauntlet/config.json` `pr_url_template` first. Substitutes `{number}`, `{pr}`, `{branch}`, `{ref}`. Branch is **slugged** before interpolation (lowercase, non-alnum → `-`, 63-char DNS-label cap) so a hostile branch name can't produce a host-confusable URL.
2. Fall back to scanning the PR's comments for known preview-URL patterns (Vercel / Netlify / Render / Cloudflare Pages / Fly).
3. Validate the final URL: only `http(s)`, only a well-formed hostname. Reject anything else.

### `src/runner/`

Execution (Phase D).

- `flow-runner.ts` — The main loop. `runFlow({ url, persona, flow, ... })`. Launches chromium, sets persona-aware viewport + user agent + network throttling, threads `storageState` if the surface needs auth, runs the per-step loop, writes `flow-result.json`. Wallclock alarm fires `FLOW_WALLCLOCK_BUDGET_MS` after launch and force-closes the browser if anything wedges. All resources released in `finally`.
- `browser.ts` — Legacy single-step capture (pre-flows path; used when `--no-flows` or no curated flows exist for the persona).
- `step-judge.ts` — `judgeStep({ provider, page, step, ... })` AI call that returns `success | in_progress | give_up` with evidence. The system prompt is strict: `give_up` requires observable evidence (action failed, expected element absent, named give-up criterion observably fired). Persona voice is for narration tone, not abandonment trigger. Defaults to `in_progress` when uncertain.
- `capture.ts` — `captureStep(page, cdp, ctx, stepIndex)` writes screenshot, DOM, AX-tree, axe JSON, console + network logs to `steps/NNNN/`. Returns a `StepCapture` for downstream judgment.
- `axe-scan.ts` — `runAxe(page)` wraps `@axe-core/playwright`, tags violations with `thirdParty` / `thirdPartySource` (via `third-party-axe.ts`), and includes the persona-rule → axe-rule mapping (`PERSONA_RULE_TO_AXE_ID`).
- `third-party-axe.ts` — Detect axe nodes inside third-party iframe content (frame-pierced target chain) or matching known embed/CMP class prefixes (YouTube, Vimeo, Stripe Elements, Cloudflare Turnstile, reCAPTCHA, hCaptcha, Calendly, Intercom, Typeform, OneTrust, Cookiebot, Osano, TrustArc, Termly, Klaro, CookieYes).
- `external-host.ts` — Detect console errors whose message references an external host. Returns the hostname so callers can downgrade severity.
- `console-class.ts` — `classifyConsoleMessage(text)` buckets every console error into one of 8 classes (`csp_violation` with directive extracted, `extension_blocked`, `preload_unused`, `mixed_content`, `cookie_policy`, `network_error`, `uncaught_exception`, `unknown`).
- `page-settle.ts` — `waitForDomSettle(page, { quietMs, timeoutMs })`. Runs a `MutationObserver` inside the page, resolves after `quietMs` of zero mutations, capped by `timeoutMs`. Replaces `page.waitForLoadState("networkidle")` which is unreliable on SPAs that poll.
- `network-profiles.ts` — Bandwidth + latency profiles for `fast-fiber`, `home-wifi`, `slow-3g`, `office-wifi`, `intermittent`. Used via CDP `Network.emulateNetworkConditions`.
- `failure-reasons.ts` — Enum of every failure category the runner emits.

### `src/agent/`

The action loop primitives.

- `dom-outline.ts` — Walks the page's accessibility tree + DOM, returns a numbered `OutlineElement[]` of visible interactive elements. The AI sees the outline and picks by index.
- `actions.ts` — `observe(ctx, instruction)`, `act(ctx, instruction)`, `extract(ctx, instruction, schema)`. Each is an AI call against the outline. `ActionContext` carries `signal` (for cancellation) and `recentSteps` (last 3 `(intent, action, outcome)` tuples; the AI sees its prior attempts so it doesn't loop on a target that already failed).
- `LocatorPickSchema` and `ActionPickSchema` include a required `confidence: 0–100`. Below 60 the picked element degrades to `no_match` rather than committing to a wrong locator.

### `src/report/`

Reporting (Phases E, F).

- `schema.ts` — Zod `Finding`, `PersonaReport`, `RunReport`, `CrossSurfacePattern`. Findings carry an optional `surfaceId` so the vetter can resolve `auth_state`.
- `generator.ts` — `buildPersonaReport(runDir, personaId)`. Reads each flow's `flow-result.json`, dedups within a flow + across flows (axe rules keyed by `rule + url`), applies severity overrides (external-host console → minor, third-party axe → minor), and returns `PersonaReport`.
- `rollup.ts` — Cross-persona patterns within a single run.
- `cross-surface.ts` — Cross-surface patterns across multiple runs. Signature for non-axe findings includes the URL's path family + a normalized-message hash so unrelated `console_error` events on different routes don't collapse into one pattern. Optional `vetCrossSurfacePatterns()` replays the top-N axe patterns across each surface's `base_url` (auth-aware via `storageState`) and tags them `verified` iff they re-fire on a majority of surfaces.
- `vetter.ts` — `vetAll(findings, { cwd })`. Groups findings by `(url, auth_state)`, opens one Playwright context per group with `storageState` when the originating surface needs auth, replays axe / console-error checks, tags each finding `verified` / `regressed` / `subjective` / `could_not_replay`.
- `render-markdown.ts` — `REPORT.md` with severity badges + artifact paths.
- `build.ts` — Top-level orchestrator: `buildReport({ runDir, vet })` ties generator + rollup + vetter + render together.

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
            ┌──────────────────────────────┐
            │  chromium.launch + storage-  │
            │  State (if requires_auth)    │
            └──────────────────────────────┘
                        │
                        ▼
       ┌────────────────────────────────────────────┐
       │  for each step:                            │
       │                                            │
       │    observe(ctx, target)                    │
       │      └─► AI: pick element from outline     │
       │           with confidence 0-100            │
       │           (confidence < 60 = no_match)     │
       │                                            │
       │    act(ctx, intent)                        │
       │      └─► AI: choose action + element       │
       │           └─► Playwright: click/fill/...   │
       │                                            │
       │    waitForDomSettle(page, 400, 5000)       │
       │                                            │
       │    captureStep(page, cdp, ctx, i)          │
       │      └─► screenshot, DOM, AX-tree,         │
       │           axe.json, console, network       │
       │                                            │
       │    judgeStep({ provider, ... })            │
       │      └─► AI: success | in_progress |       │
       │             give_up (with evidence)        │
       │                                            │
       └────────────────────────────────────────────┘
                        │
                        ▼
               flow-result.json
                        │
                        ▼
                  generator.ts
                        │
                        ▼
                 PersonaReport
                        │
                        ▼
                    vetter.ts ─────────► [VERIFIED] / [regressed] / ...
                        │
                        ▼
                    REPORT.md
```

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
- **Every AI call is cancellable.** Every provider threads `opts.signal` into its `fetch`. Per-step timeouts wrap `observe`, `act`, `judgeStep` and abort on timeout.
- **Every Playwright resource is released.** `runFlow` uses an outer `try { ... } finally { closeWithTimeout(context); closeWithTimeout(browser) }`. A wallclock alarm force-closes the browser if the body never returns.
- **Every finding is replayable.** Generator stamps `replayStrategy` on each finding (`axe_recheck` / `navigation_only` / `flow_replay` / `none`). The vetter uses that strategy to decide how to verify.
- **Personas don't dramatize.** The judge prompt rejects aesthetic distaste as a give-up trigger. Persona voice is for evidence narration only.

## Tests

```bash
bun test
```

115 tests across 16 files. Each pure module has its own `.test.ts` next to it. The runner integration tests are minimal — most coverage is at the unit boundary (schema validation, filter logic, classifier accuracy, signature stability).

When extending: write the unit test before the wiring. Most regressions caught in this codebase were from changes to classifier regexes or signature stability under refactor — exactly the surface area unit tests defend cheaply.
