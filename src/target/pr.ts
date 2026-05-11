import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

interface ConfigShape {
  pr_url_template?: string;
}

async function readConfig(cwd: string): Promise<ConfigShape> {
  try {
    const raw = await readFile(join(cwd, ".gauntlet", "config.json"), "utf8");
    return JSON.parse(raw) as ConfigShape;
  } catch {
    return {};
  }
}

function runGh(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    proc.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    proc.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
    proc.on("error", () => resolve({ ok: false, stdout: "", stderr: "gh not found" }));
  });
}

interface PrInfo {
  headRefName: string;
  number: number;
  url: string;
  comments: { body: string; author?: { login: string } }[];
}

const PREVIEW_URL_PATTERNS: RegExp[] = [
  // Vercel
  /https:\/\/[a-z0-9-]+(?:-[a-z0-9]+)?-[a-z0-9-]+\.vercel\.app/gi,
  // Netlify
  /https:\/\/deploy-preview-\d+--[a-z0-9-]+\.netlify\.app/gi,
  // Render preview
  /https:\/\/[a-z0-9-]+-pr-\d+\.onrender\.com/gi,
  // Cloudflare Pages
  /https:\/\/[a-z0-9-]+\.pages\.dev/gi,
  // Generic fly preview convention
  /https:\/\/pr-\d+-[a-z0-9-]+\.fly\.dev/gi,
];

function scanCommentsForPreviewUrl(comments: PrInfo["comments"]): string | undefined {
  // Walk newest first.
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i]?.body ?? "";
    for (const re of PREVIEW_URL_PATTERNS) {
      const match = body.match(re);
      if (match && match[0]) return match[0];
    }
  }
  return undefined;
}

function applyTemplate(
  template: string,
  vars: { number: number; branch: string },
): string {
  return template
    .replace(/\{number\}/g, String(vars.number))
    .replace(/\{pr\}/g, String(vars.number))
    .replace(/\{branch\}/g, vars.branch)
    .replace(/\{ref\}/g, vars.branch);
}

export interface ResolvePrUrlResult {
  url: string;
  source: "config-template" | "comment-scan";
  prNumber: number;
  branch: string;
}

export async function resolvePrUrl(
  prArg: string,
  cwd: string = process.cwd(),
): Promise<ResolvePrUrlResult> {
  const prNum = Number(prArg);
  if (!Number.isFinite(prNum) || prNum <= 0) {
    throw new Error(`invalid --pr value: "${prArg}" (expected a PR number)`);
  }

  const gh = await runGh([
    "pr",
    "view",
    String(prNum),
    "--json",
    "headRefName,number,url,comments",
  ]);
  if (!gh.ok) {
    throw new Error(
      `gh pr view ${prNum} failed: ${gh.stderr.trim() || "non-zero exit"}\n` +
        `hint: install/auth gh, or pass --url directly.`,
    );
  }

  const info = JSON.parse(gh.stdout) as PrInfo;

  // 1. Project-level template.
  const cfg = await readConfig(cwd);
  if (cfg.pr_url_template) {
    return {
      url: applyTemplate(cfg.pr_url_template, {
        number: info.number,
        branch: info.headRefName,
      }),
      source: "config-template",
      prNumber: info.number,
      branch: info.headRefName,
    };
  }

  // 2. Scan PR comments for known preview-URL patterns.
  const scanned = scanCommentsForPreviewUrl(info.comments);
  if (scanned) {
    return {
      url: scanned,
      source: "comment-scan",
      prNumber: info.number,
      branch: info.headRefName,
    };
  }

  throw new Error(
    `could not resolve preview URL for PR #${info.number}.\n` +
      `tried: .gauntlet/config.json pr_url_template, then PR comment scan ` +
      `(vercel/netlify/render/cloudflare-pages/fly).\n` +
      `fix: add { "pr_url_template": "https://pr-{number}.preview.example.com" } to .gauntlet/config.json, or pass --url directly.`,
  );
}

// Exported for tests.
export const _internal = {
  scanCommentsForPreviewUrl,
  applyTemplate,
  PREVIEW_URL_PATTERNS,
};
