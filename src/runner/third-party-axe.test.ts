import { describe, expect, test } from "bun:test";
import { classifyAxeNode, classifyAxeViolation } from "./third-party-axe.ts";

describe("classifyAxeNode", () => {
  test("frame-pierced target (array with >=2 entries) is third-party", () => {
    const v = classifyAxeNode({
      target: ["iframe[src*='youtube.com']", "#movie_player"],
      html: "<div id='movie_player'></div>",
    });
    expect(v.thirdParty).toBe(true);
    expect(v.reason).toBe("both"); // youtube prefix also fires
  });

  test("plain frame-pierce with no known prefix still flagged", () => {
    const v = classifyAxeNode({
      target: ["iframe.embed", "button.unknown"],
      html: "<button class='unknown'></button>",
    });
    expect(v.thirdParty).toBe(true);
    expect(v.reason).toBe("frame-pierce");
    expect(v.source).toBe("iframe");
  });

  test("class-prefix match alone is enough (no frame-pierce)", () => {
    const v = classifyAxeNode({
      target: [".cf-turnstile-input"],
      html: "<div class='cf-turnstile-foo'></div>",
    });
    expect(v.thirdParty).toBe(true);
    expect(v.reason).toBe("prefix-match");
    expect(v.source).toBe("cloudflare-turnstile");
  });

  test("YouTube-specific patterns detected", () => {
    const v = classifyAxeNode({
      target: ["iframe", ".ytmVideoInfoChannelAvatar"],
      html: "<button class='ytmVideoInfoChannelAvatar'></button>",
    });
    expect(v.thirdParty).toBe(true);
    expect(v.source).toBe("youtube");
  });

  test("Stripe Elements detected", () => {
    const v = classifyAxeNode({
      html: "<div class='__PrivateStripeElement'></div>",
      target: [".__PrivateStripeElement"],
    });
    expect(v.thirdParty).toBe(true);
    expect(v.source).toBe("stripe-elements");
  });

  test("ordinary host-owned button is NOT third-party", () => {
    const v = classifyAxeNode({
      target: ["button.cta-primary"],
      html: "<button class='cta-primary'>Sign up</button>",
    });
    expect(v.thirdParty).toBe(false);
  });

  test("handles missing target gracefully", () => {
    const v = classifyAxeNode({ html: "<div/>" });
    expect(v.thirdParty).toBe(false);
  });
});

describe("classifyAxeViolation", () => {
  test("all nodes third-party => allThirdParty + majority", () => {
    const v = classifyAxeViolation([
      { target: ["iframe", "#movie_player"], html: "<div id='movie_player'/>" },
      { target: ["iframe", "#movie_player"], html: "<div id='movie_player'/>" },
      { target: ["iframe", "#movie_player"], html: "<div id='movie_player'/>" },
    ]);
    expect(v.allThirdParty).toBe(true);
    expect(v.thirdPartyMajority).toBe(true);
    expect(v.thirdPartyCount).toBe(3);
    expect(v.totalCount).toBe(3);
    expect(v.source).toBe("youtube");
  });

  test("majority third-party => majority but not all", () => {
    const v = classifyAxeViolation([
      { target: ["iframe", "#x"], html: "<div id='movie_player'/>" }, // youtube
      { target: ["iframe", "#x"], html: "<div id='movie_player'/>" }, // youtube
      { target: ["button.cta"], html: "<button class='cta'/>" }, // host
    ]);
    expect(v.thirdPartyMajority).toBe(true);
    expect(v.allThirdParty).toBe(false);
    expect(v.thirdPartyCount).toBe(2);
  });

  test("minority third-party => not flagged", () => {
    const v = classifyAxeViolation([
      { target: ["iframe", "#x"], html: "<div id='movie_player'/>" },
      { target: ["button.cta-1"], html: "<button/>" },
      { target: ["button.cta-2"], html: "<button/>" },
    ]);
    expect(v.thirdPartyMajority).toBe(false);
    expect(v.allThirdParty).toBe(false);
  });

  test("empty nodes returns 0/0", () => {
    const v = classifyAxeViolation([]);
    expect(v.thirdPartyMajority).toBe(false);
    expect(v.totalCount).toBe(0);
  });
});
