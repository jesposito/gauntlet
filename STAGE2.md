# Stage 2 pickup

Stage 1 (commit `ccfe9df`) shipped the scaffold: persona schema, Mary as worked example, Playwright runner with full per-step capture, CLI, smoke test against example.com.

## Big reframe (post-Stage-1, from Jed)

The full product flow is a **gated, collaborative pipeline**, not "one command let-it-rip":

- **Phase A** — tool reads codebase + README + landing page → ProductModel
- **Phase B** — AI proposes core personas + edge personas → dev curates (accept/reject/edit/regen)
- **Phase C** — AI proposes flows per persona ("what would THIS persona try here?") → dev curates again
- **Phase D** — execution: gated, isolated browser per persona, careful action loop
- **Phase E** — individual reports per persona × flow
- **Phase F** — cross-persona rollup + **vetting layer** that re-checks every finding against artifacts before it ships

The vetting layer is the credibility line: findings without artifacts, or whose replay script doesn't re-hit the bug, get dropped or flagged subjective. This is what prevents the product from collapsing into "AI complains, devs ignore."

**Mary** is now documentation only — a worked example of what `low-digital-confidence-on-tablet` looks like when instantiated against a recipe site. Each project generates its own roster.

## Stage 2 covers Phases A + B only

(Phases C, D, E, F land in later stages — see plan file.)

## Stage 2 scope (Phases A + B)

1. **`gauntlet init` command** (`src/cli.ts` + `src/init/`)
   - **Phase A:** Read project context — `README.md`, `package.json` description/keywords/deps, top-level routes if framework detected, optional `--url <url>` to fetch landing page (`<title>`, meta description, h1/h2, primary nav text). Bounded to ~30KB total into the AI context. Output: `ProjectContext` object.
   - **Phase B:** AI proposes a mix of **core personas** (realistic target users for this product) and **edge personas** (low-frequency users who break interesting assumptions — e.g., 200-char input, RTL language, prefers-reduced-motion, back-button-spammer, Word-formatted paste). Aim for 8-12 candidates total with edge personas explicitly labeled.
   - Interactive CLI curation: `accept` / `reject` / `edit` (open YAML in `$EDITOR`) / `regenerate this slot` / `write-my-own`.
   - Accepted personas written to `.gauntlet/personas/<id>.yaml`.
   - Re-runnable: subsequent `init` augments rather than replaces.

2. **Stress-test template library** (`src/persona/templates/*.yaml`)
   - 6-8 universal behavior skeletons (no character details, just behavior + constraints):
     - `keyboard-only`
     - `screen-reader-via-ax-tree`
     - `slow-3g-mobile`
     - `low-digital-confidence`
     - `low-reading-level`
     - `power-user-fuzzer`
     - `skeptical-first-timer`
     - `high-impatience-mobile`
   - The AI instantiates these against the project to fill in `character`

3. **AI provider abstraction** (`src/ai/provider.ts`)
   - One interface: `propose(messages, schema) -> structured output`
   - Adapters: `anthropic.ts` (Claude, default), `openai.ts`, `google.ts`, `ollama.ts`
   - BYO key via env: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.
   - Single `--model claude-opus-4-7` flag picks provider + model
   - Used by both `init` (persona generation) and (later) the action loop

4. **Project reader** (`src/init/project-reader.ts`)
   - Walks repo: reads `README.md`, top-level `package.json` description + keywords
   - Optionally fetches the provided URL and extracts `<title>`, `<meta>` description, h1/h2 headings, primary nav text
   - Bounded: never reads more than ~30KB into the AI context
   - Output: a `ProjectContext` object the persona generator consumes

## Known gotchas (carry-over from Stage 1)

- **Playwright 1.59 removed `page.accessibility.snapshot()`.** Use CDP `Accessibility.getFullAXTree` instead (already wired in `capture.ts`).
- `noUncheckedIndexedAccess` is on. Be defensive with array indexing.
- `exactOptionalPropertyTypes` is on. Optional fields need explicit `| undefined` if you assign undefined.

## Smoke test target for Stage 2

```bash
cd ~/dev/some-recipe-app
gauntlet init --url https://localhost:3000 --model claude-opus-4-7
# AI proposes:
#   1. Mary, 67, retired teacher looking for chicken recipes (low-digital-confidence template)
#   2. Carlos, 34, dad with 20 min before pickup, mobile, slow 3G
#   3. Riley, 28, screen-reader user, vegan, wants ingredient filter
#   ...
# Dev accepts 5, rejects 2, edits 1, regenerates the rest
gauntlet run http://localhost:3000  # uses curated roster
```

## Continuation prompt (paste into next session)

> Continue Gauntlet Stage 2 (Phases A + B). Read `STAGE2.md` in the repo for scope. Full pipeline plan at `~/.claude/plans/now-that-i-m-using-tingly-karp.md`. Repo at `/home/jed/dev/gauntlet/`. Caveman mode on. Key constraints: gated/collaborative (dev curates at every transition), personas project-generated (core + edge), Mary is documentation only, vetting layer comes in Stage 5.
