import { afterEach, describe, expect, test } from "bun:test";
import {
  _setAxeRunnerForTesting,
  _setBrowserLauncherForTesting,
  raceWithTimeout,
  vetAll,
  withVetTimeout,
} from "./vetter.ts";
import type { Finding } from "./schema.ts";
import type { GauntletEvent } from "../events.ts";
import { FailureReason } from "../runner/failure-reasons.ts";

describe("withVetTimeout", () => {
  // Real-world dogfood (audplexus 2026-05-13): the vetter hung 20+ minutes
  // holding chromium because AxeBuilder.analyze() never resolved. Without a
  // per-finding wallclock, one bad page freezes the entire vetting pass.
  test("resolves with the underlying value when work completes in time", async () => {
    const work = Promise.resolve("ok");
    const result = await withVetTimeout("fast", work, 1_000);
    expect(result).toBe("ok");
  });

  test("rejects with a labeled timeout when work exceeds the budget", async () => {
    const slow = new Promise<string>((resolve) =>
      setTimeout(() => resolve("too late"), 200),
    );
    await expect(withVetTimeout("axe-replay", slow, 25)).rejects.toThrow(
      /vet timeout: axe-replay exceeded 25ms/,
    );
  });

  test("propagates underlying rejection without conflating with timeout", async () => {
    const failing = Promise.reject(new Error("network down"));
    await expect(withVetTimeout("openSession", failing, 1_000)).rejects.toThrow(
      "network down",
    );
  });
});

describe("raceWithTimeout (close-side, swallow-on-timeout)", () => {
  // Real-world dogfood (audplexus 2026-05-14): vetter hung 25+ minutes in
  // closeSession after axe work was complete and chromium had already exited.
  // The close paths must not throw or block the outer finally — a leaked OS
  // handle is preferable to a frozen process the user can't tell anything
  // about.
  test("resolves cleanly when underlying close succeeds in time", async () => {
    let captured: string | undefined;
    const orig = console.warn;
    console.warn = (msg: string) => {
      captured = msg;
    };
    try {
      await raceWithTimeout("ok-close", Promise.resolve(), 1_000);
      expect(captured).toBeUndefined();
    } finally {
      console.warn = orig;
    }
  });

  test("warns and resolves (never rejects) when underlying close exceeds budget", async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const stuck = new Promise<void>(() => {
        /* never resolves */
      });
      await raceWithTimeout("stuck-close", stuck, 25);
      expect(warnings.some((w) => /stuck-close did not complete within 25ms/.test(w))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test("warns and resolves when underlying close throws", async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const failing = Promise.reject(new Error("orphan context"));
      await raceWithTimeout("error-close", failing, 1_000);
      expect(warnings.some((w) => /error-close threw during close: orphan context/.test(w))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test("routes warnings through emit when an emitter is provided (no console.warn)", async () => {
    const events: GauntletEvent[] = [];
    const orig = console.warn;
    let consoleCalled = false;
    console.warn = () => {
      consoleCalled = true;
    };
    try {
      const failing = Promise.reject(new Error("orphan context"));
      await raceWithTimeout(
        "emit-close",
        failing,
        1_000,
        (e) => events.push(e),
      );
      expect(consoleCalled).toBe(false);
      const warns = events.filter((e) => e.type === "warn");
      expect(warns.length).toBe(1);
      expect((warns[0] as Extract<GauntletEvent, { type: "warn" }>).message).toMatch(
        /emit-close threw during close: orphan context/,
      );
    } finally {
      console.warn = orig;
    }
  });
});

// --------------------------------------------------------------------------
// vetAll event emission
//
// Real-world dogfood (audplexus 2026-05-14): a 23-finding vetter ran ~25min
// with zero terminal output between "building report" and the final write.
// These tests pin the event-stream contract that lets renderers narrate the
// vetting phase in real time, so that hostile-case experience never recurs.
// --------------------------------------------------------------------------

interface FakePageHooks {
  onGoto?: () => void | Promise<void>;
}

function makeFakeBrowser(hooks: FakePageHooks = {}): {
  browser: { newContext: () => Promise<unknown>; close: () => Promise<void> };
  closeCount: { value: number };
} {
  const closeCount = { value: 0 };
  const fakePage = {
    on: () => fakePage,
    goto: async () => {
      if (hooks.onGoto) await hooks.onGoto();
      return null;
    },
    waitForTimeout: async () => undefined,
  } as const;
  const fakeContext = {
    newPage: async () => fakePage,
    close: async () => undefined,
  };
  const browser = {
    newContext: async () => fakeContext,
    close: async () => {
      closeCount.value += 1;
    },
  };
  return { browser, closeCount };
}

function baseFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    personaId: "p1",
    url: "https://example.test/",
    reason: FailureReason.ACCESSIBILITY_VIOLATION,
    severity: "moderate",
    title: "x",
    detail: "y",
    artifacts: {},
    replayStrategy: "axe_recheck",
    axeRuleId: "color-contrast",
    vetting: { status: "unverified" },
    ...overrides,
  } as Finding;
}

describe("vetAll event emission", () => {
  afterEach(() => {
    _setBrowserLauncherForTesting(undefined);
    _setAxeRunnerForTesting(undefined);
  });

  test("emits the full per-URL lifecycle in order", async () => {
    const { browser } = makeFakeBrowser();
    _setBrowserLauncherForTesting({ launch: async () => browser as never });
    _setAxeRunnerForTesting(async () => ({
      violations: [{ id: "color-contrast" }],
    }));

    const events: GauntletEvent[] = [];
    await vetAll(
      [
        baseFinding({ id: "f1", axeRuleId: "color-contrast" }),
        baseFinding({ id: "f2", axeRuleId: "missing-rule" }),
      ],
      { emit: (e) => events.push(e) },
    );

    const types = events.map((e) => e.type);
    // Required ordering for a single URL serving two findings.
    const expected: GauntletEvent["type"][] = [
      "vet_start",
      "vet_url_start",
      "vet_url_navigate",
      "vet_url_axe_start",
      "vet_url_axe_end",
      "vet_finding",
      "vet_finding",
      "vet_url_close",
      "vet_end",
    ];
    expect(types).toEqual(expected);
  });

  test("vet_end summary counts match per-finding statuses", async () => {
    const { browser } = makeFakeBrowser();
    _setBrowserLauncherForTesting({ launch: async () => browser as never });
    // axe rule "still-broken" present -> regressed; "fixed" absent -> verified.
    _setAxeRunnerForTesting(async () => ({
      violations: [{ id: "still-broken" }],
    }));

    const events: GauntletEvent[] = [];
    await vetAll(
      [
        baseFinding({ id: "f1", axeRuleId: "still-broken" }),
        baseFinding({ id: "f2", axeRuleId: "fixed" }),
        baseFinding({
          id: "f3",
          replayStrategy: "none",
          axeRuleId: undefined,
        }),
      ],
      { emit: (e) => events.push(e) },
    );

    const end = events.find((e) => e.type === "vet_end") as
      | Extract<GauntletEvent, { type: "vet_end" }>
      | undefined;
    expect(end).toBeDefined();
    expect(end!.regressed).toBe(1);
    expect(end!.verified).toBe(1);
    expect(end!.subjective).toBe(1);
    expect(end!.couldNotReplay).toBe(0);
  });

  test("emits warn + could_not_replay vet_finding when openSession fails", async () => {
    const { browser } = makeFakeBrowser({
      onGoto: async () => {
        // openSession itself doesn't throw on goto failure (it captures
        // navError + sets navigatedOk=false). To trigger the catch branch
        // (warn path) we make runAxe throw during the in-progress session.
      },
    });
    _setBrowserLauncherForTesting({ launch: async () => browser as never });
    _setAxeRunnerForTesting(async () => {
      throw new Error("axe blew up");
    });

    const events: GauntletEvent[] = [];
    await vetAll([baseFinding({ id: "f1" })], {
      emit: (e) => events.push(e),
    });

    const warns = events.filter((e) => e.type === "warn");
    expect(warns.length).toBeGreaterThanOrEqual(1);
    const finding = events.find(
      (e) => e.type === "vet_finding",
    ) as Extract<GauntletEvent, { type: "vet_finding" }>;
    expect(finding.status).toBe("could_not_replay");
  });

  // Codex audit 2026-05-14, finding #3. Pre-fix, when openSession threw
  // partway through (e.g. axe blew up after newContext succeeded), the
  // partially-opened BrowserContext was held until vetAll's outer
  // browser.close() at the end of the call. The fix wraps openSession in
  // try/catch and best-effort closes the partial context before re-throwing.
  test("openSession releases partial context when axe throws (no leak)", async () => {
    const closedContexts: string[] = [];
    const fakePage = {
      on: () => fakePage,
      goto: async () => null,
      waitForTimeout: async () => undefined,
    } as const;
    let contextSeq = 0;
    const browser = {
      newContext: async () => {
        const id = `ctx-${++contextSeq}`;
        return {
          newPage: async () => fakePage,
          close: async () => {
            closedContexts.push(id);
          },
        };
      },
      close: async () => undefined,
    };
    _setBrowserLauncherForTesting({ launch: async () => browser as never });
    _setAxeRunnerForTesting(async () => {
      throw new Error("axe blew up partway through");
    });

    await vetAll([baseFinding({ id: "f1", url: "https://leak.test/" })], {
      // Default 60s budget would normally let the work complete; here axe
      // throws synchronously so we don't risk timing flake.
      emit: () => undefined,
    });

    // Partial context must be released by openSession's catch — not deferred
    // to vetAll's final close. Pre-fix this array was empty until the outer
    // browser teardown reaped everything implicitly.
    expect(closedContexts.length).toBeGreaterThanOrEqual(1);
    expect(closedContexts[0]).toBe("ctx-1");
  });

  test("vet_start carries total + distinctUrls; sessionTotal aggregates by url+surface", async () => {
    const { browser } = makeFakeBrowser();
    _setBrowserLauncherForTesting({ launch: async () => browser as never });
    _setAxeRunnerForTesting(async () => ({ violations: [] }));

    const events: GauntletEvent[] = [];
    await vetAll(
      [
        baseFinding({ id: "f1", url: "https://a.test/" }),
        baseFinding({ id: "f2", url: "https://a.test/" }),
        baseFinding({ id: "f3", url: "https://b.test/" }),
      ],
      { emit: (e) => events.push(e) },
    );

    const start = events.find((e) => e.type === "vet_start") as Extract<
      GauntletEvent,
      { type: "vet_start" }
    >;
    expect(start.total).toBe(3);
    expect(start.distinctUrls).toBe(2);

    const urlStarts = events.filter(
      (e) => e.type === "vet_url_start",
    ) as Extract<GauntletEvent, { type: "vet_url_start" }>[];
    expect(urlStarts.length).toBe(2);
    expect(urlStarts[0]!.sessionIndex).toBe(1);
    expect(urlStarts[1]!.sessionIndex).toBe(2);
    expect(urlStarts[0]!.sessionTotal).toBe(2);
    // First URL has 2 findings sharing it.
    expect(urlStarts[0]!.findingCount).toBe(2);
  });
});
