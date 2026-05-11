import type { ZodSchema } from "zod";

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

export function pickProvider(model: string): AiProvider {
  for (const f of factories) {
    if (f.modelPrefixes.some((p) => model.startsWith(p))) {
      return f.create(model);
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
