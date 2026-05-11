# Changelog

All notable changes to Gauntlet are documented in this file.

The format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- **`gauntlet bench`: WebVoyager-style benchmark harness.** Loops over a
  fixed list of public SaaS landing pages
  (`bench/sites.json`, 12 sites by default), runs `gauntlet seed` + flow
  execution + per-site report for each, and writes a single aggregate
  table to `.gauntlet/bench/bench-<date>.md`. Filters: `--limit N`,
  `--only <names>`. Each site gets its own scratch `.gauntlet/` under
  `bench-tmp/<name>/` so the bench doesn't pollute the host repo.
  Per-site report files are unvetted at bench scale. Closes
  `gauntlet-tn8.4`.
- **`gauntlet seed`: non-interactive bootstrap.** Runs Phase A
  (surfaces) + Phase B (personas distributed across surfaces) + Phase C
  (flows per persona) end-to-end without the curate-loop prompts.
  Replaces project-specific `scripts/dogfood-*.ts` boilerplate. Usage:
  `gauntlet seed [<cwd>] --url <urls> [--personas N] [--flows N]`.
  Closes `gauntlet-s68`.
- **`gauntlet cross-report --vet`: cross-surface vetter.** For each
  top-N axe pattern in the rollup, launches one Playwright browser,
  visits each surface's `base_url` once, runs axe, and tags the pattern
  `verified` iff its rule re-fires on a majority of surfaces (`regressed`
  otherwise). Honors per-surface `auth_state` for behind-login surfaces.
  Non-axe patterns (console_error, abandoned_by_persona) are tagged
  `subjective` since they need flow-replay. CROSS-REPORT.md gets a
  per-pattern vetting badge column. Closes `gauntlet-sis`.
- **Auto-probe common URL paths during init.** `gauntlet init --url <site>`
  now also probes `/admin`, `/admin/login`, `/login`, `/signin`,
  `/dashboard`, `/pricing`, `/app`, and `/_/login` on each user-supplied
  origin. 200 / 301 / 302 / 401 / 403 responses are fetched as additional
  landings and fed to the surface generator so it can propose
  admin/internal surfaces without the user having to know the right URL.
  404s and network errors are dropped silently. Disable with `--no-probe`.
  Closes `gauntlet-z1q`.
- **Cross-surface report.** New `gauntlet cross-report [--surfaces <ids>]
  [--runs <dirs>]` aggregates the latest run per curated surface and
  surfaces the signatures that span ≥2 surfaces — the highest-leverage
  fixes (a `color-contrast` hit on marketing + admin + portfolio is one
  design-system token, not three separate bugs). Writes
  `.gauntlet/CROSS-REPORT.md` + `.gauntlet/cross-report.json`.
  Falls back to `.gauntlet/personas/<id>.yaml` `surface:` field when
  flow-result.json lacks a surface (pre-surface runs).
- **External-resource noise filter.** Console errors that reference a
  host outside the page's registrable domain (Google Fonts, third-party
  CDNs, etc) get tagged with `metadata.externalHost` and are downgraded
  to severity=minor in the report. Stops drowning real product findings
  in fonts.googleapis.com noise.
- **AI cache hit-rate stats.** `gauntlet run` summary now shows
  `cache: hits=N misses=N writes=N (P% hit-rate)` so it's obvious whether
  a fast run is real or replayed.
- **`flow-result.json` includes surface.** Run output captures the
  surface id when known, so cross-surface tooling no longer has to guess.

- **Surfaces.** A product is no longer modelled as a single URL. `gauntlet
  init` now produces `.gauntlet/surfaces/<id>.yaml` describing each
  distinct audience-scoped view (marketing, tenant portfolio, tenant
  admin, ops admin, etc). Personas can be tagged with a `surface`.
  `gauntlet run --surface <id>` auto-selects every persona on that
  surface and uses `surface.base_url`. `gauntlet surfaces` lists curated
  surfaces.
- **Multi-URL discovery.** `gauntlet init --url <a> <b> ...` fetches each
  landing and feeds all of them to the AI surface generator. Pages that
  401 / 403 or look like login walls are flagged with a `hint` so the AI
  reasons about auth-walled surfaces from evidence rather than README
  hand-waving.
- **Auth state for behind-login surfaces.** Surfaces gain
  `requires_auth`, `auth_state`, `login_url`. `gauntlet auth <surface-id>`
  opens headed Chromium, waits for the user to log in and press Enter,
  saves Playwright `storageState` to `.gauntlet/auth/<id>.json`, and
  writes the path back into the surface yaml. `gauntlet run` resolves
  that file per persona's surface and passes `storageState` to
  `newContext`, so subsequent navigation is authed.
- **Flexible `gauntlet run` targeting.** New target sources and filters:
  - `--pr <num>` resolves the preview URL from a configurable
    `.gauntlet/config.json` `pr_url_template` or by scanning PR comments
    for Vercel / Netlify / Render / Cloudflare Pages / Fly preview URLs.
  - `--flows / --features / --tags / --exclude-tags / --paths` compose
    with AND (`--tags` is OR within group). Flow schema gains optional
    `feature`, `tags`, `paths` fields. AI flow generator populates them
    when the surface declares its features.

### Fixed

- **Step operations no longer hang the run.** Every AI call in the flow
  loop (`observe`, `act`, `captureStep`, `judgeStep`, including the
  previously-unwrapped `captureStep` in the observe-give_up branch) is
  now bounded by a 60s `withTimeout`. On timeout the flow ends
  `outcome=timeout` (new variant) and the pool slot is freed. Previously
  a hung Playwright operation could keep the run alive indefinitely with
  no `flow_end` event.
- **Browser cleanup can't hang the run.** `context.close()` and
  `browser.close()` are wrapped with an 8s timeout each; failure is
  swallowed so a wedged Chromium process is preferable to a hung run.
- **Per-flow exception isolation.** `cmdRun` now wraps each `runFlow` in
  try/catch. A single Playwright `Target page, context or browser has
  been closed` exception no longer kills the entire concurrent pool;
  the crashed flow is written as `outcome=error` with a synthetic
  `uncaught_exception` failure so it still appears in the report.
- **End-of-run summary line.** `gauntlet run` prints a per-outcome tally
  before the report build step, plus a warning when every flow ended
  `outcome=error` (almost always a credential / network setup issue, not
  a real product finding).

## 0.1.0 — 2026-05-11

First end-to-end release. All six phases of the gated pipeline are now wired
up: project read → persona curation → flow curation → execution → reports →
vetting.

### Added

- **`gauntlet init`** (Phase A + B). Reads `README.md`, `package.json`,
  optionally fetches a landing URL (bounded to ~30KB total), then asks the
  configured model to propose 8–12 candidate personas. Interactive curation:
  accept / reject / edit-in-`$EDITOR` / regenerate-this-slot / write-my-own /
  quit. Accepted personas are written to `.gauntlet/personas/<id>.yaml`.
  Re-running augments rather than replaces.
- **8 behavior templates** (4 core + 4 edge): `low-digital-confidence`,
  `low-reading-level`, `skeptical-first-timer`, `high-impatience-mobile`,
  `keyboard-only`, `screen-reader-via-ax-tree`, `slow-3g-mobile`,
  `power-user-fuzzer`. Templates describe behavior only; the AI fills in
  `character` (name, voice, OCEAN axes) per project.
- **`gauntlet flows`** (Phase C). For each curated persona, asks the AI for
  2–4 short test flows the persona would attempt on the product. Curate
  per-flow with the same accept / reject / edit / regen / skip loop. Flows
  written to `.gauntlet/flows/<id>.yaml`.
- **`gauntlet run`** (Phase D). For each `(persona, flow)`, launches a
  fresh Playwright context matching the persona's viewport / device /
  network / input mode, then drives every step through the action loop:

      observe(observation_target)  // fail-fast if target absent
      act(intent)                  // click / fill / press / select /
                                   //   scroll_to / hover via AI-resolved
                                   //   Playwright locator
      captureStep                  // screenshot, DOM, AX-tree, axe,
                                   //   console, network
      judgeStep                    // AI verdict: success | in_progress |
                                   //   give_up, in the persona's voice

  Termination: all steps succeed (`completed`), judge returns give_up
  (`abandoned`), persona patience exceeded (`patience_exceeded`), or
  navigation fails (`error`).
- **`gauntlet report`** (Phase E + F). Aggregates `flow-result.json` files
  into per-persona reports plus a cross-persona rollup (findings seen by
  ≥2 personas are surfaced as patterns). Emits `REPORT.md` (severity-sorted
  markdown with badges + artifact paths) and `report.json` (machine
  readable). `gauntlet run` auto-builds the report; skip with `--no-report`.
- **Vetting layer**. Every finding is replayed before it lands in the
  report. axe findings re-navigate + re-axe and assert the same rule id is
  still present (`[VERIFIED]` or `[regressed]`). HTTP 5xx and console errors
  re-navigate and check whether the noisy condition still fires.
  Persona-judge findings and navigation timeouts are flagged
  `[subjective]` for human triage. The vetter groups findings by URL and
  shares one browser across the batch — N findings at K distinct URLs cost
  K navigations, not N. Disable with `--no-vet`.
- **axe-core at every captured step**. Output: `steps/NNNN/axe.json`.
  Serious + critical violations become `ACCESSIBILITY_VIOLATION` failures.
  `PERSONA_RULE_TO_AXE_ID` maps persona `abandons_on` / `avoids` rules to
  axe rule ids (e.g. `form_field_missing_label` → `label`,
  `unlabeled_icon_buttons` → `button-name`). When axe sees the rule and
  the persona was watching for it, the failure is reported as
  `ABANDONED_BY_PERSONA` with the axe rule id attached.
- **AI provider abstraction** with adapters for Anthropic (default),
  OpenAI, Google Gemini, and Ollama. One `--model <id>` flag picks the
  provider via prefix.
- **AI decision cache**. Every provider is wrapped in a `CachingProvider`
  decorator. sha256 key on `(provider, model, messages, schema, maxTokens,
  temperature)`. Disk-backed at `.gauntlet/cache/ai/`. Cache hits revalidate
  through the zod schema. Toggle with `--no-cache`. Cold run ~30s, warm
  ~0.5s for an identical persona-generation request.
- **OCEAN personality** (optional) on `character`. Big Five axes 0-100,
  shape voice and abandonment behavior.
- **Stagehand-style `act` / `observe` / `extract` primitives** under
  `src/agent/`. AI-resolved Playwright locators on top of a numbered DOM
  outline. `extract<T>(...)` introspects the zod schema and shows the AI
  the exact field shape so output matches required field names.
- **Unit test suite** (32 tests, 6 files) covering persona/OCEAN schemas,
  axe persona-rule mapping, report rollup, AI cache, project reader, and
  DOM outline summarization. Runs in `bun test` in 121ms.
- **GitHub Actions CI** at `.github/workflows/ci.yml`: typecheck +
  unit tests on push to main and on PR.

### Fixed

- Anthropic Opus 4.7 deprecated `temperature`; the adapter now omits it
  for `opus-4-{7,8,9}` and `sonnet-4-{6+}` models.
- Persona generator prompt now embeds the exact JSON shape and pins
  required behavior field names (the AI was renaming
  `patience_threshold_seconds` → `patience_seconds`).
- Flow `starting_url_hint` accepts `null` from the AI and coerces to
  `undefined` (was rejected under `exactOptionalPropertyTypes`).
- `loadFlowsForPersona` now filters on `flow.persona_id` instead of
  filename prefix — the AI sometimes shortens persona ids in flow
  filenames.
- `captureStep` bounds the per-step screenshot to 10s with a 4s fallback
  pass that disables animations; a transient streaming page no longer
  fails the whole run.
- `gauntlet run` now `process.exit(0)`s after work completes; HTTP
  keepalive sockets from the Anthropic SDK were holding the event loop
  open after legitimate completion.
