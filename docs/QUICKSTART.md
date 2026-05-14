# Quickstart

Five minutes from clone to first report. Worked example: a marketing site you don't own (`https://linear.app`). Substitute your own URL once the shape is familiar.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0.
- An AI provider key in your environment. Anthropic's Claude is the default; OpenAI / Gemini / Ollama also work. See the [AI providers matrix](../README.md#ai-providers).
- Network egress to the target site + your AI provider.

```bash
git clone https://github.com/jesposito/gauntlet
cd gauntlet
bun install
bunx playwright install chromium

export ANTHROPIC_API_KEY=sk-ant-...
```

## Step 1 — Discover surfaces + curate personas

`gauntlet init` does three things in one pass:

1. Reads your project (`README.md`, `package.json`, optional `--url`s).
2. Fetches each `--url` plus auto-probes `/admin /login /pricing /dashboard /signin /app /_/login` on every origin.
3. Asks the AI to propose audience-scoped "surfaces" and ~10 candidate personas. You accept/reject/edit each interactively.

```bash
bun run src/cli.ts init --url https://linear.app
```

Sample output:

```
[Phase A] reading project context...
  project=(unknown) frameworks=[] readme=no landings=3+0 bytes=12384
    [200] https://linear.app
    [200] https://linear.app/pricing
    [301] https://linear.app/login

[Phase A2] AI proposing surfaces from landings + README...
  4 surfaces proposed:
    - marketing (Marketing / Acquisition) base=https://linear.app
    - product-app (Workspace app) [requires_auth] base=https://linear.app/app
    - pricing (Pricing & tiers) base=https://linear.app/pricing
    - login (Sign-in) base=https://linear.app/login
    wrote .gauntlet/surfaces/marketing.yaml
    ...

[Phase B] asking AI for candidate personas...
  got 11 unique candidates.

--- candidate 1/11 [core] indie-dev-considering-linear ---
Sasha Chen, 31
context: Indie founder evaluating issue trackers before paying for one. Just
  shipped v1 of a SaaS, needs to upgrade from a Notion DB without losing speed.
voice: Direct, a little exasperated by sales pages.
device=laptop network=fast-fiber input=mouse viewport=1440x900
goals:
  - Find pricing for the smallest paid plan within 30 seconds
  - See whether keyboard shortcuts actually work, not just live in a video
  - Confirm GitHub/PR integration is real and not a roadmap promise
template: skeptical-first-timer
rationale: Catches whether the marketing pitch survives a pricing-first scan.

[a/r/e/g/w/q]?  a
```

Actions:

- `a` accept
- `r` reject
- `e` edit in `$EDITOR` (yaml form)
- `g` regenerate this slot
- `w` write your own from scratch
- `q` quit

Aim for 3–6 accepted personas your first run. You can always run `gauntlet init` again later to add more.

## Step 2 — Generate flows

Each persona needs flows: short scripted journeys they'll attempt. `gauntlet flows` proposes 2–4 per persona, surface-aware, with the same curate loop.

```bash
bun run src/cli.ts flows
```

Sample output:

```
[Phase C] indie-dev-considering-linear [surface=marketing]
  AI proposed 3 flows

--- flow 1/3 indie-dev-considering-linear--scan-pricing-and-bail-or-buy ---
title: Scan pricing and bail or buy
goal: "I want to know in 30s if Linear costs more than I can justify for a 2-
  person team. If I can't tell, I'm out."
starting_url_hint: /pricing
steps (4):
  1. Find a price for the smallest paid plan.
  2. Confirm what 'seat' means — per editor or per anyone?
  3. Check for an annual discount + cancel policy.
  4. Decide: continue to checkout or leave.
tags: [smoke, critical]
feature: pricing
paths: [/pricing/*]
rationale: This flow exercises pricing clarity end-to-end with a hostile reader.

[a/r/e/g/q]?  a
```

## Step 3 — Run gauntlet

```bash
bun run src/cli.ts run --surface marketing --events-log run.jsonl
```

`--events-log` is optional but useful: every event (phase boundary, AI
call, vetter heartbeat, setup op) is appended to `run.jsonl` as one
JSON line so you can `tail -f run.jsonl` from a second shell or feed
it to an agent / CI consumer.

Sample output:

```
gauntlet run -> https://linear.app
surface: marketing
personas: indie-dev-considering-linear, mobile-commute-prospect
run dir: .gauntlet/runs/2026-05-13T14-32-08-991Z
concurrency: 2

[Phase run]
[indie-dev-considering-linear] Sasha Chen -> https://linear.app (3 flows)
  setup browser_launch  done  0.4s
  setup new_context     done  0.1s
  setup goto            done  1.2s
[mobile-commute-prospect] Marcus Webb -> https://linear.app (2 flows)
[+  3.8s indie-dev/...scan-pricing-and-bail-or-buy] step 1: Find a price for the smallest paid plan.
[+  5.6s indie-dev/...scan-pricing-and-bail-or-buy]   observe   AI live 1.8s -> MATCH: "$10/user" heading visible in pricing grid
[+  7.4s indie-dev/...scan-pricing-and-bail-or-buy]   act       AI cache 0.1s -> OK scroll_to "$10/user"
[+ 11.2s indie-dev/...scan-pricing-and-bail-or-buy]   verdict=success
...

summary: personas=2 flows=5 failures=14 [completed=2 abandoned=3]
cache: hits=0 misses=42 writes=42 (0% hit-rate)

artifacts: .gauntlet/runs/2026-05-13T14-32-08-991Z

[Phase vet] vetting findings...
  axe scan https://linear.app/pricing  done 3.2s (2 violations)
  ...
[Phase report]
report: .gauntlet/runs/2026-05-13T14-32-08-991Z/REPORT.md  (findings=14 verified=8 ...)
```

Each flow runs as a detached subprocess by default; if it goes silent
for 75s the parent kills the entire process group (worker + chromium +
any rogue ffmpeg) and synthesizes `outcome=timeout`. Pass
`--no-supervisor` to fall back to in-process execution for debugging.
Add `--record-video` if you want the WebM video artifact (off by
default).

`REPORT.md` is a vetted, severity-sorted markdown summary. Open it.

## Step 4 (optional) — Capture auth and run the admin

If `gauntlet init` flagged a surface with `requires_auth: true` (a creator admin, a customer dashboard, an internal ops panel), capture the login state:

```bash
bun run src/cli.ts auth tenant-admin
```

A headed Chromium window opens at the surface's `login_url`. Log in normally. Return to your terminal and press `Enter`. The Playwright `storageState` (cookies + localStorage) is saved to `.gauntlet/auth/tenant-admin.json` (mode `0600`) and the path is written into the surface yaml.

Then:

```bash
bun run src/cli.ts run --surface tenant-admin
```

Every persona on `tenant-admin` now starts logged-in.

## Step 5 (optional) — Cross-surface rollup

After you've run multiple surfaces:

```bash
bun run src/cli.ts cross-report
```

Output:

```
gauntlet cross-report
  surfaces:  4
  unique:    21
  patterns:  3 (signatures present on >=2 surfaces)

top cross-surface patterns:
  axe:color-contrast      3 surfaces, 7 findings (marketing, portfolio, admin)
  console_error @ ...     2 surfaces, 4 findings (portfolio, admin)
```

`color-contrast across 3 surfaces` is almost always one design-system token to fix once, not three separate bugs. That's the rollup's whole point.

## What next?

- Drop [`examples/gauntlet.yml`](../examples/gauntlet.yml) into your `.github/workflows/` to run gauntlet on every PR.
- See the full command reference in [`README.md`](../README.md#commands).
- See [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for how the six phases compose and where to extend.
- See [`docs/PRIOR-ART.md`](PRIOR-ART.md) for the reliability patterns Gauntlet borrowed from the field.
