import {
  type AiProvider,
  type ProposeOptions,
  type ProviderFactory,
  extractJsonBlock,
  registerProvider,
} from "./provider.ts";

interface OllamaResponse {
  message?: { content?: string };
  error?: string;
}

class OllamaProvider implements AiProvider {
  readonly name = "ollama";
  readonly model: string;
  private readonly host: string;

  constructor(model: string) {
    this.model = model.replace(/^ollama\//, "");
    this.host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  }

  async propose<T>(opts: ProposeOptions<T>): Promise<T> {
    const messages = opts.messages.map((m) => ({ role: m.role, content: m.content }));
    const last = messages[messages.length - 1];
    if (last) {
      last.content = `${last.content}\n\nReturn ONLY JSON matching "${opts.schemaName}". ${opts.schemaDescription ?? ""}`.trim();
    }
    const res = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        format: "json",
        options: { temperature: opts.temperature ?? 0.7 },
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as OllamaResponse;
    if (json.error) throw new Error(`ollama: ${json.error}`);
    const text = json.message?.content ?? "";
    const parsed = JSON.parse(extractJsonBlock(text));
    const result = opts.schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `ollama schema fail "${opts.schemaName}":\n${result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`,
      );
    }
    return result.data;
  }
}

export const ollamaFactory: ProviderFactory = {
  id: "ollama",
  modelPrefixes: ["ollama/", "llama", "qwen", "mistral", "deepseek"],
  create: (model: string) => new OllamaProvider(model),
};

registerProvider(ollamaFactory);
