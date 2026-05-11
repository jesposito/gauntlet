# Gauntlet

A CLI that runs AI personas against a web app and records what they trip over.

Each persona is a YAML file with a character (name, age, context, voice, optional Big-Five profile) and a behavior model (device, viewport, network profile, input method, patience threshold, things they avoid or abandon on). The runner launches a Playwright browser per persona, drives the page, and captures a forensic snapshot at every step: screenshot, DOM, accessibility tree, console, network, and an axe-core scan.

Self-hosted. MIT. BYO AI key.

## Status

| Stage | Scope | State |
|---|---|---|
| 1 | Persona schema; Playwright runner; per-step capture (screenshot, DOM, AX-tree, console, network) | shipped |
| 2 | `gauntlet init`: project reader (Phase A) + AI persona curation (Phase B) against 8 behavior templates | shipped |
| 2.5 | axe-core scan at every captured step; persona `abandons_on` rules mapped to axe rule ids | shipped |
| 3 | Phase C: flow proposal per persona, curated | shipped |
| 4 | Phase D: isolated browser execution per persona with an action loop (`act` / `observe` / `extract`) on top of Playwright | shipped |
| 5 | Phase E + F: per-persona reports, cross-persona rollup, vetting layer that re-runs the replay before publishing | shipped |
| 6 | Surfaces: products have multiple audience-scoped views (marketing, tenant portfolio, tenant admin, ops). Personas + flows belong to a surface; `gauntlet run --surface <id>` auto-selects. | shipped |
| 7 | Auth-walled surfaces: storageState capture, `gauntlet auth`, runner threads `storageState` to `newContext`. | shipped |
| 8 | Flexible targeting: `--pr <num>`, `--features`, `--tags`, `--exclude-tags`, `--paths`, `--flows`. Filters compose with AND. | shipped |
| 9 | Cross-surface rollup: `gauntlet cross-report` identifies signatures that span 2+ surfaces (design-system bugs, systemic UX gaps). | shipped |
| 10 | Runner robustness: per-step timeouts, close-timeouts, per-flow exception isolation, post-goto hydration wait, external-host noise filter. | shipped |

Tracked in beads — `bd show gauntlet-tn8` for the polish epic, `bd ready` for what's next.

## Install

```bash
bun install
bunx playwright install chromium
```

## Usage

```bash
export ANTHROPIC_API_KEY=sk-ant-...

# Phase A: discover surfaces + curate personas. Pass every audience-scoped
# URL you can think of; gauntlet will propose surfaces from the evidence.
bun run src/cli.ts init \
  --url https://marketing.example.com \
        https://app.example.com \
        https://app.example.com/admin

# Optional: log in to surfaces that sit behind auth. Opens a headed
# Chromium, waits for you to log in, saves Playwright storageState to
# .gauntlet/auth/<id>.json and writes it back into the surface yaml.
bun run src/cli.ts auth tenant-admin

# Phase C: generate test flows per persona (surface-aware — flows respect
# the surface's features / excluded_features).
bun run src/cli.ts flows

# Phase D + E + F: run a single surface end-to-end.
bun run src/cli.ts run --surface marketing
bun run src/cli.ts run --surface tenant-admin   # uses captured auth

# Or against a PR preview, or filtered to one feature.
bun run src/cli.ts run --pr 123
bun run src/cli.ts run --surface marketing --features checkout --tags smoke

# Cross-surface rollup: signatures present on 2+ surfaces.
bun run src/cli.ts cross-report

# Rebuild a per-run report.
bun run src/cli.ts report
```

`gauntlet init` reads `README.md`, `package.json`, optionally fetches the URL, and asks the configured model to propose 8–12 persona candidates (mix of core and edge). It walks each one interactively:

```
--- candidate 1/6 [core] marcus-indie-dev ---
Marcus Liang, 31
context: Solo founder shipping a SaaS side-project who heard about Gauntlet
  on Hacker News.
voice: Direct, a little snarky.
device=laptop network=fast-fiber input=mouse viewport=1440x900
goals:
  - Find a sample bug report or demo output within 30 seconds
  - Confirm Gauntlet supports his AI provider and is actually self-hosted
  - Locate install instructions and copy the quick-start command
template: skeptical-first-timer
rationale: Catches whether the README answers the "is this real" question in
  the first screen.

[a/r/e/g/w/q]?
```

Actions: accept, reject, edit in `$EDITOR`, regenerate this slot, write-my-own, quit. Accepted personas land in `.gauntlet/personas/<id>.yaml`. Re-running `init` augments rather than replaces.

### Flags

```
gauntlet init         [--url <urls>] [--model <id>] [--count N] [--no-cache]
gauntlet flows        [--personas <ids>] [--model <id>] [--count N] [--url <url>]
gauntlet run          [<url> | --url <url> | --surface <id> | --pr <num>]
                      [--personas <ids>]
                      [--flows <ids>] [--features <names>]
                      [--tags <tags>] [--exclude-tags <tags>] [--paths <paths>]
                      [--steps <n>] [--headed] [--model <id>]
                      [--concurrency <n>] [--quiet]
                      [--no-cache] [--no-flows] [--no-report]
gauntlet auth         <surface-id> [--url <login-url>]
gauntlet surfaces
gauntlet cross-report [--surfaces <ids>] [--runs <dirs>]
gauntlet report       [<run-dir>] [--run <path>] [--no-vet]
gauntlet list
```

## Behavior templates

The 8 skeletons `init` instantiates against the project:

| Template | Label |
|---|---|
| `low-digital-confidence` | core |
| `low-reading-level` | core |
| `skeptical-first-timer` | core |
| `high-impatience-mobile` | core |
| `keyboard-only` | edge |
| `screen-reader-via-ax-tree` | edge |
| `slow-3g-mobile` | edge |
| `power-user-fuzzer` | edge |

Templates describe a behavior pattern only. The AI fills in `character` (name, voice, context, OCEAN axes) specific to the project.

## Surfaces

A non-trivial product isn't one URL. A SaaS has marketing, customer-facing artifact pages, an authenticated admin panel, sometimes an ops/internal surface. Each has a different audience, different features, and different "what counts as broken."

`gauntlet init` proposes a list of **surfaces** from the URLs you fetch plus the README. Each surface gets a yaml at `.gauntlet/surfaces/<id>.yaml`:

```yaml
id: tenant-admin
name: Creator admin panel
base_url: https://jed.example.com/admin
audience: The paying customer managing their own site content and monetization.
features: [edit profile, author blog posts, build courses, manage projects]
excluded_features: [other tenants' data, platform marketing copy, infra controls]
requires_auth: true
login_url: https://jed.example.com/login
auth_state: .gauntlet/auth/tenant-admin.json
```

Personas get a `surface:` field so they're scoped to one audience. `gauntlet run --surface tenant-admin` auto-selects every persona tagged with that surface and runs them against `base_url`, using `auth_state` if present.

## Auth-walled surfaces

`gauntlet auth <surface-id>` opens a headed Chromium window at the surface's `login_url`, waits for you to log in normally, then saves Playwright `storageState` (cookies + localStorage) to `.gauntlet/auth/<id>.json` and writes the path back into the surface yaml.

After that, every `gauntlet run --surface <id>` (or any persona whose `surface:` field matches) launches its browser context with `storageState: <saved>`, so the persona starts already-logged-in.

If a surface has `requires_auth: true` but no captured `auth_state` yet, `gauntlet run` prints a clear warning and tells you which command to run.

## Flexible targeting

`gauntlet run` composes target source + persona selection + flow filtering. Examples:

```bash
# Marketing site, one persona, one flow.
gauntlet run --surface marketing --personas mary --flows mary--save-recipe

# Every persona on the admin surface, but only smoke-tagged flows.
gauntlet run --surface tenant-admin --tags smoke

# A PR preview deploy, just the checkout feature.
gauntlet run --pr 123 --features checkout

# Critical-tagged flows, but skip the slow accessibility-deep ones.
gauntlet run --surface marketing --tags critical --exclude-tags slow
```

`--pr <num>` resolves the preview URL from a configurable `.gauntlet/config.json` `pr_url_template` (`{number}`, `{branch}`, `{pr}`, `{ref}` substitutions) or, failing that, scans the PR's comments for Vercel / Netlify / Render / Cloudflare Pages / Fly preview URL patterns.

## Cross-surface patterns

A product with N surfaces has two interesting axes of finding: per-surface (bugs scoped to one audience) and cross-surface (signatures that appear on 2+ surfaces).

`gauntlet cross-report` picks the latest run per curated surface, aggregates findings, and writes `.gauntlet/CROSS-REPORT.md`. The headline output is the list of signatures that span 2+ surfaces — usually design-system tokens (color-contrast on marketing + portfolio + admin = one CSS variable, not three bugs) or systemic UX gaps.

```
top cross-surface patterns:
  console_error            4 surfaces, 28 findings (demo, marketing, tenant-admin, tenant-portfolio)
  abandoned_by_persona     4 surfaces, 9 findings  (...)
  axe:color-contrast       3 surfaces, 7 findings  (demo, marketing, tenant-portfolio)
```

External-resource console errors (third-party hosts like `fonts.googleapis.com`) are auto-tagged and downgraded to `severity=minor` so they don't drown out real product findings.

## How accessibility findings are surfaced

axe-core runs on every captured step (output: `steps/NNNN/axe.json`).

- Serious and critical axe violations become `FailureReason.ACCESSIBILITY_VIOLATION` events.
- Persona `abandons_on` / `avoids` entries map to axe rule ids via `PERSONA_RULE_TO_AXE_ID` (e.g. `form_field_missing_label` → axe `label`, `unlabeled_icon_buttons` → axe `button-name`). When axe sees the rule and the persona was watching for it, the failure is reported as `ABANDONED_BY_PERSONA` with the axe rule id attached.

## Vetting layer

After a run, every finding is replayed before it lands in `REPORT.md`:

- **axe** findings: re-navigate to the captured URL, re-run axe, assert the same rule id is still in the violations. Pass → `[VERIFIED]`. No longer present → `[regressed]` (likely stale or flaky).
- **HTTP 5xx / console errors**: re-navigate to the URL and check whether the same noisy condition fires. Pass → `[VERIFIED]`.
- **Persona-judge** findings (`ABANDONED_BY_PERSONA` via the AI step verdict): flagged `[subjective]` for human triage. Full flow-replay vetting is on the roadmap.
- **Navigation timeouts** and other transient failures: flagged `[subjective]`.

The vetter groups findings by URL and shares one browser across the batch, so a run with N findings at K distinct URLs costs K navigations, not N.

Output: `REPORT.md` (severity-sorted markdown with badges + artifact paths) and `report.json` (machine-readable) at the run directory.

## AI providers

| Provider | Model prefix | Env var |
|---|---|---|
| Anthropic | `claude-` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-`, `o1-`, `o3-` | `OPENAI_API_KEY` |
| Google | `gemini-` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| Ollama | `ollama/`, `llama`, `qwen`, `mistral`, `deepseek` | `OLLAMA_HOST` (default `http://localhost:11434`) |

Default model: `claude-opus-4-7`. Responses are cached on disk at `.gauntlet/cache/ai/` keyed on `(provider, model, messages, schema, maxTokens, temperature)`. The prompt includes the DOM outline, so cache entries naturally invalidate when the page changes. Pass `--no-cache` to disable. `gauntlet run` prints a cache hit-rate line in its summary so a fast run advertises whether it's real or replayed.

## Layout

```
src/
  cli.ts                       # init | flows | run | report | surfaces | auth | cross-report | list | help
  ai/
    provider.ts                # interface + registry + caching decorator
    cache.ts                   # sha256-keyed disk cache + hit/miss stats
    anthropic.ts, openai.ts, google.ts, ollama.ts
  init/
    project-reader.ts          # Phase A; multi-URL landings[], login-wall hints
    persona-generator.ts       # Phase B AI call
    surface-generator.ts       # discovers surfaces from project + landings
    flow-generator.ts          # Phase C AI call (per persona, surface-aware)
    curate.ts                  # persona curation loop
    curate-flows.ts            # flow curation loop
  persona/
    schema.ts                  # zod Persona / Character / Behavior / OCEAN
    templates/*.yaml           # 8 behavior skeletons
    templates.ts               # template loader
    loader.ts                  # curated -> built-in -> path resolution
    library/mary.yaml          # worked example
  surface/
    schema.ts                  # zod Surface (base_url, audience, features, auth)
    loader.ts                  # read/write/list .gauntlet/surfaces/
  flow/
    schema.ts                  # zod Flow / FlowStep (with feature/tags/paths)
    loader.ts                  # read/write/list flows under .gauntlet/flows/
    filter.ts                  # --features / --tags / --paths filters
  agent/
    dom-outline.ts             # numbered outline of visible interactive elements
    actions.ts                 # act / observe / extract primitives
  auth/
    capture.ts                 # gauntlet auth: headed login + storageState dump
  target/
    pr.ts                      # --pr <num>: gh PR comments -> preview URL
  runner/
    browser.ts                 # legacy single-step capture
    flow-runner.ts             # Phase D; per-step timeouts; storageState wiring
    step-judge.ts              # AI step verdict
    capture.ts                 # per-step forensic snapshot
    axe-scan.ts                # axe-core + persona-rule mapping
    external-host.ts           # detect third-party hosts in console errors
    network-profiles.ts        # fast-fiber, home-wifi, slow-3g, ...
    failure-reasons.ts         # FailureEvent enum
  report/
    schema.ts                  # zod Finding / PersonaReport / RunReport
    generator.ts               # flow-result.json -> Findings (with dedup + noise filter)
    rollup.ts                  # cross-persona patterns
    cross-surface.ts           # cross-surface rollup (gauntlet cross-report)
    vetter.ts                  # replay verification (URL-grouped)
    render-markdown.ts         # REPORT.md
    build.ts                   # top-level orchestrator

.gauntlet/
  surfaces/                    # curated audience-scoped views
  personas/                    # curated roster (each has surface:)
  flows/                       # curated flows per persona
  auth/                        # captured storageState per surface (gitignored)
  cache/ai/                    # AI response cache (gitignored)
  CROSS-REPORT.md              # cross-surface rollup (after `gauntlet cross-report`)
  cross-report.json
  runs/<ts>/                   # artifacts per run
    REPORT.md                  # vetted, severity-sorted markdown
    report.json                # machine-readable
    <persona>/<flow>/
      flow-result.json         # includes surface: when set
      video/
      steps/0000/
        screenshot.png
        dom.html
        ax-tree.json
        axe.json
        console.jsonl
        network.jsonl
```

## Related tools

- [browser-use](https://github.com/browser-use/browser-use) — agents that complete tasks on the web.
- [Stagehand](https://github.com/browserbase/stagehand) — SDK for building browser agents (`act` / `observe` / `extract`).
- [axe-core](https://github.com/dequelabs/axe-core) — the WCAG checker Gauntlet calls at each step.
- [Synthetic Users](https://www.syntheticusers.com/) — AI personas for interviews/surveys (no browser actions).

## License

MIT
