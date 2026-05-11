import {
  type AiProvider,
  type ProposeOptions,
  type ProviderFactory,
  extractJsonBlock,
  registerProvider,
} from "./provider.ts";

const API_URL = "https://api.openai.com/v1/chat/completions";

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message: string; type?: string };
}

class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly apiKey: string;

  constructor(model: string) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY not set.");
    }
    this.apiKey = apiKey;
    this.model = model;
  }

  async propose<T>(opts: ProposeOptions<T>): Promise<T> {
    const messages = opts.messages.map((m) => ({ role: m.role, content: m.content }));
    const last = messages[messages.length - 1];
    if (last) {
      last.content = `${last.content}\n\nReturn ONLY JSON matching the "${opts.schemaName}" schema. ${opts.schemaDescription ?? ""}`.trim();
    }

    const res = await fetch(API_URL, {
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
  create: (model: string) => new OpenAiProvider(model),
};

registerProvider(openaiFactory);
