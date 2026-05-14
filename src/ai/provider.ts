import type { ZodSchema } from "zod";
import { type AiCallPurpose, type EventEmitter, nextCallId, nullEmitter } from "../events.ts";
import { getAiCache } from "./cache.ts";

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProposeOptions<T> {
  messages: AiMessage[];
  schema: ZodSchema<T>;
  schemaName: string;
  schemaDescription?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Optional AbortSignal — when aborted, the underlying fetch is cancelled.
   * Used by flow-runner's per-step timeout so a hung AI call actually
   * stops mutating state instead of running to completion in the background.
   */
  signal?: AbortSignal;
  /**
   * Optional purpose tag for event emission. When set AND a global event
   * emitter is registered (see setGlobalEventEmitter), the call is bracketed
   * with ai_call_start / ai_call_end events so renderers can paint a
   * spinner + cache-aware completion line. Omit to opt out (back-compat).
   */
  purpose?: AiCallPurpose;
}

let _globalEmit: EventEmitter = nullEmitter;

/**
 * Register the process-wide event emitter that CachingProvider.propose() will
 * use to bracket AI calls. Threading an `emit` through every propose() call
 * site would touch ~6 files of pure plumbing; a singleton lets the CLI plug
 * in once at startup and every nested AI call gets visibility for free.
 *
 * Tests should call this at setup and reset to nullEmitter at teardown.
 */
export function setGlobalEventEmitter(emit: EventEmitter): void {
  _globalEmit = emit;
}

export function getGlobalEventEmitter(): EventEmitter {
  return _globalEmit;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  propose<T>(opts: ProposeOptions<T>): Promise<T>;
}

export interface ProviderFactory {
  readonly id: string;
  readonly modelPrefixes: string[];
  create(model: string): AiProvider;
}

const factories: ProviderFactory[] = [];

export function registerProvider(factory: ProviderFactory): void {
  factories.push(factory);
}

class CachingProvider implements AiProvider {
  readonly name: string;
  readonly model: string;
  private readonly inner: AiProvider;

  constructor(inner: AiProvider) {
    this.inner = inner;
    this.name = inner.name;
    this.model = inner.model;
  }

  async propose<T>(opts: ProposeOptions<T>): Promise<T> {
    const emit = _globalEmit;
    const purpose = opts.purpose;
    const callId = purpose !== undefined ? nextCallId() : "";
    const startedAt = Date.now();
    if (purpose !== undefined) {
      emit({
        type: "ai_call_start",
        callId,
        purpose,
        model: this.inner.model,
        ts: startedAt,
      });
    }

    let cached = false;
    try {
      const cache = getAiCache();
      if (!cache?.enabled) {
        return await this.inner.propose(opts);
      }

      const inputs = cache.inputsFor(this.inner.name, this.inner.model, opts);
      const hit = await cache.get<T>(inputs);
      if (hit !== undefined) {
        const validated = opts.schema.safeParse(hit);
        if (validated.success) {
          cached = true;
          return validated.data;
        }
      }
      const out = await this.inner.propose(opts);
      await cache.set(inputs, out);
      return out;
    } finally {
      if (purpose !== undefined) {
        const endedAt = Date.now();
        emit({
          type: "ai_call_end",
          callId,
          durationMs: endedAt - startedAt,
          cached,
          ts: endedAt,
        });
      }
    }
  }
}

export function pickProvider(model: string): AiProvider {
  for (const f of factories) {
    if (f.modelPrefixes.some((p) => model.startsWith(p))) {
      return new CachingProvider(f.create(model));
    }
  }
  throw new Error(
    `no provider for model "${model}". known prefixes: ${factories
      .flatMap((f) => f.modelPrefixes)
      .join(", ")}`,
  );
}

export const DEFAULT_MODEL = "claude-opus-4-7";

export function extractJsonBlock(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  const firstArr = text.indexOf("[");
  const lastArr = text.lastIndexOf("]");
  if (firstArr !== -1 && lastArr > firstArr) return text.slice(firstArr, lastArr + 1);
  return text.trim();
}
