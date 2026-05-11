# Gauntlet

> Run a gauntlet of personas against your product. Get repro-ready UX + a11y bugs in 10 minutes.

Gauntlet is a free, self-hosted CLI that puts your web app through a procession of AI-driven tester personas. Each persona has a character (a real person with goals and frustrations) and a behavior model (patience thresholds, device, input method, accessibility constraints). Personas use your product like real users, narrate their experience in-character, and file bug reports with full evidence: DOM snapshots, accessibility trees, screenshots, console errors, network logs, and a deterministic Playwright replay script for every finding.

**No SaaS. No telemetry. BYO AI agent.** Works with Anthropic Claude, OpenAI, Google Gemini, or local Ollama.

## Status: alpha scaffolding

Stage 1 (current): repo scaffold, persona schema, single Playwright runner with screenshot + accessibility tree capture.

See `~/.claude/plans/now-that-i-m-using-tingly-karp.md` for the full design plan and build sequence.

## Quick start (when ready)

```bash
bun install
bunx playwright install chromium
bun run smoke
```

## Built-in personas (planned for v0.1)

| ID | Character | Why they're here |
|----|-----------|------------------|
| `mary` | 67, retired teacher, new tablet | low digital confidence, avoids modals |
| `devon` | 28, power user | input fuzzer, paste-garbage tester |
| `asha` | 34, screen-reader user | drives via a11y tree, keyboard-only |
| `jamal` | 19, mobile-only | slow 3G, abandons fast |
| `priya` | 42, ESL | 6th-grade reading level, slow but careful |
| `tom` | 51, skeptical | won't sign up without seeing value |

## License

MIT
