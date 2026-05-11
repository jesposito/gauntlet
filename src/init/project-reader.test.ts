import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProject, summarizeProject } from "./project-reader.ts";

const root = join(tmpdir(), `gauntlet-pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readProject", () => {
  test("returns minimal context for empty dir", async () => {
    const d = join(root, "empty");
    await mkdir(d, { recursive: true });
    const ctx = await readProject({ cwd: d });
    expect(ctx.projectName).toBeUndefined();
    expect(ctx.packageDescription).toBeUndefined();
    expect(ctx.keywords).toEqual([]);
    expect(ctx.frameworks).toEqual([]);
    expect(ctx.readmeExcerpt).toBeUndefined();
    expect(ctx.landings).toEqual([]);
  });

  test("reads package.json + detects frameworks", async () => {
    const d = join(root, "pkg");
    await mkdir(d, { recursive: true });
    await writeFile(
      join(d, "package.json"),
      JSON.stringify({
        name: "ex",
        description: "An example",
        keywords: ["a", "b"],
        dependencies: { react: "18", next: "14" },
        devDependencies: { vite: "5" },
      }),
    );
    const ctx = await readProject({ cwd: d });
    expect(ctx.projectName).toBe("ex");
    expect(ctx.packageDescription).toBe("An example");
    expect(ctx.keywords).toEqual(["a", "b"]);
    expect(ctx.frameworks.sort()).toEqual(["Next.js", "React", "Vite"]);
  });

  test("reads README.md and includes in excerpt", async () => {
    const d = join(root, "readme");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "README.md"), "# Hello\nWorld");
    const ctx = await readProject({ cwd: d });
    expect(ctx.readmeExcerpt).toContain("Hello");
    expect(ctx.totalBytes).toBeGreaterThan(0);
  });

  test("handles malformed package.json gracefully", async () => {
    const d = join(root, "bad");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "package.json"), "{ not valid");
    const ctx = await readProject({ cwd: d });
    expect(ctx.projectName).toBeUndefined();
    expect(ctx.frameworks).toEqual([]);
  });
});

describe("summarizeProject", () => {
  test("includes name, description, keywords", () => {
    const text = summarizeProject({
      cwd: "/",
      projectName: "demo",
      packageDescription: "A demo",
      keywords: ["k1"],
      frameworks: ["React"],
      readmeExcerpt: "X",
      landings: [],
      totalBytes: 5,
    });
    expect(text).toContain("demo");
    expect(text).toContain("A demo");
    expect(text).toContain("k1");
    expect(text).toContain("React");
    expect(text).toContain("X");
  });
  test("renders multiple landings with reachability + hint", () => {
    const text = summarizeProject({
      cwd: "/",
      projectName: "demo",
      packageDescription: undefined,
      keywords: [],
      frameworks: [],
      readmeExcerpt: undefined,
      landings: [
        {
          url: "https://marketing.example.com",
          title: "Welcome",
          metaDescription: undefined,
          headings: [],
          navText: [],
          reachable: true,
          statusCode: 200,
        },
        {
          url: "https://app.example.com/admin",
          title: undefined,
          metaDescription: undefined,
          headings: [],
          navText: [],
          reachable: false,
          statusCode: 401,
          hint: "behind authentication (login wall)",
        },
      ],
      totalBytes: 10,
    });
    expect(text).toContain("https://marketing.example.com");
    expect(text).toContain("https://app.example.com/admin");
    expect(text).toContain("401");
    expect(text).toContain("behind authentication");
    expect(text).toContain("Reachable: NO");
  });

  test("handles missing fields", () => {
    const text = summarizeProject({
      cwd: "/",
      projectName: undefined,
      packageDescription: undefined,
      keywords: [],
      frameworks: [],
      readmeExcerpt: undefined,
      landings: [],
      totalBytes: 0,
    });
    expect(text).toContain("(unknown)");
  });
});
