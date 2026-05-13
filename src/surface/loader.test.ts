import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAllSurfaces,
  loadAllSurfacesWithDiagnostics,
  surfacesDir,
  writeSurface,
  formatLoadError,
} from "./loader.ts";
import { SurfaceSchema } from "./schema.ts";

const VALID_SURFACE_YAML = `id: marketing
name: Marketing
audience: Visitors evaluating the product.
features:
  - pricing
  - signup
`;

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "gauntlet-surface-loader-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("loadAllSurfacesWithDiagnostics", () => {
  test("missing directory: silent (no surfaces, no diagnostics)", async () => {
    const result = await loadAllSurfacesWithDiagnostics(cwd);
    expect(result.surfaces).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  test("valid yaml loads cleanly", async () => {
    await mkdir(surfacesDir(cwd), { recursive: true });
    await writeFile(join(surfacesDir(cwd), "marketing.yaml"), VALID_SURFACE_YAML);
    const result = await loadAllSurfacesWithDiagnostics(cwd);
    expect(result.diagnostics).toEqual([]);
    expect(result.surfaces).toHaveLength(1);
    expect(result.surfaces[0]?.id).toBe("marketing");
  });

  test("broken yaml produces a diagnostic with file path and reason", async () => {
    await mkdir(surfacesDir(cwd), { recursive: true });
    const path = join(surfacesDir(cwd), "broken.yaml");
    await writeFile(path, "id: broken\n  bad indent: [unterminated");
    const result = await loadAllSurfacesWithDiagnostics(cwd);
    expect(result.surfaces).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0]!;
    expect(d.type).toBe("surface-load-error");
    expect(d.surfaceId).toBe("broken");
    expect(d.path).toBe(path);
    expect(d.reason.length).toBeGreaterThan(0);
  });

  test("schema-invalid yaml produces a diagnostic naming the bad field", async () => {
    await mkdir(surfacesDir(cwd), { recursive: true });
    // Missing required `audience`.
    const bad = `id: marketing
name: Marketing
features: []
`;
    const path = join(surfacesDir(cwd), "marketing.yaml");
    await writeFile(path, bad);
    const result = await loadAllSurfacesWithDiagnostics(cwd);
    expect(result.surfaces).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0]!;
    expect(d.surfaceId).toBe("marketing");
    expect(d.reason).toContain("schema validation failed");
    expect(d.reason).toContain("audience");
  });

  test("diagnostics do not block valid sibling surfaces from loading", async () => {
    await mkdir(surfacesDir(cwd), { recursive: true });
    await writeFile(join(surfacesDir(cwd), "good.yaml"), VALID_SURFACE_YAML);
    await writeFile(join(surfacesDir(cwd), "broken.yaml"), "::: not yaml :::");
    const result = await loadAllSurfacesWithDiagnostics(cwd);
    expect(result.surfaces).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(1);
  });

  test("legacy loadAllSurfaces returns just the surfaces (back-compat)", async () => {
    await mkdir(surfacesDir(cwd), { recursive: true });
    await writeFile(join(surfacesDir(cwd), "good.yaml"), VALID_SURFACE_YAML);
    const surfaces = await loadAllSurfaces(cwd);
    expect(surfaces).toHaveLength(1);
  });
});

describe("formatLoadError", () => {
  test("non-Zod errors fall through to .message", () => {
    expect(formatLoadError(new Error("nope"))).toBe("nope");
  });

  test("non-Error values get stringified", () => {
    expect(formatLoadError("raw string")).toBe("raw string");
  });
});

describe("writeSurface round-trip", () => {
  test("writes a file that the diagnostic loader can read back cleanly", async () => {
    const s = SurfaceSchema.parse({
      id: "app",
      name: "App",
      audience: "Logged-in users.",
      features: ["dashboard"],
    });
    await writeSurface(s, cwd);
    const result = await loadAllSurfacesWithDiagnostics(cwd);
    expect(result.diagnostics).toEqual([]);
    expect(result.surfaces).toHaveLength(1);
    expect(result.surfaces[0]?.id).toBe("app");
  });
});
