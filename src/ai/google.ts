import {
  type AiProvider,
  type ProposeOptions,
  type ProviderFactory,
  extractJsonBlock,
  registerProvider,
} from "./provider.ts";

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  error?: { message: string };
}

class GoogleProvider implements AiProvider {
  readonly name = "google";
  readonly model: string;
  private readonly apiKey: string;

  constructor(model: string) {
    const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_API_KEY (or GEMINI_API_KEY) not set.");
    this.apiKey = apiKey;
    this.model = model;
  }

  async propose<T>(opts: ProposeOptions<T>): Promise<T> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const systemText = opts.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    const last = contents[contents.length - 1];
    if (last?.parts[0]) {
      last.parts[0].text = `${last.parts[0].text}\n\nReturn ONLY JSON matching "${opts.schemaName}". ${opts.schemaDescription ?? ""}`.trim();
    }

    const body = {
      systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
      contents,
      generationConfig: {
        temperature: opts.temperature ?? 0.7,
        responseMimeType: "application/json",
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) throw new Error(`google ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as GeminiResponse;
    if (json.error) throw new Error(`google: ${json.error.message}`);
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const parsed = JSON.parse(extractJsonBlock(text));
    const result = opts.schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `google schema fail "${opts.schemaName}":\n${result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`,
      );
    }
    return result.data;
  }
}

export const googleFactory: ProviderFactory = {
  id: "google",
  modelPrefixes: ["gemini-"],
  create: (model: string) => new GoogleProvider(model),
};

registerProvider(googleFactory);
