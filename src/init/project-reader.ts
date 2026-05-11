import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_TOTAL_BYTES = 30_000;
const MAX_README_BYTES = 12_000;
const MAX_LANDING_BYTES = 12_000;

export interface ProjectContext {
  cwd: string;
  projectName: string | undefined;
  packageDescription: string | undefined;
  keywords: string[];
  frameworks: string[];
  readmeExcerpt: string | undefined;
  landing: LandingPageContext | undefined;
  totalBytes: number;
}

export interface LandingPageContext {
  url: string;
  title: string | undefined;
  metaDescription: string | undefined;
  headings: string[];
  navText: string[];
}

interface PackageJson {
  name?: string;
  description?: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const FRAMEWORK_HINTS: { dep: string; label: string }[] = [
  { dep: "next", label: "Next.js" },
  { dep: "react", label: "React" },
  { dep: "vue", label: "Vue" },
  { dep: "svelte", label: "Svelte" },
  { dep: "@sveltejs/kit", label: "SvelteKit" },
  { dep: "astro", label: "Astro" },
  { dep: "remix", label: "Remix" },
  { dep: "vite", label: "Vite" },
  { dep: "express", label: "Express" },
  { dep: "fastify", label: "Fastify" },
  { dep: "hono", label: "Hono" },
  { dep: "elysia", label: "Elysia" },
  { dep: "pocketbase", label: "PocketBase" },
];

async function readMaybe(path: string, max: number): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.length > max ? raw.slice(0, max) : raw;
  } catch {
    return undefined;
  }
}

function detectFrameworks(pkg: PackageJson | undefined): string[] {
  if (!pkg) return [];
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const found: string[] = [];
  for (const hint of FRAMEWORK_HINTS) {
    if (deps[hint.dep]) found.push(hint.label);
  }
  return found;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMatches(html: string, pattern: RegExp, max: number): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  while ((m = re.exec(html)) !== null && out.length < max) {
    const text = stripTags(m[1] ?? "");
    if (text) out.push(text);
  }
  return out;
}

async function fetchLanding(url: string): Promise<LandingPageContext | undefined> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "gauntlet-init/0.0.1" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`warn: landing fetch ${url} -> ${res.status}`);
      return undefined;
    }
    const raw = await res.text();
    const html = raw.length > MAX_LANDING_BYTES ? raw.slice(0, MAX_LANDING_BYTES) : raw;

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const descMatch = html.match(
      /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i,
    );
    const headings = [
      ...extractMatches(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi, 5),
      ...extractMatches(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi, 8),
    ];
    const navText = extractMatches(html, /<nav[^>]*>([\s\S]*?)<\/nav>/gi, 3).map((s) =>
      s.slice(0, 300),
    );

    return {
      url,
      title: titleMatch?.[1] ? stripTags(titleMatch[1]) : undefined,
      metaDescription: descMatch?.[1],
      headings,
      navText,
    };
  } catch (err) {
    console.warn(`warn: landing fetch failed: ${(err as Error).message}`);
    return undefined;
  }
}

export interface ReadProjectOptions {
  cwd: string;
  url?: string;
}

export async function readProject(opts: ReadProjectOptions): Promise<ProjectContext> {
  const pkgRaw = await readMaybe(join(opts.cwd, "package.json"), 20_000);
  let pkg: PackageJson | undefined;
  if (pkgRaw) {
    try {
      pkg = JSON.parse(pkgRaw) as PackageJson;
    } catch {
      pkg = undefined;
    }
  }

  const readme =
    (await readMaybe(join(opts.cwd, "README.md"), MAX_README_BYTES)) ??
    (await readMaybe(join(opts.cwd, "readme.md"), MAX_README_BYTES));

  const landing = opts.url ? await fetchLanding(opts.url) : undefined;

  const ctx: ProjectContext = {
    cwd: opts.cwd,
    projectName: pkg?.name,
    packageDescription: pkg?.description,
    keywords: pkg?.keywords ?? [],
    frameworks: detectFrameworks(pkg),
    readmeExcerpt: readme,
    landing,
    totalBytes: 0,
  };

  ctx.totalBytes =
    (ctx.readmeExcerpt?.length ?? 0) +
    (ctx.packageDescription?.length ?? 0) +
    (ctx.landing
      ? (ctx.landing.title?.length ?? 0) +
        (ctx.landing.metaDescription?.length ?? 0) +
        ctx.landing.headings.join("").length +
        ctx.landing.navText.join("").length
      : 0);

  if (ctx.totalBytes > MAX_TOTAL_BYTES && ctx.readmeExcerpt) {
    const over = ctx.totalBytes - MAX_TOTAL_BYTES;
    ctx.readmeExcerpt = ctx.readmeExcerpt.slice(
      0,
      Math.max(1000, ctx.readmeExcerpt.length - over),
    );
    ctx.totalBytes = MAX_TOTAL_BYTES;
  }

  return ctx;
}

export function summarizeProject(ctx: ProjectContext): string {
  const parts: string[] = [];
  parts.push(`# Project: ${ctx.projectName ?? "(unknown)"}`);
  if (ctx.packageDescription) parts.push(`Description: ${ctx.packageDescription}`);
  if (ctx.keywords.length > 0) parts.push(`Keywords: ${ctx.keywords.join(", ")}`);
  if (ctx.frameworks.length > 0) parts.push(`Frameworks: ${ctx.frameworks.join(", ")}`);
  if (ctx.landing) {
    parts.push("\n## Landing page");
    parts.push(`URL: ${ctx.landing.url}`);
    if (ctx.landing.title) parts.push(`Title: ${ctx.landing.title}`);
    if (ctx.landing.metaDescription)
      parts.push(`Meta: ${ctx.landing.metaDescription}`);
    if (ctx.landing.headings.length > 0)
      parts.push(`Headings:\n- ${ctx.landing.headings.join("\n- ")}`);
    if (ctx.landing.navText.length > 0)
      parts.push(`Nav: ${ctx.landing.navText.join(" | ")}`);
  }
  if (ctx.readmeExcerpt) {
    parts.push("\n## README excerpt");
    parts.push(ctx.readmeExcerpt);
  }
  return parts.join("\n");
}
