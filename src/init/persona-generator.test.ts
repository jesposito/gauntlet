import { describe, expect, test } from "bun:test";
import {
  generateCandidates,
  type PersonaCandidate,
} from "./persona-generator.ts";
import type { AiProvider } from "../ai/provider.ts";
import type { ProjectContext } from "./project-reader.ts";

// Local minimal shape of the propose() call so tests can inspect what the
// production caller asked for without dragging the generic AiProvider
// type into scope.
interface RecordedCall {
  messages: Array<{ role: string; content: string }>;
}

function fakeProject(): ProjectContext {
  return {
    projectName: "TestApp",
    packageDescription: "",
    keywords: [],
    frameworks: [],
    readme: "",
    landings: [],
  } as unknown as ProjectContext;
}

function fakeCandidate(id: string): PersonaCandidate {
  return {
    id,
    label: "core",
    rationale: `Why ${id}`,
    surface: undefined,
    character: {
      name: `Persona ${id}`,
      age: 30,
      context: "context",
      voice: "voice",
      personality: {
        openness: 50,
        conscientiousness: 50,
        extraversion: 50,
        agreeableness: 50,
        neuroticism: 50,
      },
    },
    behavior: {
      goals: ["goal a", "goal b"],
      device: "desktop",
      viewport: { width: 1440, height: 900 },
      network: "fast-fiber",
      input: "mouse",
      patience_threshold_seconds: 30,
      reading_level: "9th_grade",
      avoids: [],
      abandons_on: [],
      prefers: [],
    },
  } as unknown as PersonaCandidate;
}

/**
 * Mock provider that yields fresh candidate batches. Lets us assert how many
 * calls were made and that the focus directive was forwarded into the user
 * prompt.
 */
function makeProvider(
  batchFactory: (callIdx: number, askedFor: number) => PersonaCandidate[],
): { provider: AiProvider; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let idx = 0;
  const provider = {
    propose: async (opts: RecordedCall) => {
      calls.push(opts);
      const user = String(opts.messages[opts.messages.length - 1]?.content ?? "");
      const m = user.match(/Propose (\d+) persona candidates/);
      const asked = m ? Number(m[1]) : 10;
      const batch = batchFactory(idx++, asked);
      return { candidates: batch.slice(0, Math.min(batch.length, 16)) };
    },
  } as unknown as AiProvider;
  return { provider, calls };
}

describe("generateCandidates", () => {
  test("single-batch path when count <= batch size", async () => {
    const { provider, calls } = makeProvider((_, asked) =>
      Array.from({ length: asked }, (_, i) => fakeCandidate(`p${i}`)),
    );
    const out = await generateCandidates({
      provider,
      project: fakeProject(),
      templates: [],
      count: 8,
    });
    expect(out).toHaveLength(8);
    expect(calls).toHaveLength(1);
  });

  test("batches when count exceeds per-call cap (e.g. 30 personas)", async () => {
    // Each batch returns a fresh tranche of unique ids so the dedupe set
    // grows monotonically. The loop should keep going until 30 are gathered.
    let nextId = 0;
    const { provider, calls } = makeProvider((_, asked) => {
      const out: PersonaCandidate[] = [];
      for (let i = 0; i < asked; i++) {
        out.push(fakeCandidate(`p${nextId++}`));
      }
      return out;
    });
    const out = await generateCandidates({
      provider,
      project: fakeProject(),
      templates: [],
      count: 30,
    });
    expect(out).toHaveLength(30);
    // 30 / 12 = 2.5, so at least 3 calls.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // Every persona is unique.
    const ids = new Set(out.map((p) => p.id));
    expect(ids.size).toBe(30);
  });

  test("stops gracefully when the model saturates", async () => {
    // Return 4 uniques on the first call, then empty for the rest. The
    // saturation guard should bail after two consecutive empties and return
    // what was collected.
    let callIdx = 0;
    const { provider, calls } = makeProvider((_) => {
      if (callIdx++ === 0) return [0, 1, 2, 3].map((i) => fakeCandidate(`p${i}`));
      return [];
    });
    const out = await generateCandidates({
      provider,
      project: fakeProject(),
      templates: [],
      count: 30,
    });
    expect(out).toHaveLength(4);
    // First call + two empty batches = 3 total.
    expect(calls).toHaveLength(3);
  });

  test("focus directive is threaded into the user prompt", async () => {
    const { provider, calls } = makeProvider((_, asked) =>
      Array.from({ length: asked }, (_, i) => fakeCandidate(`p${i}`)),
    );
    await generateCandidates({
      provider,
      project: fakeProject(),
      templates: [],
      count: 6,
      focus: "the destinations form and post-error recovery",
    });
    const user = String(calls[0]?.messages[1]?.content ?? "");
    expect(user).toContain("Focus directive");
    expect(user).toContain("destinations form and post-error recovery");
  });

  test("no focus directive in prompt when focus is unset", async () => {
    const { provider, calls } = makeProvider((_, asked) =>
      Array.from({ length: asked }, (_, i) => fakeCandidate(`p${i}`)),
    );
    await generateCandidates({
      provider,
      project: fakeProject(),
      templates: [],
      count: 6,
    });
    const user = String(calls[0]?.messages[1]?.content ?? "");
    expect(user).not.toContain("Focus directive");
  });
});
