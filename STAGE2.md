# Stage 2 pickup

Stage 1 (commit `ccfe9df`) shipped the scaffold: persona schema, Mary as worked example, Playwright runner with full per-step capture, CLI, smoke test against example.com.

## Big reframe for Stage 2

**Personas are NOT a fixed library.** They're generated per-project. The tool reads your project and proposes personas tailored to *your* product. You curate. Repeat until critical mass.

Mary stays in the repo as a worked example of what a `low-digital-confidence-on-tablet` template looks like once instantiated against a recipe site. She is documentation, not a default. Each project produces its own roster.

## Stage 2 scope

1. **`gauntlet init` command** (`src/cli.ts` + `src/init/`)
   - Reads project context: `README.md`, `package.json` deps, top-level routes if framework detected, optional `--url <url>` to fetch and analyze the landing page
   - AI fans out: "based on what this product does, who are the realistic target users?"
   - Proposes 8-12 candidate personas
   - Interactive CLI: accept / reject / edit / regenerate / write-my-own
   - Accepted personas written to `.gauntlet/personas/<id>.yaml`
   - Re-runnable: subsequent `init` augments rather than replaces

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

> Continue Gauntlet Stage 2. Read `STAGE2.md` in the repo for scope. Plan at `~/.claude/plans/now-that-i-m-using-tingly-karp.md`. Repo at `/home/jed/dev/gauntlet/`. Caveman mode on. Critical reframe from Jed: personas are project-generated, not a fixed library — Mary stays as a worked example only.
