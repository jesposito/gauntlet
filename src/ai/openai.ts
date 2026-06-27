import {
  type AiProvider,
  type ProposeOptions,
  type ProviderFactory,
  extractJsonBlock,
  registerProvider,
} from "./provider.ts";

const DEFAULT_API_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Resolve the chat-completions endpoint. Defaults to OpenAI; OPENAI_BASE_URL
 * points gauntlet at any OpenAI-compatible endpoint (Sakana, OpenRouter,
 * Together, Groq, a local vLLM, ...). The base is expected to end at the API
 * root (e.g. https://api.sakana.ai/v1); "/chat/completions" is appended unless
 * it is already present.
 */
export function resolveOpenAiUrl(baseUrl = process.env.OPENAI_BASE_URL): string {
  if (!baseUrl) return DEFAULT_API_URL;
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message: string; type?: string };
}

class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly apiKey: string;
  private readonly apiUrl: string;

  constructor(model: string) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY not set.");
    }
    this.apiKey = apiKey;
    this.apiUrl = resolveOpenAiUrl();
    this.model = model;
  }

  async propose<T>(opts: ProposeOptions<T>): Promise<T> {
    const messages = opts.messages.map((m) => ({ role: m.role, content: m.content }));
    const last = messages[messages.length - 1];
    if (last) {
      last.content = `${last.content}\n\nReturn ONLY JSON matching the "${opts.schemaName}" schema. ${opts.schemaDescription ?? ""}`.trim();
    }

    const res = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts.temperature ?? 0.7,
        response_format: { type: "json_object" },
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as OpenAiResponse;
    if (json.error) throw new Error(`openai: ${json.error.message}`);
    const text = json.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(extractJsonBlock(text));
    const result = opts.schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `openai schema fail "${opts.schemaName}":\n${result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`,
      );
    }
    return result.data;
  }
}

export const openaiFactory: ProviderFactory = {
  id: "openai",
  modelPrefixes: ["gpt-", "o1-", "o3-"],
  // When OPENAI_BASE_URL points at an OpenAI-compatible endpoint, accept any
  // model id that no other provider claimed (e.g. a vendor's own model names).
  acceptsAsFallback: () => Boolean(process.env.OPENAI_BASE_URL),
  create: (model: string) => new OpenAiProvider(model),
};

registerProvider(openaiFactory);
