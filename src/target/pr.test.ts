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

  test("slugs branch names with slashes and spaces", () => {
    expect(
      applyTemplate("https://pr-{branch}.preview.example.com", {
        number: 1,
        branch: "feature/foo bar",
      }),
    ).toBe("https://pr-feature-foo-bar.preview.example.com");
  });

  test("strips characters that would corrupt the host", () => {
    // Adversarial branch trying to inject a different host. After slug,
    // the result is a long flat label - no '@' or '.' that could redirect.
    const url = applyTemplate("https://pr-{branch}.example.com", {
      number: 99,
      branch: "x@evil.com/y",
    });
    expect(url).toBe("https://pr-x-evil-com-y.example.com");
    expect(url.startsWith("https://pr-")).toBe(true);
    expect(url.endsWith(".example.com")).toBe(true);
  });

  test("caps branch slug at 63 chars (DNS label limit)", () => {
    const longBranch = "a".repeat(200);
    const url = applyTemplate("https://{branch}.preview.example.com", {
      number: 1,
      branch: longBranch,
    });
    const m = url.match(/^https:\/\/([^.]+)\.preview\.example\.com$/);
    expect(m?.[1]?.length).toBeLessThanOrEqual(63);
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
