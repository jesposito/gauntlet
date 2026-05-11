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
  landings: LandingPageContext[];
  totalBytes: number;
}

export interface LandingPageContext {
  url: string;
  title: string | undefined;
  metaDescription: string | undefined;
  headings: string[];
  navText: string[];
  reachable: boolean;
  statusCode?: number;
  hint?: string;
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

async function fetchLanding(url: string): Promise<LandingPageContext> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "gauntlet-init/0.0.1" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`warn: landing fetch ${url} -> ${res.status}`);
      return {
        url,
        title: undefined,
        metaDescription: undefined,
        headings: [],
        navText: [],
        reachable: false,
        statusCode: res.status,
        hint:
          res.status === 401 || res.status === 403
            ? "behind authentication (login wall)"
            : `HTTP ${res.status}`,
      };
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

    // Hint when the page looks like a login screen even though it returned 200.
    const lowerHtml = html.toLowerCase();
    const looksLikeLogin =
      /<input[^>]+type=["']password["']/i.test(html) ||
      /\b(sign\s*in|log\s*in)\b/i.test(titleMatch?.[1] ?? "") ||
      lowerHtml.includes("forgot password");
    const hint = looksLikeLogin ? "appears to require login" : undefined;

    return {
      url,
      title: titleMatch?.[1] ? stripTags(titleMatch[1]) : undefined,
      metaDescription: descMatch?.[1],
      headings,
      navText,
      reachable: true,
      statusCode: res.status,
      ...(hint ? { hint } : {}),
    };
  } catch (err) {
    console.warn(`warn: landing fetch failed: ${(err as Error).message}`);
    return {
      url,
      title: undefined,
      metaDescription: undefined,
      headings: [],
      navText: [],
      reachable: false,
      hint: (err as Error).message,
    };
  }
}

export interface ReadProjectOptions {
  cwd: string;
  url?: string;
  urls?: string[];
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

  const urls = [...(opts.urls ?? []), ...(opts.url ? [opts.url] : [])].filter(
    (u, i, a) => a.indexOf(u) === i,
  );
  const landings: LandingPageContext[] = [];
  for (const u of urls) {
    landings.push(await fetchLanding(u));
  }

  const ctx: ProjectContext = {
    cwd: opts.cwd,
    projectName: pkg?.name,
    packageDescription: pkg?.description,
    keywords: pkg?.keywords ?? [],
    frameworks: detectFrameworks(pkg),
    readmeExcerpt: readme,
    landings,
    totalBytes: 0,
  };

  const landingsBytes = landings.reduce(
    (n, l) =>
      n +
      (l.title?.length ?? 0) +
      (l.metaDescription?.length ?? 0) +
      l.headings.join("").length +
      l.navText.join("").length,
    0,
  );
  ctx.totalBytes =
    (ctx.readmeExcerpt?.length ?? 0) +
    (ctx.packageDescription?.length ?? 0) +
    landingsBytes;

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
  for (const l of ctx.landings) {
    parts.push(`\n## Landing page: ${l.url}`);
    if (l.statusCode) parts.push(`Status: ${l.statusCode}`);
    if (!l.reachable && l.hint) parts.push(`Reachable: NO - ${l.hint}`);
    else if (l.hint) parts.push(`Hint: ${l.hint}`);
    if (l.title) parts.push(`Title: ${l.title}`);
    if (l.metaDescription) parts.push(`Meta: ${l.metaDescription}`);
    if (l.headings.length > 0)
      parts.push(`Headings:\n- ${l.headings.join("\n- ")}`);
    if (l.navText.length > 0) parts.push(`Nav: ${l.navText.join(" | ")}`);
  }
  if (ctx.readmeExcerpt) {
    parts.push("\n## README excerpt");
    parts.push(ctx.readmeExcerpt);
  }
  return parts.join("\n");
}
