# Gauntlet

> **Synthetic users meet axe-core. Free.**
> Run a curated gauntlet of AI personas against your web app and get repro-ready UX + a11y bug reports with screenshots, accessibility trees, and a deterministic Playwright replay for every finding.

Gauntlet is a free, self-hosted CLI. It does not output more tests. It outputs **bugs your devs can fix today** — each one backed by artifacts and a replay script that the built-in vetting layer re-runs before the report leaves the box. If the replay can't re-hit it, the finding is dropped or flagged subjective.

**No SaaS. No telemetry. BYO AI key.** Anthropic Claude, OpenAI, Google Gemini, or local Ollama — one `--model` flag picks the provider.

## Why Gauntlet exists

The agentic browser-tool space is full and growing. Most of it is pointed sideways from what product teams actually need:

| Tool | What it makes | What's missing |
|---|---|---|
| [browser-use](https://github.com/browser-use/browser-use) | Agents that *complete tasks* on the web | No persona model, no bug reports, no a11y signal |
| [Stagehand](https://github.com/browserbase/stagehand) | An SDK for *building browser agents* | You bring the personas, the test plan, and the QA judgment |
| [Synthetic Users](https://www.syntheticusers.com/) / Uxia / Delve | AI *interviews and surveys* with synthetic personas | Text-only. Personas never touch the actual product |
| [QA Wolf](https://www.qawolf.com) / Momentic | AI-generated end-to-end *Playwright tests* | Generates more tests to maintain — not bug reports |
| [axe-core](https://github.com/dequelabs/axe-core) + Playwright | The WCAG ground truth (~57% of issues automatable) | No user-behavior context — every violation looks the same |

Gauntlet sits in the gap: **persona-driven, action-based bug mining with WCAG ground truth and a vetting layer that re-runs the replay**.

## What Gauntlet does that nothing else does

- **Curated personas, project-generated**. `gauntlet init` reads your README, package.json, and (optional) landing page and asks the AI to propose 8–12 personas tailored to *your* product — a mix of **core** users (realistic target users) and **edge** users (low-frequency users who break interesting assumptions: keyboard-only, screen-reader, slow-3G mobile, low-reading-level, power-user-fuzzer, skeptical-first-timer). You curate one at a time: accept / reject / edit in `$EDITOR` / regenerate / write-your-own.
- **Personas reference WCAG**. When a persona says `abandons_on: form_field_missing_label`, that maps to axe rule `label`. The next time axe sees it on the page, you get an `ABANDONED_BY_PERSONA` event in the report — not a generic a11y violation in a sea of them.
- **Every step is a forensic snapshot**. Screenshot + DOM + AX-tree + console + network + axe scan, per step, on disk. Vetting reruns Playwright against those artifacts before publishing the bug.
- **Free and self-hosted**. MIT, your machine, your AI key, your CI.

## Status

- **Stage 1**: scaffold, persona schema, Playwright runner, per-step capture (screenshot + DOM + AX-tree + console + network). Shipped.
- **Stage 2**: `gauntlet init` — Phase A project reader + Phase B AI persona curation against 8 behavior templates. Shipped.
- **Stage 2.5** (current): axe-core baseline at every step + persona-rule mapping. Shipped.
- Stage 3: Phase C — flow proposal per persona, curated.
- Stage 4: Phase D — isolated browser execution per persona with an `act` / `observe` / `extract` action loop (primitives borrowed from Stagehand).
- Stage 5: Phase E + F — per-persona reports, cross-persona rollup, **vetting layer**.

Tracked in beads: `bd show gauntlet-tn8` for the polish epic, `bd ready` for what's next.

## Quick start

```bash
bun install
bunx playwright install chromium

# Phase A + B: build your project's persona roster
export ANTHROPIC_API_KEY=sk-ant-...
bun run src/cli.ts init --url https://localhost:3000

# Phase D (smoke; today: one step, no action loop yet)
bun run src/cli.ts run https://localhost:3000 --personas mary,marcus-indie-dev
```

`gauntlet init` walks you through curation interactively:

```
--- candidate 1/6 [core] marcus-indie-dev ---
Marcus Liang, 31
context: Solo founder shipping a SaaS side-project who just heard about
  Gauntlet on Hacker News. He wants to know in 30 seconds if this will
  catch the bugs his manual QA misses.
voice: Direct and a little snarky. "Cool, but show me a real bug
  report. Don't make me read your manifesto."
device=laptop network=fast-fiber input=mouse viewport=1440x900
goals:
  - Find a sample bug report or demo output within 30 seconds
  - Confirm Gauntlet supports his AI provider and is actually self-hosted
  - Locate install instructions and copy the quick-start command
template: skeptical-first-timer
rationale: Gauntlet's primary user is a skeptical indie dev who needs to
  see proof the CLI actually finds real bugs before installing anything.

[a/r/e/g/w/q]?
```

Accepted personas land in `.gauntlet/personas/<id>.yaml`. Re-runnable: subsequent `init` augments rather than replaces.

## Built-in behavior templates

The 8 templates `gauntlet init` instantiates against your product (mix of core + edge):

| Template | Label | Stress-tests |
|---|---|---|
| `low-digital-confidence` | core | icon-only controls, modals, account walls |
| `low-reading-level` | core | dense paragraphs, jargon, indirect button verbs |
| `skeptical-first-timer` | core | unclear value prop, hidden pricing, cookie-blocked hero |
| `high-impatience-mobile` | core | flow stalls, newsletter popups, multi-step onboarding |
| `keyboard-only` | edge | mouse-only controls, focus traps, missing focus rings |
| `screen-reader-via-ax-tree` | edge | unlabeled icons, missing form labels, broken heading outline |
| `slow-3g-mobile` | edge | heavy bundles, layout shift, no loading state |
| `power-user-fuzzer` | edge | double-submit, paste-garbage, back-button corruption |

## Architecture

```
gauntlet/
├─ src/
│  ├─ cli.ts                       # init | run | list | help
│  ├─ ai/                          # provider abstraction
│  │  ├─ provider.ts               # interface + registry
│  │  ├─ anthropic.ts              # claude-* (default)
│  │  ├─ openai.ts                 # gpt-*, o1-*, o3-*
│  │  ├─ google.ts                 # gemini-*
│  │  └─ ollama.ts                 # local models
│  ├─ init/
│  │  ├─ project-reader.ts         # Phase A: README + package + landing
│  │  ├─ persona-generator.ts      # Phase B: AI proposes candidates
│  │  └─ curate.ts                 # interactive a/r/e/g/w/q loop
│  ├─ persona/
│  │  ├─ schema.ts                 # zod Persona schema
│  │  ├─ templates/*.yaml          # 8 behavior skeletons
│  │  ├─ templates.ts              # template loader
│  │  ├─ loader.ts                 # curated -> built-in -> path
│  │  └─ library/mary.yaml         # worked example only
│  └─ runner/
│     ├─ browser.ts                # Playwright launch + persona context
│     ├─ capture.ts                # per-step forensic snapshot
│     ├─ axe-scan.ts               # axe + persona-rule mapping
│     ├─ network-profiles.ts       # fast-fiber, home-wifi, slow-3g, ...
│     └─ failure-reasons.ts        # FailureEvent enum
└─ .gauntlet/
   ├─ personas/                    # your curated roster
   └─ runs/<ts>/<persona>/         # artifacts per run
      ├─ video/
      ├─ meta.json
      └─ steps/0000/
         ├─ screenshot.png
         ├─ dom.html
         ├─ ax-tree.json
         ├─ axe.json                # WCAG findings via axe-core
         ├─ console.jsonl
         └─ network.jsonl
```

## Roadmap (next stars)

- **Stagehand-style `act / observe / extract` action primitives** in the Phase D action loop — durable selectors via AI at runtime instead of brittle CSS.
- **AI decision cache** keyed on `(provider, model, messages, schema)` and `(url_hash, dom_outline_hash, instruction)` — cheap reruns.
- **WebVoyager-style benchmark leaderboard** — public weekly run against the top 100 SaaS landing pages.
- **OCEAN personality** field on persona characters (optional) — Big-5 axes that shape voice and abandonment behavior.

## Provider support

| Provider | Model prefix | Env var |
|---|---|---|
| Anthropic Claude | `claude-` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-`, `o1-`, `o3-` | `OPENAI_API_KEY` |
| Google Gemini | `gemini-` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| Ollama (local) | `ollama/`, `llama`, `qwen`, `mistral`, `deepseek` | `OLLAMA_HOST` (default `http://localhost:11434`) |

Default: `claude-opus-4-7`.

## License

MIT
