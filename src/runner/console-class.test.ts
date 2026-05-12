import { describe, expect, test } from "bun:test";
import { classifyConsoleMessage } from "./console-class.ts";

describe("classifyConsoleMessage — CSP", () => {
  test("CSP violation with explicit directive name", () => {
    const r = classifyConsoleMessage(
      "Refused to load the font 'https://fonts.gstatic.com/x' because it violates the following Content Security Policy directive: \"font-src 'self'\".",
    );
    expect(r.class).toBe("csp_violation");
    expect(r.cspDirective).toBe("font-src");
    expect(r.label).toBe("CSP font-src");
  });

  test("CSP connect-src violation", () => {
    const r = classifyConsoleMessage(
      "Refused to connect to 'https://fonts.googleapis.com/css' because it violates the following Content Security Policy directive: \"connect-src 'self'\".",
    );
    expect(r.cspDirective).toBe("connect-src");
  });

  test("ERR_BLOCKED_BY_CSP catchall", () => {
    const r = classifyConsoleMessage(
      "Failed to load resource: net::ERR_BLOCKED_BY_CSP",
    );
    expect(r.class).toBe("csp_violation");
  });
});

describe("classifyConsoleMessage — extensions / ad blockers", () => {
  test("chrome-extension URL is extension_blocked", () => {
    const r = classifyConsoleMessage(
      "Failed to load resource: chrome-extension://abc/script.js",
    );
    expect(r.class).toBe("extension_blocked");
  });

  test("ERR_BLOCKED_BY_CLIENT is extension_blocked", () => {
    const r = classifyConsoleMessage(
      "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT",
    );
    expect(r.class).toBe("extension_blocked");
  });
});

describe("classifyConsoleMessage — preload warnings", () => {
  test("preload not used is preload_unused", () => {
    const r = classifyConsoleMessage(
      "The resource https://x/y.woff2 was preloaded using link preload but was not used within a few seconds",
    );
    expect(r.class).toBe("preload_unused");
  });
});

describe("classifyConsoleMessage — mixed content", () => {
  test("mixed content classified", () => {
    const r = classifyConsoleMessage(
      "Mixed Content: The page at 'https://x' was loaded over HTTPS, but requested an insecure resource 'http://y'",
    );
    expect(r.class).toBe("mixed_content");
  });
});

describe("classifyConsoleMessage — cookie policy", () => {
  test("SameSite cookie rejected", () => {
    const r = classifyConsoleMessage(
      "Cookie 'sid' has been rejected because it is in a cross-site context and has SameSite=None without Secure",
    );
    expect(r.class).toBe("cookie_policy");
  });
});

describe("classifyConsoleMessage — network errors", () => {
  test("net::ERR_NAME_NOT_RESOLVED", () => {
    const r = classifyConsoleMessage(
      "Failed to load resource: net::ERR_NAME_NOT_RESOLVED",
    );
    expect(r.class).toBe("network_error");
  });

  test("5xx status string is network_error", () => {
    const r = classifyConsoleMessage(
      "Failed to load resource: the server responded with a status of 500 (Internal Server Error)",
    );
    expect(r.class).toBe("network_error");
  });
});

describe("classifyConsoleMessage — uncaught exception", () => {
  test("Uncaught TypeError", () => {
    const r = classifyConsoleMessage(
      "Uncaught TypeError: Cannot read properties of undefined (reading 'foo')",
    );
    expect(r.class).toBe("uncaught_exception");
  });

  test("ReferenceError prefix", () => {
    const r = classifyConsoleMessage(
      "ReferenceError: bar is not defined",
    );
    expect(r.class).toBe("uncaught_exception");
  });
});

describe("classifyConsoleMessage — unknown", () => {
  test("noise message returns unknown", () => {
    const r = classifyConsoleMessage("[HMR] connected");
    expect(r.class).toBe("unknown");
  });
});
