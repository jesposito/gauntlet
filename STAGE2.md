# Stage 2 pickup

Stage 1 (this commit) shipped the scaffold: persona schema, Mary YAML, Playwright runner with full per-step capture, CLI, smoke test against example.com.

## Stage 2 scope

Make the personas actually *do* things. Right now they just navigate and capture; they don't interact with the page.

1. **AI provider abstraction** (`src/ai/provider.ts`)
   - One interface: `propose(messages, tools) -> { action, narration, frustration_delta }`
   - Adapters: `anthropic.ts` (Claude, default), `openai.ts`, `google.ts`, `ollama.ts`
   - BYO key via env: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.
   - Single `--model claude-opus-4-7` flag picks provider + model

2. **Stagehand integration** (`src/runner/actor.ts`)
   - Wrap Stagehand's `act`/`observe`/`extract` primitives
   - One Stagehand instance per persona, reuses our existing Playwright Page
   - Need to verify Stagehand can attach to an existing page rather than spawning its own

3. **Action loop**
   - Each step: observe page → ask model for next action in-character → execute → capture
   - Bounded by `patience_threshold_seconds` AND `maxSteps`
   - Persona prompt template includes character context + behavior constraints + current goal

4. **Frustration meter + abandonment**
   - Tracks signals: time elapsed, consecutive errors, modals dismissed, unexpected redirects
   - When threshold hit, persona "abandons" → run ends, finding emitted: "abandoned because X"
   - Each abandonment is itself a finding (with persona quote)

5. **In-character narration**
   - Every step the model emits a 1-2 sentence in-character thought
   - Stored in `steps/<n>/narration.json` alongside other capture
   - Used later by the report renderer

## Known gotchas

- **Playwright 1.59 removed `page.accessibility.snapshot()`.** Use CDP `Accessibility.getFullAXTree` instead (already wired in `capture.ts`).
- `noUncheckedIndexedAccess` is on. Be defensive with array indexing.
- `exactOptionalPropertyTypes` is on. Optional fields need explicit `| undefined` if you assign undefined.

## Smoke test target for Stage 2

By end of Stage 2:

```bash
bun run src/cli.ts run https://example.com --personas mary --steps 5
```

...should produce narration like:

```
[mary step 0] "Let me see what this is. example.com... not sure what they sell."
[mary step 1] "I'll tap that 'More information' link."
[mary step 2] "Wait, this took me to a different site. Where am I now?"
```

And `meta.json` includes `narrationCount`, `frustrationFinal`, `abandoned`.

## Continuation prompt (paste into next session)

> Continue Gauntlet Stage 2. Read `STAGE2.md` for scope. Plan at `~/.claude/plans/now-that-i-m-using-tingly-karp.md`. Repo at `/home/jed/dev/gauntlet/`. Caveman mode on.
