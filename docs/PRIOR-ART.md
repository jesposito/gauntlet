# Prior art: making AI + Playwright reliable

Survey of what other people have shipped in the AI-drives-a-browser space, what they got right, and which of those ideas Gauntlet should borrow next. Not exhaustive. Not academic. Just what's load-bearing.

## Tools / projects worth knowing

### 1. Stagehand (BrowserBase, MIT, TypeScript)
- The `act` / `observe` / `extract` shape Gauntlet already adopted.
- **What's good**: observe returns ranked candidates with reasoning, not one guess. `act` accepts an observe-result as input so the two phases can be decoupled. The DOM is compressed into a numbered-element list that mirrors the accessibility tree — exactly what `src/agent/dom-outline.ts` does today.
- **What Gauntlet doesn't have yet**: confidence-thresholded `act` (refuse to act when observe match is weak), deterministic replay of an action chain without re-querying the AI.
- Repo: https://github.com/browserbase/stagehand

### 2. browser-use (MIT, Python)
- Agent loop with a richer perception layer — screenshot + numbered-overlay + DOM markup combined in the prompt.
- **What's good**: visual grounding (screenshot with numbers drawn on interactive elements) as a fallback when the DOM outline is ambiguous. Auto-retries failed actions. Has a "memory" of past steps the agent has already attempted, so it doesn't loop on the same dead end.
- **What Gauntlet doesn't have yet**: visual grounding, step memory.
- Repo: https://github.com/browser-use/browser-use

### 3. Anthropic Computer Use
- Pure-screenshot action grounding: model gets a screenshot, returns coordinates to click. No DOM at all.
- **What's good**: zero CSS-selector flakiness, by definition. Works on iframes, canvas-rendered UIs, anywhere DOM scraping fails.
- **Cost**: many tokens per step (screenshots are heavy), and the model has to "see" the rendered page so emulated mobile / slow network can produce mid-render snapshots.
- **Take**: not a wholesale replacement, but a great fallback when DOM-driven act fails twice.

### 4. Skyvern (OSS, Python)
- Production-flavored. Has retry, structured output extraction, and a queue model so long-running flows can be paused and resumed.
- **What Gauntlet doesn't have yet**: durable run-state. Today a hung flow loses partial progress; Skyvern would resume from the last checkpoint.

### 5. LaVague
- Translates natural-language instructions into Playwright code, then runs the code. Two-pass — codegen first, exec second.
- **Take**: probably overkill for Gauntlet's persona model, but the codegen-then-exec separation is interesting for the report vetter (replay deterministically without AI cost).

### 6. WebVoyager (academic benchmark)
- 643 real-world web tasks across 15 popular sites. The thing `gauntlet bench` semi-mimics.
- **Take**: stealing more of their task set + scoring methodology would make `gauntlet bench` a real leaderboard rather than a "bug count" curiosity. Issue #tn8.4 is closed but the harness is minimal — borrowing the WebVoyager rubric is the upgrade path.

### 7. WebArena / VisualWebArena
- Reproducible web-task benchmarks running in Docker. Not directly relevant to Gauntlet but worth knowing — academic comparison points use them.

### 8. Synthetic Users / Apriora / similar
- AI personas, but for interviews / surveys / hiring screens. NOT browser-driving.
- **Take**: their persona schemas are richer than Gauntlet's (Big Five + life history + interview transcripts). Worth borrowing for the persona-generator prompt to produce more textured characters.

## Patterns that come up repeatedly

### Pattern A — Two-phase observe→act with confidence threshold
Stagehand, browser-use, Skyvern all do this. Observe returns top-N candidates with scores; act only fires when the top score exceeds a threshold; otherwise re-observe with more context (or escalate to visual grounding). Today Gauntlet's `observe` returns a single best match — if the AI is wrong, `act` silently picks a bad element. Confidence-thresholded act is **the single highest-leverage borrow for selector reliability**.

### Pattern B — Visual grounding fallback
When the DOM outline doesn't contain a match (or contains too many lookalikes), screenshot-with-numbered-overlays is the fallback every reliable browser agent reaches for. Gauntlet currently fails closed when the outline doesn't match. Adding a screenshot fallback would unblock the hardest pages (canvas, iframes, heavily-shadow-DOMed UIs).

### Pattern C — Page-settle detection beyond `networkidle`
`networkidle` is well-known to be unreliable for SPAs that poll, websockets, telemetry pings, etc. The robust alternative is a mutation-observer-based settle: wait for N consecutive ms where the DOM didn't mutate, capped by a hard timeout. browser-use, Stagehand, and Skyvern all implement variants. Gauntlet's `waitForLoadState("networkidle", 8000)` is the minimum viable but will time out on real apps.

### Pattern D — Step memory / loop detection
Without memory, the agent can repeat the same wrong action. browser-use stores `(intent, action, outcome)` triples and feeds the last 3-5 into the next observe prompt. Cheap, big quality win for multi-step flows where one bad pick early derails everything.

### Pattern E — Self-healing locators
A locator picked from the outline can go stale (the page hydrated more, or the element scrolled out). Playwright auto-waits help but don't cover "element moved to a different index". The fix is to re-derive the locator at action time, not at pick time, and to allow the AI a second-pick when execution fails.

### Pattern F — Deterministic replay of recorded action chains
Both Stagehand and LaVague support recording the AI-driven session as a deterministic Playwright script (or close to it). For Gauntlet, this matters for the **vetter**: today the vetter re-runs axe at the captured URL but can't replay the action chain that *led* to the failure state. Recording + replaying chains would close the `flow_replay` vetting gap (currently flagged `[subjective]`).

### Pattern G — Strict judgment prompts
Multiple agent frameworks have learned the hard way that LLM judges over-dramatize personality. The fix is the prompt: require observable evidence for every verdict, default to "in_progress", explicitly forbid aesthetic distaste as a give-up trigger. Gauntlet shipped this in `src/runner/step-judge.ts` (2026-05-12).

### Pattern H — Per-network Playwright defaults
Slow-3g + Playwright's 30s default selector timeout = false-negatives every step. Multiplying default timeouts by the network slowdown factor cleans up most "selector not found on slow network" flakes. Gauntlet shipped this (2026-05-12).

### Pattern I — Bounded retries on AI ops
Anthropic / OpenAI 5xx + transient timeouts are common enough that every production agent retries once with a fresh AbortController. Gauntlet shipped `aiOpWithTimeout` (2026-05-12).

## Recommended next moves for Gauntlet (in priority order)

1. **Confidence-thresholded observe→act** (Pattern A). Return top-3 from observe with scores; act only when top > threshold; otherwise re-observe. ~3 hours.
2. **Mutation-observer page-settle** (Pattern C). Helper that waits for `M ms of DOM stability` capped at `N ms`. Use after every act. ~1 hour.
3. **Step memory** (Pattern D). Pass last 3 `(intent, action, outcome)` triples to observe so it can avoid repeating mistakes. ~1 hour.
4. **Visual-grounding fallback** (Pattern B). When observe returns "no match", capture screenshot, draw numbered overlays on interactive elements, send to AI with model that accepts images, retry once. ~4 hours.
5. **Deterministic flow replay** (Pattern F). Record `(persona, flow, action-chain)` per run. Replay the chain in the vetter without re-querying AI. Closes the `flow_replay` vetting gap. ~4 hours.
6. **Borrow WebVoyager's scoring** (Tool #6). Replace bench's "bug count" with WebVoyager task-success rate. Makes `gauntlet bench` a real leaderboard. ~2 hours of grunt work + a writeup.
7. **Persona schema refresh** (Synthetic Users-inspired). Split `abandons_on` into `blocked_by` (observable constraints) and `irritated_by` (narration tone only). Removes the temptation for the AI judge to bail for aesthetic reasons. ~2 hours.

The first three together would meaningfully cut Gauntlet's flake rate — the single biggest complaint about the tool today.
