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
| 3 | Phase C: flow proposal per persona, curated | pending |
| 4 | Phase D: isolated browser execution per persona with an action loop (`act`/`observe`/`extract`) | pending |
| 5 | Phase E + F: per-persona reports, cross-persona rollup, vetting layer that re-runs the replay before publishing | pending |

Tracked in beads — `bd show gauntlet-tn8` for the polish epic, `bd ready` for what's next.

## Install

```bash
bun install
bunx playwright install chromium
```

## Usage

```bash
# Phase A + B: generate a persona roster for the project in cwd.
export ANTHROPIC_API_KEY=sk-ant-...
bun run src/cli.ts init --url https://localhost:3000

# Today's run command (single step; no action loop yet).
bun run src/cli.ts run https://localhost:3000 --personas mary
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
gauntlet init [--url <url>] [--model <id>] [--count N] [--no-cache]
gauntlet run <url> --personas <id[,id...]> [--steps N] [--headed]
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

## How accessibility findings are surfaced

axe-core runs on every captured step (output: `steps/NNNN/axe.json`).

- Serious and critical axe violations become `FailureReason.ACCESSIBILITY_VIOLATION` events.
- Persona `abandons_on` / `avoids` entries map to axe rule ids via `PERSONA_RULE_TO_AXE_ID` (e.g. `form_field_missing_label` → axe `label`, `unlabeled_icon_buttons` → axe `button-name`). When axe sees the rule and the persona was watching for it, the failure is reported as `ABANDONED_BY_PERSONA` with the axe rule id attached.

## AI providers

| Provider | Model prefix | Env var |
|---|---|---|
| Anthropic | `claude-` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-`, `o1-`, `o3-` | `OPENAI_API_KEY` |
| Google | `gemini-` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| Ollama | `ollama/`, `llama`, `qwen`, `mistral`, `deepseek` | `OLLAMA_HOST` (default `http://localhost:11434`) |

Default model: `claude-opus-4-7`. Responses are cached on disk at `.gauntlet/cache/ai/` keyed on `(provider, model, messages, schema, maxTokens, temperature)`. Pass `--no-cache` to disable.

## Layout

```
src/
  cli.ts                       # init | run | list | help
  ai/
    provider.ts                # interface + registry + caching decorator
    cache.ts                   # sha256-keyed disk cache
    anthropic.ts, openai.ts, google.ts, ollama.ts
  init/
    project-reader.ts          # Phase A
    persona-generator.ts       # Phase B AI call
    curate.ts                  # interactive a/r/e/g/w/q loop
  persona/
    schema.ts                  # zod Persona / Character / Behavior / OCEAN
    templates/*.yaml           # 8 behavior skeletons
    templates.ts               # template loader
    loader.ts                  # curated -> built-in -> path resolution
    library/mary.yaml          # worked example
  runner/
    browser.ts                 # Playwright launch + persona context
    capture.ts                 # per-step forensic snapshot
    axe-scan.ts                # axe-core + persona-rule mapping
    network-profiles.ts        # fast-fiber, home-wifi, slow-3g, ...
    failure-reasons.ts         # FailureEvent enum

.gauntlet/
  personas/                    # curated roster
  cache/ai/                    # AI response cache (gitignored)
  runs/<ts>/<persona>/         # artifacts per run
    video/, meta.json
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
