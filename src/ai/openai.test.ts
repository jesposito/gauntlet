import { afterEach, describe, expect, test } from "bun:test";
import { resolveOpenAiUrl } from "./openai.ts";
import { pickProvider } from "./provider.ts";

describe("resolveOpenAiUrl", () => {
  test("defaults to OpenAI when no base url is set", () => {
    expect(resolveOpenAiUrl(undefined)).toBe("https://api.openai.com/v1/chat/completions");
  });

  test("appends /chat/completions to a base url", () => {
    expect(resolveOpenAiUrl("https://api.sakana.ai/v1")).toBe(
      "https://api.sakana.ai/v1/chat/completions",
    );
  });

  test("strips trailing slashes before appending", () => {
    expect(resolveOpenAiUrl("https://api.sakana.ai/v1/")).toBe(
      "https://api.sakana.ai/v1/chat/completions",
    );
  });

  test("does not double-append when the path is already present", () => {
    expect(resolveOpenAiUrl("https://host/v1/chat/completions")).toBe(
      "https://host/v1/chat/completions",
    );
  });
});

describe("pickProvider fallback to an OpenAI-compatible endpoint", () => {
  const savedBase = process.env.OPENAI_BASE_URL;
  const savedKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (savedBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedBase;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  });

  test("routes an arbitrary model id to openai when OPENAI_BASE_URL is set", () => {
    process.env.OPENAI_BASE_URL = "https://api.sakana.ai/v1";
    process.env.OPENAI_API_KEY = "test-key";
    const provider = pickProvider("fugu");
    expect(provider.name).toBe("openai");
    expect(provider.model).toBe("fugu");
  });

  test("still throws for an unknown model id when no base url is set", () => {
    delete process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = "test-key";
    expect(() => pickProvider("totally-unknown-model-xyz")).toThrow(/no provider for model/);
  });
});
