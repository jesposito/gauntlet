# Gauntlet

**Drive AI personas through your web app. Find the failures real users would hit before they hit them.**

Every accessibility tool tells you what `axe-core` already tells you. Every "AI agent" tool drives a browser but has no theory of who's using it. Gauntlet sits in the middle: an impatient mobile creator, a skeptical first-time visitor, a keyboard-only screen-reader user, each one trying to complete a real task on your real app. The runner captures everything they tripped over — screenshots, DOM, axe-core violations, console errors, network failures, and the persona's own verdict on whether they would've given up.

Self-hosted. MIT. Bring your own AI key.

```bash
bun install && bunx playwright install chromium
export ANTHROPIC_API_KEY=sk-ant-...
bun run src/cli.ts init --url https://your-app.com
bun run src/cli.ts run --surface marketing
bun run src/cli.ts report
```

---

## What it actually finds

To validate the design, Gauntlet was dogfooded against a real multi-tenant creator platform with four distinct surfaces (marketing site, customer portfolios, creator admin panel, and a public demo). The first pass produced **49 findings**. Triaging them and shipping one afternoon's PR closed 10 real bugs:

| Surface | Pre-fix findings | Post-fix findings | What landed |
|---|---:|---:|---|
| Marketing landing | 11 | 5 | CSP `font-src` + `connect-src` widened; landing page color contrast; pricing page color contrast x3 |
| Customer portfolio | 12 | **2** | Google Fonts CSP unblocked (−10 findings) |
| Creator admin panel | 14 | **2** | Admin sidebar touch-target size; setup-wizard duplicate landmarks; markdown editor surface gaps logged |
| Demo site | 13 | 5 | `select-name` aria-labelledby fix; certifications-section color-contrast token swap |

8 findings flagged as YouTube-iframe false positives → now auto-downgraded to `[minor]` with title suffix `[youtube embed]` so they no longer compete with real bugs. Verified post-deploy by re-running gauntlet against the production build: the 10 fixed findings dropped out cleanly.

That's the loop: **drive → record → fix → verify**. Repeat on every PR.

---

## How is this different?

| | Gauntlet | [Synthetic Users](https://www.syntheticusers.com/) | [axe DevTools](https://www.deque.com/axe/devtools/) | [browser-use](https://github.com/browser-use/browser-use) | [Stagehand](https://github.com/browserbase/stagehand) |
|---|:---:|:---:|:---:|:---:|:---:|
| AI personas (character + behavior model) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Drives a real Playwright browser | ✅ | ❌ | ❌ | ✅ | ✅ |
| `axe-core` scan at every step | ✅ | ❌ | ✅ | ❌ | ❌ |
| Multi-surface (marketing / app / admin / ops) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Auth-walled surfaces (`storageState` replay) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Cross-surface rollup (design-system patterns) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Per-PR integration (`--pr` + GitHub Action) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Persona judge (would this user actually give up?) | ✅ | partial | ❌ | ❌ | ❌ |
| Vetting layer (replay every finding before publishing) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Self-hosted, MIT, BYO AI key | ✅ | ❌ | partial | ✅ | ✅ |

Adjacent tools worth knowing: [Playwright](https://playwright.dev) is the browser driver Gauntlet sits on; [Pa11y](https://pa11y.org) runs axe without personas; [Maze](https://maze.co) hires human testers. See [`docs/PRIOR-ART.md`](docs/PRIOR-ART.md) for the deeper survey, including the reliability patterns Gauntlet borrowed from the field.

---

## When to use Gauntlet

- Before shipping a marketing site you want to convert visitors who **aren't** you.
- Before merging a frontend PR that changed a critical flow (signup, checkout, content creation).
- After a redesign, to catch the accessibility regressions you didn't see because you saw the design 100 times.
- As a recurring CI check that posts findings inline on every PR.
- As a one-off audit of any public web app (drop a URL in, get a forensic report).

## When NOT to use it

- You need user research on **what to build**. Gauntlet tests UX of what already exists. Use Synthetic Users or real interviews for product discovery.
- You need a deterministic regression suite. Gauntlet personas make different choices each run (the cache makes them repeat the same choice once the page is unchanged, but a redesigned page produces fresh judgement). Use Playwright tests directly for "click these N selectors and assert these N outcomes."
- The page is fully native / canvas / WebGL. axe and DOM-driven personas can't see what they can't read.

---

## Five-minute quickstart

```bash
# 1. Install
bun install
bunx playwright install chromium
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY, or GEMINI_API_KEY

# 2. Discover surfaces and curate personas (interactive)
bun run src/cli.ts init \
  --url https://your-app.com \
        https://your-app.com/admin

# Gauntlet probes /admin, /login, /pricing, /dashboard automatically on
# each origin, proposes 2–6 audience-scoped "surfaces", then proposes
# 8–12 personas. You accept/reject/edit each one.

# 3. Generate test flows per persona (interactive)
bun run src/cli.ts flows

# 4. Capture login state for auth-walled surfaces (headed browser)
bun run src/cli.ts auth tenant-admin
# (a window opens — you log in normally — press Enter — done)

# 5. Run gauntlet on one surface end-to-end
bun run src/cli.ts run --surface marketing

# 6. Build a vetted report
bun run src/cli.ts report

# Output:
#   .gauntlet/runs/<timestamp>/REPORT.md
#   .gauntlet/runs/<timestamp>/<persona>/<flow>/
#       flow-result.json
#       video/page.webm
#       steps/0000/screenshot.png
#       steps/0000/axe.json
#       ...
```

Need to skip the interactive curate loops? Use `gauntlet seed` — same pipeline, accepts every AI suggestion:

```bash
bun run src/cli.ts seed --url https://your-app.com --personas 4 --flows 2
```

---

## Core concepts

### Surfaces
A real product isn't one URL. A multi-tenant SaaS typically has a marketing site (`yourapp.com`), customer-facing artifact pages (`{tenant}.yourapp.com`), a customer admin panel (`{tenant}.yourapp.com/admin`), and an internal ops surface (`admin.yourapp.com`). Each has a different audience, a different feature set, and a different "what counts as broken." Gauntlet models that with **surfaces**:

```yaml
# .gauntlet/surfaces/tenant-admin.yaml
id: tenant-admin
name: Creator admin panel
base_url: https://acme.yourapp.com/admin
audience: The paying customer managing their site content and monetization.
features: [edit profile, author blog posts, build courses, manage projects]
excluded_features: [other tenants' data, platform marketing copy]
requires_auth: true
login_url: https://acme.yourapp.com/login
auth_state: .gauntlet/auth/tenant-admin.json
```

Personas carry a `surface:` field. Flows respect `features` and `excluded_features` (the AI won't propose a flow that looks for pricing on a customer portfolio page).

### Personas
Each persona is a YAML file describing a real archetype: a **character** (name, age, context, voice, optional Big Five personality) and a **behavior model** (device, viewport, network profile, input method, patience threshold, things they prefer / avoid / abandon on). Personas are generated by AI from your project context + a built-in library of eight behavior templates:

| Template | Label | Use case |
|---|---|---|
| `skeptical-first-timer` | core | First-impression credibility |
| `low-digital-confidence` | core | Trust signals, scannability |
| `low-reading-level` | core | Plain-language clarity |
| `high-impatience-mobile` | core | Above-the-fold conversion |
| `keyboard-only` | edge | Tab order, focus management |
| `screen-reader-via-ax-tree` | edge | Semantic landmarks, labels |
| `slow-3g-mobile` | edge | LCP, CLS, perceived latency |
| `power-user-fuzzer` | edge | Stress edges, paste-formatted-text, RTL |

The AI fills in `character` per project. The behavior templates stay generic.

### Flows
A **flow** is a short scripted journey one persona attempts: ordered steps with intent, success criteria, and observable give-up conditions. The runner uses an `observe → act → capture → judge` loop on each step:

- **observe** — find the element matching the persona's intent (with confidence threshold, recent-step memory, retry).
- **act** — click / fill / press / select / scroll_to / hover via Playwright.
- **capture** — screenshot + DOM + accessibility tree + axe-core + console + network.
- **judge** — AI verdict: success / in_progress / give_up. The judge demands observable evidence for give_up; aesthetic distaste alone is rejected.

### Runs, reports, vetting
A `gauntlet run` produces a timestamped run directory. `gauntlet report` synthesizes per-persona reports + cross-persona patterns + a vetting pass that re-replays every finding before publishing:

- **axe findings** — re-navigate to the captured URL, re-run axe, assert the rule still fires. `[VERIFIED]` or `[regressed]`.
- **Console errors / HTTP 5xx** — re-navigate, see if the error reappears.
- **Persona abandons** — flagged `[subjective]` for human triage (full flow replay is on the roadmap).
- **Cross-surface rollup** — `gauntlet cross-report` identifies signatures that appear on 2+ surfaces (almost always design-system tokens or systemic UX gaps).

Output: `REPORT.md` (severity-sorted, with badges + artifact paths) and `report.json` (machine-readable).

---

## Commands

```
gauntlet init                # Phase A (project + surfaces) + Phase B (personas) — interactive
gauntlet flows               # Phase C (flows per persona) — interactive
gauntlet seed                # Non-interactive init + flows; accepts every AI suggestion
gauntlet auth <surface-id>   # Headed login capture → .gauntlet/auth/<id>.json
gauntlet run                 # Phase D (execute) + E + F (per-run report + vetting)
gauntlet report              # Rebuild a report from a run directory
gauntlet surfaces            # List curated surfaces
gauntlet list                # List curated personas + flows
gauntlet cross-report        # Aggregate signatures across surfaces → CROSS-REPORT.md
gauntlet bench               # Run gauntlet against a fixed list of public sites
gauntlet comment             # Post top findings as a GitHub PR comment
gauntlet help
```

### `gauntlet init`

```
gauntlet init [--url <urls>]
              [--skip-surfaces | --refresh-surfaces]
              [--skip-personas] [--surface <id>] [--replace-personas]
              [--model <id>] [--count N]
              [--no-cache] [--no-probe]
```

- `--url` accepts multiple values: `--url https://m.com https://m.com/admin`. Gauntlet fetches each, plus auto-probes `/admin /login /pricing /dashboard /signin /app /_/login` on every origin (use `--no-probe` to disable). 401/403 responses + login-form heuristics get flagged so the surface generator infers `requires_auth=true`.
- `--skip-surfaces` reuses existing curated surfaces. Use when surfaces are good but you want fresh personas.
- `--refresh-surfaces` regenerates surfaces even when curated. Use when surfaces need rework.
- `--skip-personas` exits after Phase A2 (surfaces only).
- `--surface <id>` narrows persona generation to one surface (for under-served audiences).
- `--replace-personas` drops existing curated personas before regen (scoped by `--surface` when set).
- `--model` picks the AI provider from the prefix; see [AI providers](#ai-providers).

### `gauntlet flows`

```
gauntlet flows [--personas <ids>] [--surface <id>] [--replace]
               [--model <id>] [--count N] [--url <url>] [--no-cache]
```

- `--personas` is comma-separated. Defaults to every curated persona.
- `--surface <id>` filters personas to those on one surface.
- `--replace` drops existing flows for the selected personas before regen.

### `gauntlet run`

```
gauntlet run [<url> | --url <url> | --surface <id> | --pr <num>]
             [--personas <ids>]
             [--flows <ids>] [--features <names>]
             [--tags <tags>] [--exclude-tags <tags>] [--paths <paths>]
             [--steps <n>] [--headed] [--model <id>]
             [--concurrency <n>] [--quiet]
             [--no-cache] [--no-flows] [--no-report]
```

Target sources (combinable):

- positional URL or `--url` — direct.
- `--surface <id>` — uses the surface's `base_url`, auto-selects every persona on that surface, threads `storageState` if `requires_auth: true`.
- `--pr <num>` — resolves the preview URL via `.gauntlet/config.json` `pr_url_template` (substitutes `{number}`, `{pr}`, `{branch}`, `{ref}`; slugs the branch for URL safety) or, failing that, scans PR comments for Vercel / Netlify / Render / Cloudflare Pages / Fly preview-URL patterns.

Filters (all compose with `AND`; `--tags` is `OR` within group):

```bash
# Marketing site, one persona, one specific flow.
gauntlet run --surface marketing --personas mary --flows mary--save-recipe

# Tenant admin, only smoke-tagged flows.
gauntlet run --surface tenant-admin --tags smoke

# PR preview, only the checkout feature.
gauntlet run --pr 123 --features checkout

# Critical, but skip slow accessibility-deep flows.
gauntlet run --surface marketing --tags critical --exclude-tags slow
```

### `gauntlet auth`

```
gauntlet auth <surface-id> [--url <login-url>]
```

Opens headed Chromium at the surface's `login_url` (or `--url`), waits for you to log in, dumps Playwright `storageState` to `.gauntlet/auth/<id>.json`, writes the path back into the surface yaml. The directory is created `mode 0700`, files `mode 0600` — cookies + localStorage are not world-readable on shared hosts.

### `gauntlet cross-report`

```
gauntlet cross-report [--surfaces <ids>] [--runs <dirs>] [--vet] [--vet-top N]
```

Picks the latest run per curated surface (or explicit `--runs` paths), aggregates findings, and writes `.gauntlet/CROSS-REPORT.md`. Signatures that appear on ≥2 surfaces are highlighted as cross-surface patterns — usually a design-system token to fix once, not three separate bugs.

`--vet` runs one extra Playwright pass per surface, replays the top axe rules, and tags each cross-surface pattern verified iff its rule re-fires on a majority of surfaces.

### `gauntlet bench`

```
gauntlet bench [--sites <path>] [--limit N] [--only <names>]
               [--personas N] [--flows N]
```

Runs gauntlet against a fixed list of public sites — default 12 (`linear, vercel, supabase, fly, render, stripe, anthropic, openai, playwright, deno, bun, neon`) — and writes an aggregate `bench-<date>.md` table. Add new sites via PR to [`bench/sites.json`](bench/sites.json).

### `gauntlet comment`

```
gauntlet comment [<run-dir>] --pr <num>
                 [--max N] [--artifact-base <url>]
                 [--run-url <url>] [--repo owner/name] [--dry-run]
```

Reads a built `report.json` and posts a compact PR comment via `gh pr comment`. Top findings ordered critical → minor, persona-abandon callouts highlighted, per-persona flow outcome rollup. `--dry-run` prints the body without posting.

---

## Run on every PR

Drop [`examples/gauntlet.yml`](examples/gauntlet.yml) into `.github/workflows/`, set the repo secret `ANTHROPIC_API_KEY`, point the preview-URL step at your platform. On every PR you get an inline comment:

```
### 🎯 Gauntlet on marketing: 5 findings

Personas run:
- Mary (impatient creator) — signup=abandoned, pricing=patience_exceeded
- Marcus (skeptical developer) — features=abandoned

Top 5 findings:
| Severity | What | Where | Who saw it |
|---|---|---|---|
| 🟥 CRITICAL | button-name: ... | /admin · [screenshot](...) | Marcus |
| 🟧 SERIOUS | color-contrast: ... | /pricing · [screenshot](...) | Mary |
| ...

Persona quit at:
- Mary: "couldn't find pricing in nav"
- Marcus: "expected to see a 'self-host' link in features"

driven by gauntlet
```

That comment lives in the same thread engineers already read CI / lint / preview-deploy comments in. Adoption flywheel.

---

## Signal-to-noise

Accessibility scanners drown in false positives. Gauntlet treats noise filtering as a first-class problem:

- **External-host console errors** (e.g. `fonts.googleapis.com`) auto-downgraded to `minor`. Real third-party CSP misconfig is still surfaced, just not at `serious`.
- **Third-party iframe content** (YouTube, Vimeo, Stripe Elements, Cloudflare Turnstile, reCAPTCHA, hCaptcha, Calendly, Intercom, Typeform) auto-detected by frame-piercing target chain + known class prefix. Severity downgraded, title suffixed with `[youtube embed]` / `[stripe-elements embed]` / etc.
- **Cookie-consent CMPs** injected directly into the host DOM (OneTrust, Cookiebot, Osano, TrustArc, Termly, Klaro, CookieYes) detected by class/id prefix and tagged the same way.
- **Console errors classified** into eight buckets: `csp_violation` (with the directive name extracted), `extension_blocked`, `preload_unused`, `mixed_content`, `cookie_policy`, `network_error`, `uncaught_exception`, `unknown`. Report titles read "CSP font-src: Refused to load…" instead of "console_error: Refused to load…".
- **Persona judge demands observable evidence** for `give_up`. The persona's voice is for narration tone, not a license to abandon for aesthetic reasons.

Verified on the multi-tenant SaaS dogfood: same input, before/after these filters, signal-to-noise went from ~56% to ~95%.

---

## Reliability

The runner is built for unpredictable real-world pages. Borrowed from prior art (see [`docs/PRIOR-ART.md`](docs/PRIOR-ART.md) for full provenance) and proved in production dogfood:

- **Confidence-thresholded `observe → act`** (Stagehand pattern). The AI returns a 0–100 confidence; below 60 the picked element degrades to `no_match` rather than committing to a wrong locator.
- **Step memory.** Last 3 `(intent, action, outcome)` tuples fed into every `observe` and `act` so the AI doesn't loop on a target that already failed.
- **Per-step timeouts with AbortSignal cancellation.** Each `observe / act / judge` AI call has a 60s cap; on timeout the AbortController fires and the fetch is actually cancelled (not just abandoned). One automatic retry per op for transient 5xx.
- **Mutation-observer page settle.** Replaces `networkidle` (which never fires on SPAs that poll). Waits for N ms of zero DOM mutations, capped by a hard timeout.
- **Wallclock alarm.** A `setTimeout` fires `FLOW_WALLCLOCK_BUDGET_MS` after browser launch and force-closes the browser, no matter what the loop is doing. Catches Playwright primitives that ignore AbortSignal (e.g. `scrollIntoViewIfNeeded` retry loops).
- **Per-flow exception isolation.** A crash in one flow writes a synthetic `outcome=error` flow-result and continues. The pool slot frees, the other personas keep running.
- **Network-aware Playwright defaults.** `slow-3g` personas get selector/navigation timeouts up to 90s instead of the unscaled 30s.

---

## AI providers

| Provider | Model prefix | Env var |
|---|---|---|
| Anthropic | `claude-` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-`, `o1-`, `o3-` | `OPENAI_API_KEY` |
| Google | `gemini-` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| Ollama (local) | `ollama/`, `llama`, `qwen`, `mistral`, `deepseek` | `OLLAMA_HOST` (default `http://localhost:11434`) |

Default: `claude-opus-4-7`. Pick a different model by passing `--model <id>` — the prefix routes the provider automatically.

Responses are cached on disk at `.gauntlet/cache/ai/` (mode `0700` directory, `0600` files) keyed on `(provider, model, messages, schema, maxTokens, temperature)`. Because the prompt includes the live DOM outline, cache entries naturally invalidate when the page changes. Pass `--no-cache` to force fresh inference. The run summary prints a `cache: hits=N misses=N writes=N (P% hit-rate)` line so a fast re-run advertises whether it's real or replayed.

---

## Layout

```
src/
  cli.ts                       # Every subcommand lives here.
  ai/
    provider.ts                # Interface + caching decorator. ProposeOptions includes signal.
    cache.ts                   # sha256-keyed disk cache with hit/miss stats.
    anthropic.ts, openai.ts, google.ts, ollama.ts
  init/
    project-reader.ts          # Phase A. Multi-URL landings[]. Login-wall detection.
    probe-paths.ts             # /admin /login /pricing auto-probe on each origin.
    surface-generator.ts       # AI proposes surfaces from landings + README.
    persona-generator.ts       # AI proposes personas grouped by surface.
    flow-generator.ts          # AI proposes flows per persona (surface-aware).
    seed.ts                    # Non-interactive Phase A+B+C orchestration.
    curate.ts, curate-flows.ts # Interactive accept/reject/edit/regen loops.
  persona/
    schema.ts                  # Zod Persona / Character / Behavior / OCEAN.
    templates/*.yaml           # 8 universal behavior skeletons.
    library/mary.yaml          # Worked example.
  surface/
    schema.ts                  # Zod Surface (base_url, audience, features, auth_state).
    loader.ts                  # Read/write .gauntlet/surfaces/.
  flow/
    schema.ts                  # Zod Flow (with feature/tags/paths for run filters).
    filter.ts                  # --features / --tags / --paths / --exclude-tags.
  auth/
    capture.ts                 # Headed login → storageState dump (mode 0600).
  target/
    pr.ts                      # --pr resolution: gh API + comment scan + URL validation.
  runner/
    flow-runner.ts             # Phase D. observe→act→capture→judge per step.
    browser.ts                 # Legacy single-step capture (pre-flows).
    step-judge.ts              # AI verdict (strict: requires observable evidence).
    capture.ts                 # Forensic snapshot: screenshot/DOM/AX-tree/axe/console/network.
    axe-scan.ts                # axe-core + persona-rule mapping.
    third-party-axe.ts         # Detect YouTube/Stripe/CMP findings; downgrade severity.
    external-host.ts           # Detect external-host console errors.
    console-class.ts           # 8-bucket classifier (CSP/preload/mixed-content/etc).
    page-settle.ts             # Mutation-observer settle (replaces networkidle).
    network-profiles.ts        # fast-fiber, home-wifi, slow-3g, ...
    failure-reasons.ts         # FailureEvent enum.
  report/
    schema.ts                  # Zod Finding / PersonaReport / RunReport.
    generator.ts               # flow-result.json → Findings (dedup + severity rules).
    rollup.ts                  # Cross-persona patterns within a single run.
    cross-surface.ts           # Cross-surface rollup (gauntlet cross-report).
    vetter.ts                  # Replay verification (auth-aware, URL-grouped).
    render-markdown.ts         # REPORT.md.
    build.ts                   # Top-level orchestrator.
  bench/
    runner.ts                  # gauntlet bench: loop sites, run, aggregate.
  comment/
    render.ts                  # gauntlet comment: PR-comment body builder.

.gauntlet/
  surfaces/                    # Curated audience-scoped views (committed).
  personas/                    # Curated roster (committed).
  flows/                       # Curated flows per persona (committed).
  auth/                        # storageState per surface (gitignored, 0700/0600).
  cache/ai/                    # AI response cache (gitignored, 0700/0600).
  CROSS-REPORT.md              # Latest cross-surface rollup.
  cross-report.json
  runs/<ts>/                   # One directory per gauntlet run.
    REPORT.md
    report.json
    <persona>/<flow>/
      flow-result.json
      video/page.webm
      steps/0000/
        screenshot.png
        dom.html
        ax-tree.json
        axe.json
        console.jsonl
        network.jsonl
```

---

## Documentation

- [`docs/QUICKSTART.md`](docs/QUICKSTART.md) — guided five-minute walkthrough with one real example.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system map, data flow, and how the six phases hand off.
- [`docs/PRIOR-ART.md`](docs/PRIOR-ART.md) — survey of related projects (Stagehand, browser-use, Skyvern, WebVoyager, Anthropic Computer Use, etc.) and the patterns Gauntlet borrowed.
- [`CHANGELOG.md`](CHANGELOG.md) — every release. New features, fixes, and the dogfood findings that drove them.
- [`AGENTS.md`](AGENTS.md) — contribution conventions, including the beads issue tracker workflow.

---

## License

MIT. See [`LICENSE`](LICENSE).
