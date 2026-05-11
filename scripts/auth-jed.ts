/* eslint-disable no-console */
// One-shot: log into jed.facetcloud.io as the creator, dump storageState
// into facets-sh/.gauntlet/auth/tenant-admin.json, update the surface yaml.
import { chromium } from "playwright";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const FACETS_DIR = process.argv[2] ?? "/home/jed/dev/facets-sh";
const LOGIN_URL = "https://jed.facetcloud.io/admin/login";
const POST_LOGIN_HINT = "https://jed.facetcloud.io/admin";
const EMAIL = "jed.espo@gmail.com";
const PASSWORD = process.env.JED_TENANT_PASSWORD;
if (!PASSWORD) {
  console.error("error: JED_TENANT_PASSWORD env var not set.");
  process.exit(2);
}

const AUTH_REL = ".gauntlet/auth/tenant-admin.json";
const AUTH_ABS = join(FACETS_DIR, AUTH_REL);
const SURFACE_PATH = join(FACETS_DIR, ".gauntlet/surfaces/tenant-admin.yaml");

await mkdir(dirname(AUTH_ABS), { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

console.log(`navigating: ${LOGIN_URL}`);
await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

const emailSel = 'input[type="email"], input[name="email"], input[autocomplete="email"], input[autocomplete="username"]';
const passSel = 'input[type="password"], input[name="password"]';
const submitSel = 'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")';

await page.waitForSelector(emailSel, { timeout: 15_000 });
// Wait for SPA hydration (event handlers attached) before typing.
await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
await page.waitForTimeout(500);

console.log("filling email");
await page.locator(emailSel).first().fill(EMAIL);
console.log("filling password");
const passLocator = page.locator(passSel).first();
await passLocator.fill(PASSWORD);

console.log("submitting (Enter key)");
const navPromise = page
  .waitForURL((u) => !u.toString().includes("/admin/login"), { timeout: 25_000 })
  .catch(() => undefined);
await passLocator.press("Enter");
await navPromise;

await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
console.log(`post-submit url: ${page.url()}`);

// If still on /admin/login, try clicking submit as a fallback.
if (page.url().includes("/admin/login")) {
  console.log("still on login; trying explicit submit click");
  const navPromise2 = page
    .waitForURL((u) => !u.toString().includes("/admin/login"), { timeout: 25_000 })
    .catch(() => undefined);
  await page.locator(submitSel).first().click().catch(() => undefined);
  await navPromise2;
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  console.log(`after click url: ${page.url()}`);
}

// Quick sanity: navigate to /admin to make sure session is real.
try {
  await page.goto(POST_LOGIN_HINT, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  console.log(`/admin url: ${page.url()}`);
  if (page.url().includes("/login")) {
    console.error("error: still redirecting to /login — credentials likely rejected.");
    await context.close();
    await browser.close();
    process.exit(3);
  }
} catch (err) {
  console.warn(`warn: /admin probe failed: ${(err as Error).message}`);
}

const state = await context.storageState();
await writeFile(AUTH_ABS, JSON.stringify(state, null, 2), "utf8");
console.log(`saved storageState: ${AUTH_REL}  (cookies=${state.cookies.length} origins=${state.origins.length})`);

// Update surface yaml so `gauntlet run --surface tenant-admin` picks it up.
try {
  const raw = await readFile(SURFACE_PATH, "utf8");
  const surface = parseYaml(raw) as Record<string, unknown>;
  surface.auth_state = AUTH_REL;
  if (surface.requires_auth !== true) surface.requires_auth = true;
  await writeFile(SURFACE_PATH, stringifyYaml(surface), "utf8");
  console.log(`updated surface yaml: ${SURFACE_PATH}`);
} catch (err) {
  console.warn(`warn: could not update surface yaml: ${(err as Error).message}`);
}

await context.close();
await browser.close();
console.log("\ndone. next: gauntlet run --surface tenant-admin");
