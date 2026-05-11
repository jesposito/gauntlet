import { describe, expect, test } from "bun:test";
import { _internal } from "./pr.ts";

const { scanCommentsForPreviewUrl, applyTemplate } = _internal;

describe("applyTemplate", () => {
  test("substitutes {number} and {branch}", () => {
    expect(
      applyTemplate("https://pr-{number}-{branch}.preview.example.com", {
        number: 42,
        branch: "feat-x",
      }),
    ).toBe("https://pr-42-feat-x.preview.example.com");
  });

  test("supports {pr} and {ref} aliases", () => {
    expect(
      applyTemplate("https://{ref}--pr-{pr}.example.com", {
        number: 7,
        branch: "main",
      }),
    ).toBe("https://main--pr-7.example.com");
  });
});

describe("scanCommentsForPreviewUrl", () => {
  test("finds Vercel preview URL", () => {
    const url = scanCommentsForPreviewUrl([
      { body: "Build started" },
      { body: "Preview: https://my-app-abc123-vercel.vercel.app deployed." },
    ]);
    expect(url).toBe("https://my-app-abc123-vercel.vercel.app");
  });

  test("finds Netlify deploy preview URL", () => {
    const url = scanCommentsForPreviewUrl([
      { body: "Deploy preview ready! https://deploy-preview-42--my-site.netlify.app" },
    ]);
    expect(url).toBe("https://deploy-preview-42--my-site.netlify.app");
  });

  test("returns the newest match when multiple comments have URLs", () => {
    const url = scanCommentsForPreviewUrl([
      { body: "old https://old-app-abc-old.vercel.app" },
      { body: "new https://new-app-xyz-new.vercel.app" },
    ]);
    expect(url).toBe("https://new-app-xyz-new.vercel.app");
  });

  test("returns undefined when no match", () => {
    const url = scanCommentsForPreviewUrl([{ body: "no link here" }]);
    expect(url).toBeUndefined();
  });
});
