import { describe, expect, test } from "bun:test";
import { detectExternalHost } from "./external-host.ts";

describe("detectExternalHost", () => {
  test("returns external hostname for Google Fonts CSS error", () => {
    expect(
      detectExternalHost(
        "Connecting to 'https://fonts.googleapis.com/css2?family=Lora' was blocked by CSP.",
        "https://jed.facetcloud.io/admin",
      ),
    ).toBe("fonts.googleapis.com");
  });

  test("returns undefined for same-host failures", () => {
    expect(
      detectExternalHost(
        "Failed to load resource: https://jed.facetcloud.io/api/secrets",
        "https://jed.facetcloud.io/admin",
      ),
    ).toBeUndefined();
  });

  test("treats subdomain matches as same-origin family", () => {
    expect(
      detectExternalHost(
        "Failed to load https://cdn.facetcloud.io/assets/x.js",
        "https://jed.facetcloud.io/admin",
      ),
    ).toBeUndefined();
  });

  test("returns undefined when no URL in message", () => {
    expect(
      detectExternalHost("Uncaught ReferenceError: foo is not defined", "https://example.com/"),
    ).toBeUndefined();
  });

  test("returns first external host when multiple URLs are present", () => {
    expect(
      detectExternalHost(
        "Trying https://example.com/me.png then https://fonts.googleapis.com/x.css",
        "https://example.com/page",
      ),
    ).toBe("fonts.googleapis.com");
  });
});
