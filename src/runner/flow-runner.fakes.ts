/**
 * Test-only fakes for runFlow integration tests. NOT exported from any
 * production entry point. Lives next to the test file so the stubbing surface
 * (everything runFlow calls on Playwright + AiProvider) is documented in one
 * place.
 *
 * Why a hand-rolled fake instead of jest.mock-style auto-mock or a real
 * about:blank page:
 *   - Auto-mock can't model the wallclock semantics ("browser.close() must
 *     reject in-flight ops").
 *   - A real Chromium round-trip costs 300-800ms per test and pulls in
 *     downloaded browser binaries the test runner shouldn't depend on.
 *   - Hand-rolled lets us assert resource-cleanup contracts (close was called)
 *     and inject controllable failure timing for the wallclock path.
 */
import type { ZodSchema } from "zod";
import type { AiProvider, ProposeOptions } from "../ai/provider.ts";
import type { OutlineElement } from "../agent/dom-outline.ts";

export interface FakeProviderResponses {
  /**
   * Ordered queue of propose() responses. Each call to propose() shifts the
   * head. If the head is a function, it's called with the propose options and
   * the return value is used; this lets a test assert on schema/messages or
   * model a never-resolving response.
   *
   * Schema-name-aware: if a queued response is `{ schemaName, value }`, it
   * only fires when the next propose() matches that schemaName. This keeps
   * the per-step ordering (LocatorPick -> ActionPick -> StepVerdict) honest
   * without forcing tests to count interleaved calls.
   */
  queue: Array<
    | unknown
    | ((opts: ProposeOptions<unknown>) => unknown | Promise<unknown>)
    | { schemaName: string; value: unknown }
  >;
}

export class FakeProvider implements AiProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  readonly proposeCalls: Array<{ schemaName: string; messages: unknown }> = [];
  private readonly responses: FakeProviderResponses;

  constructor(responses: FakeProviderResponses) {
    this.responses = responses;
  }

  async propose<T>(opts: ProposeOptions<T>): Promise<T> {
    this.proposeCalls.push({
      schemaName: opts.schemaName,
      messages: opts.messages,
    });
    const head = this.responses.queue.shift();
    if (head === undefined) {
      throw new Error(
        `FakeProvider: propose() called with schemaName=${opts.schemaName} but queue is empty`,
      );
    }
    let value: unknown;
    if (typeof head === "function") {
      value = await (head as (o: ProposeOptions<unknown>) => unknown)(
        opts as unknown as ProposeOptions<unknown>,
      );
    } else if (
      head !== null &&
      typeof head === "object" &&
      "schemaName" in head &&
      "value" in head
    ) {
      const tagged = head as { schemaName: string; value: unknown };
      if (tagged.schemaName !== opts.schemaName) {
        throw new Error(
          `FakeProvider: expected propose(schemaName=${tagged.schemaName}) but got ${opts.schemaName}`,
        );
      }
      value = tagged.value;
    } else {
      value = head;
    }
    // Skip schema validation — tests are responsible for queuing valid
    // shapes. We re-parse to surface schema mismatches loudly when a test
    // misconfigures a stub.
    return (opts.schema as ZodSchema<T>).parse(value);
  }
}

/**
 * Tracking record for spies on the fake browser/context. Tests assert against
 * this instead of installing per-method spies.
 */
export interface FakeBrowserSpyState {
  launchCount: number;
  closeCount: number;
  contextCloseCount: number;
  cdpSendCalls: string[];
  /** Set of pending provider/observe rejections to fire when browser closes. */
  closeRejecters: Array<(err: Error) => void>;
}

export interface PlaywrightStubConfig {
  /** Outline returned by getOutline() page.evaluate calls. */
  outline: OutlineElement[];
  /** Body innerText returned by getPageText() page.evaluate calls. */
  bodyText: string;
  /** URL the fake page reports. */
  url: string;
  /** Title the fake page reports. */
  title: string;
  /** Spy state shared with the test. */
  spy: FakeBrowserSpyState;
}

export function makePlaywrightStub(cfg: PlaywrightStubConfig): {
  chromium: { launch: (opts: unknown) => Promise<unknown> };
} {
  const OUTLINE_MARKER = "isVisible"; // appears only in the outline script
  const PAGETEXT_MARKER = "document.body ? document.body.innerText";
  const SETTLE_MARKER = "MutationObserver";

  const fakeLocator = {
    click: async () => undefined,
    fill: async () => undefined,
    press: async () => undefined,
    selectOption: async () => undefined,
    scrollIntoViewIfNeeded: async () => undefined,
    hover: async () => undefined,
    first: () => fakeLocator,
  };

  const fakePage = {
    setDefaultTimeout: () => undefined,
    setDefaultNavigationTimeout: () => undefined,
    on: () => fakePage,
    goto: async () => null,
    url: () => cfg.url,
    title: async () => cfg.title,
    content: async () => "<html></html>",
    screenshot: async () => Buffer.from(""),
    evaluate: async (script: unknown) => {
      const s = typeof script === "string" ? script : "";
      if (s.includes(OUTLINE_MARKER)) return cfg.outline;
      if (s.includes(PAGETEXT_MARKER)) return cfg.bodyText;
      if (s.includes(SETTLE_MARKER)) return undefined;
      // Anything else (axe injection, etc) — return null. AxeBuilder will
      // throw downstream and runAxe will catch it.
      return null;
    },
    getByRole: () => fakeLocator,
    getByLabel: () => fakeLocator,
    getByText: () => fakeLocator,
    locator: () => fakeLocator,
  };

  const fakeCdp = {
    send: async (method: string) => {
      cfg.spy.cdpSendCalls.push(method);
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      return undefined;
    },
    detach: async () => undefined,
  };

  const fakeContext = {
    newPage: async () => fakePage,
    newCDPSession: async () => fakeCdp,
    close: async () => {
      cfg.spy.contextCloseCount++;
    },
  };

  const fakeBrowser = {
    newContext: async () => fakeContext,
    close: async () => {
      cfg.spy.closeCount++;
      // Fire any pending rejecters: this is how production-Playwright would
      // unblock in-flight ops when the browser dies. Wallclock test relies
      // on this to make a hung observe() actually reject.
      const rejecters = cfg.spy.closeRejecters.splice(0);
      for (const r of rejecters) {
        r(
          new Error(
            "Target page, context or browser has been closed",
          ),
        );
      }
    },
  };

  return {
    chromium: {
      launch: async () => {
        cfg.spy.launchCount++;
        return fakeBrowser;
      },
    },
  };
}

/**
 * A propose() response that never resolves on its own, but rejects when the
 * fake browser is closed. Used by the wallclock test to model "AI fetch is
 * still pending when the alarm fires; browser-close interrupts it."
 */
export function pendingUntilBrowserClose(spy: FakeBrowserSpyState) {
  return () =>
    new Promise<never>((_, reject) => {
      spy.closeRejecters.push(reject);
    });
}

export function makeSpyState(): FakeBrowserSpyState {
  return {
    launchCount: 0,
    closeCount: 0,
    contextCloseCount: 0,
    cdpSendCalls: [],
    closeRejecters: [],
  };
}

/** Minimal valid persona for runFlow. */
export function makePersona(overrides: Record<string, unknown> = {}) {
  return {
    id: "tester",
    character: {
      name: "Tester",
      context: "QA fake",
      voice: "matter of fact",
    },
    behavior: {
      goals: ["test the runner"],
      device: "desktop" as const,
      viewport: { width: 1280, height: 720 },
      network: "fast-fiber" as const,
      input: "mouse" as const,
      patience_threshold_seconds: 60,
      reading_level: "9th_grade" as const,
      avoids: [],
      abandons_on: [],
      prefers: [],
    },
    ...overrides,
  };
}

/** Minimal valid flow with a single step that has an observation_target. */
export function makeFlow(overrides: Record<string, unknown> = {}) {
  return {
    id: "flow-a",
    persona_id: "tester",
    title: "Flow A",
    goal: "Do the thing",
    steps: [
      {
        intent: "click the button",
        observation_target: "primary action button",
        success_criteria: "button is visible",
        give_up_criteria: [],
      },
      {
        intent: "follow up",
        observation_target: "second affordance",
        success_criteria: "second is visible",
        give_up_criteria: [],
      },
    ],
    rationale: "tests the loop",
    tags: [],
    paths: [],
    ...overrides,
  };
}

export function makeOutline(): OutlineElement[] {
  return [
    {
      idx: 0,
      role: "button",
      name: "Submit",
      tag: "button",
      text: "Submit",
      href: null,
      visible: true,
    },
  ];
}
