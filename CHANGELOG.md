# Changelog

All notable changes to Gauntlet are documented in this file.

The format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Changed

- **Confidence-thresholded observe → act** (PRIOR-ART Pattern A from
  Stagehand). Both `LocatorPickSchema` and `ActionPickSchema` gain a
  required `confidence: 0-100` field. The AI is prompted to reason
  about its certainty explicitly (90+ for unambiguous, 60-89 for
  reasonable, <60 for guessing). `observe()` and `act()` apply a
  threshold of 60: below that, the picked element degrades to
  `no_match` / action declined, with the confidence captured in
  reasoning. Stops the runner from cascading through act + judge after
  the AI hedged on a wrong locator.
- **Mutation-observer page-settle** (PRIOR-ART Pattern C). New
  `src/runner/page-settle.ts` `waitForDomSettle(page, {quietMs,
  timeoutMs})` installs a `MutationObserver` on `document.body` and
  resolves when N ms have passed without a DOM mutation, capped at a
  hard timeout. Replaces every `page.waitForLoadState("networkidle")`
  call in the flow runner. SPAs that poll (analytics, telemetry,
  websockets) no longer hold the wait open indefinitely.
- **Step memory in observe / act prompts** (PRIOR-ART Pattern D from
  browser-use). `ActionContext` gains a `recentSteps?: ReadonlyArray`
  of the last 3 `(intent, action, outcome, evidence)` tuples. flow-
  runner builds a rolling memo and threads it through every observe /
  act call. The AI sees what it just tried + how that turned out, so
  it stops re-picking a target that already failed.

- **Console errors now classified.** New `src/runner/console-class.ts`
  buckets every console error into one of 8 categories with a label and,
  for CSP violations, the offending directive name. Categories:
  `csp_violation` (with `cspDirective` extracted), `extension_blocked`,
  `preload_unused`, `mixed_content`, `cookie_policy`, `network_error`,
  `uncaught_exception`, `unknown`. Report titles now read "CSP font-src:
  Refused to load..." instead of "console_error: Refused to load...".
  Cross-surface signature still works because the message is still in
  the finding, but human-scannable noise dropped sharply. Closes
  `gauntlet-vu2`.
- **Cookie-consent banner findings tagged third-party.** Same false-
  positive shape as iframe embeds (CMPs inject DOM the host doesn't
  own, but directly into the page rather than via iframe). 7 CMPs
  detected by class/id prefix: OneTrust (`onetrust-`, `ot-sdk-`,
  `optanon-`), Cookiebot (`CybotCookiebotDialog`, `CookieConsent`),
  Osano (`osano-cm-`), TrustArc (`truste-`), Termly (`termly-`), Klaro
  (`klaro`), CookieYes (`cky-`). Auto-downgraded to minor + title
  suffix `[<source> banner]`. Closes `gauntlet-aua`.

- **Third-party iframe axe findings auto-tagged + downgraded.** Real-world
  dogfood (facets-sh PR #481) confirmed 8 axe findings (button-name +
  aria-prohibited-attr) lived entirely inside the YouTube embed — host
  site can't fix DOM it doesn't own, but those findings drowned out
  the 10 fixable findings in the same run. New `src/runner/third-party-
  axe.ts` detects via frame-pierced target chains (axe `target.length
  >= 2`) and a known-embed class/id prefix allowlist (youtube, vimeo,
  stripe-elements, cloudflare-turnstile, recaptcha, hcaptcha, calendly,
  intercom, typeform). Tagged violations propagate as
  `metadata.thirdParty` + `thirdPartySource` through the failure event;
  generator downgrades to severity=minor and appends e.g. `[youtube
  embed]` to the finding title. Closes `gauntlet-2fq`.

- **Step-judge now requires observable evidence for `give_up`.** Previous
  prompt let the AI bail for aesthetic reasons because the persona's
  voice / personality was framed as "judge as the persona would". Now
  the prompt is explicit: default to `in_progress`; `give_up` is only
  for objective blockers (last action FAILED with no recovery, expected
  element absent with no nav to it, or a specific give_up_criterion
  observably fired). Persona voice is for narration tone only, not a
  license to abandon. Cuts the dramatized-abandon noise that surfaced
  during Facet Cloud dogfood.
- **Flow generator instructs give_up_criteria to be OBSERVABLE blockers**
  ("submit button disabled with no error explanation"), not personality
  grumbles ("the page feels cluttered"). The judge ignores subjective
  criteria so the flow would otherwise just run in_progress forever.
- **`aiOpWithTimeout` retries once on `StepTimeoutError`.** Anthropic /
  OpenAI / Google 5xx + transient slowness is common; one fresh-signal
  retry catches it without hiding real hangs (the second timeout still
  bails cleanly).
- **Per-flow wallclock budget.** Hard cap at 5 minutes per flow,
  independent of per-step timeouts. A flow whose every step succeeds
  within 60s can't accumulate beyond the budget. Outcome is `timeout`.
- **Playwright default timeouts scale with persona network profile.**
  slow-3g now gets up to 90s selector / navigation defaults instead of
  the unscaled 30s, removing the "selector not found on slow network"
  false-negative class.

### Added

- **`docs/PRIOR-ART.md`** — survey of how Stagehand, browser-use,
  Skyvern, LaVague, Anthropic Computer Use, WebVoyager handle the same
  reliability problems Gauntlet has. Patterns A-I + ranked roadmap of
  the 7 next moves. Ground truth for "which research idea is worth
  borrowing next."

- **`gauntlet comment <run-dir> --pr <num>`**. Reads a built `report.json`
  and posts a compact, prioritized PR comment via `gh pr comment`: top
  findings ordered critical → minor, persona-abandon callouts, per-persona
  flow outcome roll-up. Optional `--artifact-base <url>` makes screenshot
  links resolve. `--dry-run` prints the body for inspection. Closes the
  loop so engineering teams see gauntlet in the same thread they read
  CI / lint / preview-deploy comments.
- **`examples/gauntlet.yml`** GitHub Actions workflow template. Drop into
  `.github/workflows/`, set `ANTHROPIC_API_KEY` repo secret, point preview-
  URL step at your platform, and gauntlet runs on every PR + comments
  top findings inline.
- **"How is this different from X?" comparison table** in README. Lays
  out the Gauntlet × {Synthetic Users, axe DevTools, browser-use,
  Stagehand} matrix so the unique row (personas + real browser + a11y +
  multi-surface + auth + PR integration) is visible at a glance.

### Fixed (codex review pass)

- **`gauntlet init` actually generates surfaces now.** The interactive
  init pipeline silently skipped surface discovery, so the documented
  workflow `init → flows → run --surface` went through curate, no
  surfaces landed on disk, then `--surface foo` found nothing. Now
  init runs Phase A2 (surface generation + write) between project read
  and persona generation. Reuses existing yamls; pass
  `--refresh-surfaces` to regenerate. Closes `gauntlet-3w2`.
- **Personas keep their surface tag.** `candidateToPersona` was dropping
  `surface` when converting from candidate to persona, so even when
  the AI assigned a surface during generation the written yaml had no
  surface field. Preserved now.
- **`gauntlet flows` is surface-aware.** Loads each persona's
  `surface` field and passes the matching `Surface` to `generateFlows`
  so flows respect the surface's `features` / `excluded_features`.
- **`withTimeout` actually cancels.** Per-step timeout was using
  `Promise.race` against a `setTimeout` — that only stopped *awaiting*,
  the in-flight AI fetch kept running and could mutate state after the
  flow had bailed. New `withCancellableTimeout` creates an
  `AbortController`, threads `signal` into all four providers
  (anthropic/openai/google/ollama) via `ProposeOptions.signal`,
  `ActionContext.signal`, `JudgeContext.signal`. observe/act/judgeStep
  call sites use it. Closes `gauntlet-yi0`.
- **`runFlow` no longer leaks browser handles on non-timeout errors.**
  Wrapped the entire post-launch body in `try { } finally {
  closeWithTimeout(context); closeWithTimeout(browser); }`. A schema
  parse error, provider crash, or disk-full writeFile now releases
  Playwright handles instead of leaving zombie Chromium processes.
  Closes `gauntlet-t2g`.
- **Vetter replays authenticated findings with `storageState`.** Findings
  carry an optional `surfaceId`; vetter resolves the surface's
  `auth_state` (cached), keys sessions by `(url, auth-state)` so two
  findings from different surfaces at the same URL don't share cookies,
  and creates contexts with `storageState`. Auth-walled findings are no
  longer downgraded to `could_not_replay`. Closes `gauntlet-7l0`.
- **Auth state + AI cache file permissions.** `.gauntlet/auth/` and
  `.gauntlet/cache/ai/` are now `mode 0o700` dirs with `mode 0o600`
  files. Cookies + cached prompts (which can contain authed page text)
  are no longer world-readable on shared boxes. Closes `gauntlet-bxx`.
- **PR URL template slugs branch names.** Raw branch interpolation
  let a hostile or malformed branch produce host-confusable URLs.
  `applyTemplate` now slugs branches (lowercase, non-alnum→`-`, trim,
  63-char cap). Final URL gated through `validatePreviewUrl` which
  rejects non-http(s) protocols and malformed hosts. Closes
  `gauntlet-a8f`.
- **Cross-surface signature uses path family + normalized message for
  non-axe findings.** Previously `console_error@https://m.com/` and
  `console_error@https://m.com/admin` collapsed to one "systemic"
  pattern even when the underlying messages were unrelated. Now the
  signature includes a 2-segment path family + a URL/hash/number-
  normalized message excerpt, so unrelated console errors stay
  distinct but the same browser-shimmed runtime error across surfaces
  still aggregates. Closes `gauntlet-1dc`.

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
