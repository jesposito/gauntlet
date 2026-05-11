import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AiMessage, ProposeOptions } from "./provider.ts";

const CACHE_DIR_NAME = ".gauntlet/cache/ai";

export interface CacheKeyInputs {
  provider: string;
  model: string;
  messages: AiMessage[];
  schemaName: string;
  schemaDescription?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CacheEntry<T> {
  hash: string;
  createdAt: number;
  inputs: CacheKeyInputs;
  output: T;
}

export function hashKey(inputs: CacheKeyInputs): string {
  const canonical = JSON.stringify({
    provider: inputs.provider,
    model: inputs.model,
    messages: inputs.messages,
    schemaName: inputs.schemaName,
    schemaDescription: inputs.schemaDescription ?? "",
    maxTokens: inputs.maxTokens ?? null,
    temperature: inputs.temperature ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export interface AiCacheOptions {
  enabled: boolean;
  cwd: string;
}

export class AiCache {
  readonly enabled: boolean;
  readonly dir: string;

  constructor(opts: AiCacheOptions) {
    this.enabled = opts.enabled;
    this.dir = join(opts.cwd, CACHE_DIR_NAME);
  }

  private pathFor(hash: string): string {
    return join(this.dir, `${hash}.json`);
  }

  async get<T>(inputs: CacheKeyInputs): Promise<T | undefined> {
    if (!this.enabled) return undefined;
    const hash = hashKey(inputs);
    try {
      const raw = await readFile(this.pathFor(hash), "utf8");
      const entry = JSON.parse(raw) as CacheEntry<T>;
      return entry.output;
    } catch {
      return undefined;
    }
  }

  async set<T>(inputs: CacheKeyInputs, output: T): Promise<void> {
    if (!this.enabled) return;
    await mkdir(this.dir, { recursive: true });
    const hash = hashKey(inputs);
    const entry: CacheEntry<T> = {
      hash,
      createdAt: Date.now(),
      inputs,
      output,
    };
    await writeFile(this.pathFor(hash), JSON.stringify(entry, null, 2), "utf8");
  }

  inputsFor(provider: string, model: string, opts: ProposeOptions<unknown>): CacheKeyInputs {
    return {
      provider,
      model,
      messages: opts.messages,
      schemaName: opts.schemaName,
      ...(opts.schemaDescription !== undefined
        ? { schemaDescription: opts.schemaDescription }
        : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };
  }
}

let globalCache: AiCache | undefined;

export function configureAiCache(opts: AiCacheOptions): AiCache {
  globalCache = new AiCache(opts);
  return globalCache;
}

export function getAiCache(): AiCache | undefined {
  return globalCache;
}
