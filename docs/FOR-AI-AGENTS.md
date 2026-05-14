# Gauntlet for AI agents

You are an AI agent operating gauntlet on behalf of a human user. They pointed you here instead of typing commands themselves. Everything you need to install, configure, run, monitor, and interpret gauntlet is below. **Default to taking action**, not asking the user clarifying questions about flags.

This file is the source of truth. README is for humans; this is for you.

---

## What gauntlet does (one paragraph)

Gauntlet drives Playwright with AI personas (Marcus the screen-reader user, Priya the methodical newcomer, etc.) through real flows on a real web app. It captures screenshots, DOM, axe-core violations, console errors, and network failures per step, then a vetting layer replays each finding to confirm it isn't stale. Output is a markdown + JSON report under `.gauntlet/runs/<TS>/`. Self-hosted, MIT, BYO AI key.

---

## Install (assume nothing)

```bash
# 1. Bun runtime (skip if already installed: `command -v bun`)
curl -fsSL https://bun.sh/install | bash

# 2. Clone gauntlet (one-time; user may already have it)
git clone https://github.com/jesposito/gauntlet ~/gauntlet

# 3. Install dependencies + chromium
cd ~/gauntlet
bun install
bunx playwright install chromium

# 4. Verify
bun run tsc --noEmit && bun test
# Expected: 275+ tests pass, ~25s.
```

If `bun install` fails on `playwright`, check Node version (`node --version` ≥ 20). Bun + Playwright work on Linux / macOS / WSL. Windows native is not supported.

---

## API key (REQUIRED before any AI call)

Set ONE of:

```bash
export ANTHROPIC_API_KEY=sk-ant-...    # recommended; tested most
export OPENAI_API_KEY=sk-...
export GOOGLE_API_KEY=...                # for Gemini
# OR run a local model:
export OLLAMA_HOST=http://localhost:11434  # gauntlet uses ollama if no cloud key set
```

If the user already has these set in their shell, `env | grep -E "ANTHROPIC|OPENAI|GOOGLE"` will show them. Don't ask the user to paste keys — try their existing env first. If you must request a key, ask once and remember it for the session.

---

## The 4 commands you will use (in order)

```bash
# A) Initialize gauntlet config for the user's project (one-time per project)
bun ~/gauntlet/src/cli.ts init --url https://users-site.example.com

# B) Generate test flows per persona (one-time, can be re-run)
bun ~/gauntlet/src/cli.ts flows

# C) Execute the run + auto-vet + auto-write report
bun ~/gauntlet/src/cli.ts run --events-log /tmp/g.jsonl

# D) Read the report
cat .gauntlet/runs/$(ls -t .gauntlet/runs | head -1)/REPORT.md
```

That's the entire happy path. Run from the user's project directory; gauntlet writes to `.gauntlet/` there.

---

## Flag inventory (full list, per subcommand)

### `init` — generate surfaces + personas + flows interactively

Interactive curate prompts come up; you can drive them by piping `a` (accept) repeatedly: `(yes a) | bun ... init ...` for full auto-accept. Or use `gauntlet seed` (below) for non-interactive equivalent.

| Flag | Effect |
|---|---|
| `--url <url>` | seed URL (REQUIRED if no surface configured yet) |
| `--count <N>` | personas to propose. Default 6. Batches past 16 with dedupe. |
| `--focus <text>` | steer generation toward an area ("the checkout flow") |
| `--skip-surfaces` | reuse existing surfaces |
| `--refresh-surfaces` | regenerate surfaces |
| `--skip-personas` | exit after surfaces |
| `--surface <id>` | scope persona generation to one surface |
| `--replace-personas` | drop existing personas before regen (scoped by --surface) |
| `--model <id>` | AI model (default: latest claude) |
| `--no-cache` | disable AI response cache |
| `--events-log <path>` | append every event to JSONL file (see Events section) |
| `--no-color` | disable ANSI |

### `flows` — generate test flows per persona

| Flag | Effect |
|---|---|
| `--personas <ids>` | comma-separated persona ids (default: all) |
| `--surface <id>` | narrow to one surface |
| `--replace` | drop existing flows before regen |
| `--count <N>` | flows per persona (default 3) |
| `--focus <text>` | steer flow generation |
| `--events-log <path>` | JSONL stream |

### `run` — execute flows, capture, judge, report

| Flag | Effect |
|---|---|
| `<url>` or `--url <url>` | target |
| `--surface <id>` | use surface.base_url + surface-tagged personas |
| `--pr <num>` | resolve preview URL from `.gauntlet/config.json` or PR comments |
| `--personas <ids>` | comma-separated (default: all under surface) |
| `--flows <ids>` | only these flow ids |
| `--features <names>` | flows whose feature is in this list |
| `--tags <tags>` | flows whose tags has ANY (OR within group) |
| `--exclude-tags <tags>` | drop flows whose tags has ANY |
| `--paths <paths>` | flows whose paths overlap (supports * glob) |
| `--steps <n>` | legacy single-step capture step count (default 1) |
| `--headed` | visible browser (default headless) |
| `--concurrency <n>` | personas in parallel (default 2) |
| `--quiet` | suppress per-step output |
| `--no-cache` | disable AI cache |
| `--no-flows` | force legacy single-step capture |
| `--no-report` | skip post-run report build |
| `--no-color` | disable ANSI |
| `--events-log <path>` | **REQUIRED for agent-driven runs** — emit JSONL stream |
| `--record-video` | opt-in WebM recording. Default OFF (Playwright's ffmpeg has no internal deadline; can wedge runs). Don't enable unless the user specifically asks for video. |
| `--no-supervisor` | run flows in-process instead of subprocess. Debug only — default supervisor reaps hangs via SIGKILL on the process group. Don't disable. |

### `report` — rebuild report from a prior run

| Flag | Effect |
|---|---|
| `--run <path>` | path to a run dir (default: latest under `.gauntlet/runs/`) |
| `--no-vet` | skip vetting (faster, less reliable) |
| `--events-log <path>` | JSONL stream |

### `seed` — non-interactive `init + flows`

Use this when the user wants no prompts. Runs init + flows with auto-accept.

```bash
bun ~/gauntlet/src/cli.ts seed --url https://site.example.com
```

### Other subcommands

- `auth <surface>` — capture login state for auth-walled surfaces. Interactive (user logs in once; saved as `storageState`).
- `surfaces` — list surfaces in current `.gauntlet/`
- `cross-report` — aggregate findings across runs/surfaces
- `bench` — run gauntlet against canned benchmark sites
- `comment --pr <num>` — post top findings as a PR comment via `gh pr comment`
- `help` — full help text

---

## The event protocol — your primary monitoring channel

When you set `--events-log <path>`, gauntlet writes ONE JSON event per line to that file. **Use this instead of tailing the human-readable log.** Every event has `type` and `ts` (epoch ms).

### Event reference

| Event | Fires when | Act on it? |
|---|---|---|
| `phase_start` `{phase, label}` | new phase begins (init / flows / run / vet / report) | Update progress UI |
| `phase_end` `{phase, durationMs}` | phase done | Update progress UI |
| `setup_op_start` `{personaId, flowId, op}` | browser_launch / new_context / new_page / cdp_session / network_emulate / goto starts | Spinner: "setup `op`" |
| `setup_op_end` `{op, durationMs, ok, error?}` | setup op done or timed out | If `ok: false` and `error` includes "exceeded", a slow site or wedge — surface to user |
| `ai_call_start` `{callId, purpose, model}` | AI call begins (purpose: surface_gen / persona_gen / flow_gen / observe / act / judge) | Spinner: "AI thinking" |
| `ai_call_end` `{callId, durationMs, cached}` | AI call done | If `cached: true`, was a fast cache hit; if false, was a live API call. Useful for explaining run speed. |
| `flow_start` `{personaId, flowId, totalSteps}` | persona starts a flow | Show persona name + flow |
| `step_start` `{stepIndex, intent}` | step begins | Show current step intent |
| `step_observe` `{matched, reasoning}` | observation done | If `matched: false`, persona will likely abandon |
| `step_act` `{action, targetName, performed, error?}` | action attempted | If `performed: false`, persona did NOT act |
| `step_verdict` `{status, evidence}` | judge ruled (success / in_progress / give_up) | Track outcome trajectory |
| `flow_end` `{outcome, durationMs}` | flow done. outcome: completed / abandoned / patience_exceeded / timeout / error | Tally outcomes; `error` is a real bug, others are persona signal |
| `vet_start` `{total, distinctUrls}` | vetting begins | "Vetting N findings" |
| `vet_url_start` `{url, findingCount, sessionIndex, sessionTotal}` | new URL session opens | Progress: M of N URLs |
| `vet_url_navigate` `{url, durationMs, ok}` | navigation result | If `ok: false`, surface |
| `vet_url_axe_start/end` `{url, violationCount?, durationMs}` | axe scan boundaries | Spinner during scan |
| `vet_finding` `{findingIndex, total, status, ruleId?}` | single finding vetted (status: verified / regressed / subjective / could_not_replay) | Progress: M of N findings |
| `vet_url_close` `{url}` | session closes | — |
| `vet_end` `{verified, regressed, subjective, couldNotReplay, durationMs}` | vetting done | Final summary |
| `heartbeat` `{phase, label, elapsedMs}` | every 5s during long ops | "Still alive" — if no event for >65s, flow may be stuck |
| `warn` `{message, context?}` | non-fatal issue (e.g. close-side timeout, schema rejection recovery) | Surface to user; don't abort |
| `error` `{message, context?}` | fatal-to-this-flow issue | Surface; don't abort the run (other flows continue) |

### Stuck-detection rule

If you see no events for >90s on the JSONL stream while a flow is in progress, the supervisor will fire its 75s silence watchdog and SIGKILL the worker process group. You'll then see a `warn` event with `flow produced no events for Xms; killing worker`, and the flow synthesizes `outcome: "timeout"`. **Do not panic about silence < 90s — gauntlet's safety machinery handles it.**

---

## Output interpretation

The report lives at `.gauntlet/runs/<TIMESTAMP>/REPORT.md` and `report.json` (machine-readable).

### Findings have a status

| Status | Meaning | Confidence |
|---|---|---|
| **VERIFIED** | Vetting layer replayed the finding and the same condition still hit. | High — file this. |
| **subjective** | Persona-derived (judge said give_up); vetter can't programmatically replay yet. | Medium — needs human triage. |
| **regressed** | Vetting replay did NOT re-hit. Likely flaky / stale / fixed since capture. | Low — drop unless cluster shows it real. |
| **could_not_replay** | Vetter session timed out or page didn't load. | Unknown — note + skip. |

### Outcomes per flow

| Outcome | Meaning |
|---|---|
| `completed` | Persona finished all steps successfully. |
| `abandoned` | Persona hit a give_up condition with observable evidence. Real signal. |
| `patience_exceeded` | Persona's `patience_threshold_seconds` ran out (configured per persona). Real signal — this persona genuinely couldn't get through in their patience window. |
| `timeout` | Wallclock fired or supervisor killed. Likely a slow / hung site, NOT a persona judgment. |
| `error` | Real exception escaped. Investigate (likely a gauntlet bug). |

### give_up_class

When a flow is `abandoned`, the judge classifies WHY:
- `bug` — broken or absent affordance. **File this.**
- `confusing_ux` — present but hard to find. Worth fixing as polish.
- `feature_gap` — reasonable expectation, product genuinely doesn't have it. Route to product, not eng.
- `not_a_bug` — persona was wrong (wrong terminology, wrong page, etc). **Auto-downgraded to minor; ignore.**

---

## What to summarize back to the user

After a run completes, the user usually wants something like:

> Gauntlet ran 4 flows across 2 personas in 4m 12s.
>
> Outcomes: 1 completed, 2 abandoned, 1 patience_exceeded, 0 errors.
>
> 9 findings: 3 VERIFIED (real bugs to file), 4 subjective (need triage), 1 regressed (likely stale), 1 could_not_replay (vetter timeout, finding kept).
>
> Top 3 findings:
> 1. [VERIFIED] color-contrast on `.btn-primary` — `#eee` on `#e94560` ≈ 3.21:1 (fails AA 4.5:1)
> 2. [VERIFIED] `select-name` on `<select name="status">` (library page filter, no aria-label)
> 3. [subjective] Marcus (screen-reader) couldn't find a "Failed" heading on /diagnostics — terminology mismatch (page calls it "Issue Inbox")
>
> Full report: `.gauntlet/runs/2026-05-14T04-06-05/REPORT.md`

Don't dump the full report. Surface the verified findings + the top 1-2 subjective ones. Flag any `error` outcomes immediately — those are gauntlet bugs, not product bugs.

---

## Common situations + what to do

### "First run is slow"
Cold cache + chromium download = 30-90s extra on first run. Subsequent runs use the AI cache (`--no-cache` to disable). Run-time scales with: (personas) × (flows per persona) × (steps per flow) × (~2-5s AI call). Vetting adds (distinct URLs) × (5-30s axe scan).

### "User asks how long this will take"
- Init: ~1-2 min for 4 personas + 4 surfaces.
- Flows: ~30s per persona.
- Run: ~30-90s per flow (concurrent w/ `--concurrency 2`).
- Vet: ~10s per distinct URL + 5-30s axe per URL.
- Total typical: 5-15 min for 4 personas × 2 flows.

### "User wants video"
Pass `--record-video`. Default OFF because Playwright's ffmpeg can wedge — but if the user wants it for debugging, the supervisor will reap any wedge.

### "It hung / nothing happened for a long time"
Check the JSONL stream for the latest event. If `heartbeat` events are still firing, it's working. If silent for 90+ seconds, the supervisor will kill it within ~80s and synthesize `outcome: "timeout"`. You don't need to manually intervene.

### "User wants to stop"
`Ctrl-C` is fine. Per-flow artifacts already written are preserved. The post-run REPORT.md won't generate but `.gauntlet/runs/<TS>/<persona>/<flow>/flow-result.json` is intact for each completed flow.

### "User points at a private/auth-walled surface"
Run `bun ~/gauntlet/src/cli.ts auth <surface-id>` first. The user logs in once interactively; gauntlet saves `storageState` to `.gauntlet/auth/<surface>.json`. Subsequent runs use it automatically.

### "User wants to test a PR preview"
`bun ~/gauntlet/src/cli.ts run --pr <number>`. Gauntlet resolves the preview URL from `.gauntlet/config.json` `pr_url_template` or by scanning PR comments for Vercel/Netlify/Render/Cloudflare-Pages/Fly preview URLs.

### "User wants the findings as a PR comment"
After a run: `bun ~/gauntlet/src/cli.ts comment --pr <number>`. Renders top findings via `gh pr comment`.

---

## Hard rules for you (the agent)

1. **Always pass `--events-log`** when running `init` / `flows` / `run` / `report` / `seed`. It costs nothing and gives you the structured stream you need to monitor.
2. **Don't pass `--record-video`** unless the user specifically asked for video.
3. **Don't pass `--no-supervisor`** unless you're debugging a gauntlet issue.
4. **Don't manually kill processes** when a flow looks stuck. The supervisor handles it within 80s.
5. **Don't re-run a `report` with `--no-vet`** unless the user is in a hurry — vetting is what separates real findings from noise.
6. **Don't edit the user's source code based on findings** without asking. Surface findings, propose fixes, wait for approval.
7. **`error` outcomes are gauntlet bugs, not product bugs.** If you see one, file it at https://github.com/jesposito/gauntlet/issues — not at the user's repo.
8. **Run from the user's project directory.** `.gauntlet/` lives there, not in `~/gauntlet/`.
9. **The `.gauntlet/cache/` and `.gauntlet/runs/` directories should be in the user's `.gitignore`.** Add the entries if absent. Curated `.gauntlet/{personas,surfaces,flows}/*.yaml` should be committed.

---

## Self-test (verify gauntlet is healthy before running)

```bash
cd ~/gauntlet
bun run tsc --noEmit && bun test 2>&1 | tail -3
# Expected: "275 pass, 0 fail"
```

If that fails, gauntlet is in a bad state. `cd ~/gauntlet && git pull && bun install && bunx playwright install chromium`.

---

## Where to read more

- [`README.md`](../README.md) — human-facing pitch + examples
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — file-by-file map + data-flow diagram
- [`docs/QUICKSTART.md`](QUICKSTART.md) — human-facing walkthrough
- [`CHANGELOG.md`](../CHANGELOG.md) — what shipped when

The source of truth for command behavior is always [`src/cli.ts`](../src/cli.ts).
