import type { ZodSchema } from "zod";
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
    const cache = getAiCache();
    if (!cache?.enabled) return this.inner.propose(opts);

    const inputs = cache.inputsFor(this.inner.name, this.inner.model, opts);
    const hit = await cache.get<T>(inputs);
    if (hit !== undefined) {
      const validated = opts.schema.safeParse(hit);
      if (validated.success) return validated.data;
    }
    const out = await this.inner.propose(opts);
    await cache.set(inputs, out);
    return out;
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
