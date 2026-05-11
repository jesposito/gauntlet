import { z } from "zod";
import {
  type AiProvider,
  type ProposeOptions,
  type ProviderFactory,
  extractJsonBlock,
  registerProvider,
} from "./provider.ts";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

interface ContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: ContentBlock[];
  stop_reason?: string;
  error?: { type: string; message: string };
}

class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey: string;

  constructor(model: string) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY not set. Export it or pick a different --model.",
      );
    }
    this.apiKey = apiKey;
    this.model = model;
  }

  async propose<T>(opts: ProposeOptions<T>): Promise<T> {
    const system = opts.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const turns = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const schemaHint = `\n\nReturn ONLY a JSON object matching the "${opts.schemaName}" schema. No prose, no markdown fences. ${opts.schemaDescription ?? ""}`.trim();
    if (turns.length > 0) {
      const last = turns[turns.length - 1]!;
      last.content = `${last.content}${schemaHint ? `\n\n${schemaHint}` : ""}`;
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: system || undefined,
      messages: turns,
    };
    if (opts.temperature !== undefined && !/opus-4-[789]|sonnet-4-[6789]/.test(this.model)) {
      body.temperature = opts.temperature;
    }

    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`anthropic ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = (await res.json()) as AnthropicResponse;
    if (json.error) {
      throw new Error(`anthropic ${json.error.type}: ${json.error.message}`);
    }

    const text = (json.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");

    const jsonText = extractJsonBlock(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(
        `anthropic returned non-JSON: ${(err as Error).message}\n--- raw ---\n${text.slice(0, 1000)}`,
      );
    }

    const result = opts.schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `anthropic output failed schema "${opts.schemaName}":\n${result.error.issues
          .map((i: z.ZodIssue) => `  ${i.path.join(".")}: ${i.message}`)
          .join("\n")}\n--- raw ---\n${jsonText.slice(0, 1000)}`,
      );
    }
    return result.data;
  }
}

export const anthropicFactory: ProviderFactory = {
  id: "anthropic",
  modelPrefixes: ["claude-"],
  create: (model: string) => new AnthropicProvider(model),
};

registerProvider(anthropicFactory);
