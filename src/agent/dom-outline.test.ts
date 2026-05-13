import { describe, expect, test } from "bun:test";
import { summarizeOutline, type OutlineElement } from "./dom-outline.ts";

const els: OutlineElement[] = [
  { idx: 0, role: "button", name: "Save", tag: "button", text: "Save", href: null, visible: true },
  { idx: 1, role: "link", name: "Home", tag: "a", text: "Home", href: "/home", visible: true },
  { idx: 2, role: "heading", name: "Welcome", tag: "h1", text: "Welcome", href: null, visible: true },
];

describe("summarizeOutline", () => {
  test("formats indexed entries", () => {
    const out = summarizeOutline(els);
    expect(out).toContain('[0] button "Save"');
    expect(out).toContain('[1] link "Home" href=/home');
    expect(out).toContain('[2] heading "Welcome"');
  });

  test("respects max cap", () => {
    const many: OutlineElement[] = Array.from({ length: 50 }, (_, i) => ({
      idx: i,
      role: "button",
      name: `B${i}`,
      tag: "button",
      text: "",
      href: null,
      visible: true,
    }));
    const out = summarizeOutline(many, 5);
    expect(out.split("\n")).toHaveLength(5);
    expect(out).toContain("[0]");
    expect(out).toContain("[4]");
    expect(out).not.toContain("[5]");
  });

  test("truncates long names", () => {
    const long: OutlineElement = {
      idx: 0,
      role: "button",
      name: "X".repeat(200),
      tag: "button",
      text: "",
      href: null,
      visible: true,
    };
    const out = summarizeOutline([long]);
    expect(out.length).toBeLessThan(150);
  });

  test("summary disclosure widgets render as button entries", () => {
    // <summary> elements are mapped to role="button" inside the outline
    // script so the persona judge can see "How to find X" as an interactive
    // affordance. We can't run the browser script here, but we can verify
    // summarizeOutline accepts a button-role entry sourced from <summary>
    // and renders the discoverable label.
    const summaryAsButton: OutlineElement = {
      idx: 0,
      role: "button",
      name: "How to find your library ID",
      tag: "summary",
      text: "",
      href: null,
      visible: true,
    };
    const out = summarizeOutline([summaryAsButton]);
    expect(out).toContain('[0] button "How to find your library ID"');
  });
});
