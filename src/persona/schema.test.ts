import { describe, expect, test } from "bun:test";
import { PersonaSchema, OceanSchema, BehaviorSchema } from "./schema.ts";

const minimalPersona = {
  id: "tester",
  character: { name: "Tom", context: "x", voice: "y" },
  behavior: {
    goals: ["g1"],
    device: "laptop" as const,
    viewport: { width: 1440, height: 900 },
    network: "home-wifi" as const,
    input: "mouse" as const,
    patience_threshold_seconds: 30,
  },
};

describe("PersonaSchema", () => {
  test("accepts a minimal persona", () => {
    const r = PersonaSchema.safeParse(minimalPersona);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.behavior.reading_level).toBe("9th_grade");
      expect(r.data.behavior.avoids).toEqual([]);
      expect(r.data.behavior.abandons_on).toEqual([]);
      expect(r.data.behavior.prefers).toEqual([]);
    }
  });

  test("rejects non-kebab id", () => {
    const r = PersonaSchema.safeParse({ ...minimalPersona, id: "Tom_Tester" });
    expect(r.success).toBe(false);
  });

  test("rejects empty goals", () => {
    const r = PersonaSchema.safeParse({
      ...minimalPersona,
      behavior: { ...minimalPersona.behavior, goals: [] },
    });
    expect(r.success).toBe(false);
  });

  test("accepts optional OCEAN personality", () => {
    const r = PersonaSchema.safeParse({
      ...minimalPersona,
      character: {
        ...minimalPersona.character,
        personality: { openness: 50, conscientiousness: 60, extraversion: 40, agreeableness: 70, neuroticism: 30 },
      },
    });
    expect(r.success).toBe(true);
  });
});

describe("OceanSchema", () => {
  test("requires all 5 axes 0-100", () => {
    expect(OceanSchema.safeParse({ openness: 50, conscientiousness: 60, extraversion: 40, agreeableness: 70, neuroticism: 30 }).success).toBe(true);
    expect(OceanSchema.safeParse({ openness: 50 }).success).toBe(false);
    expect(OceanSchema.safeParse({ openness: 101, conscientiousness: 60, extraversion: 40, agreeableness: 70, neuroticism: 30 }).success).toBe(false);
    expect(OceanSchema.safeParse({ openness: -1, conscientiousness: 60, extraversion: 40, agreeableness: 70, neuroticism: 30 }).success).toBe(false);
  });
});

describe("BehaviorSchema device + network", () => {
  test("device enum", () => {
    expect(BehaviorSchema.shape.device.safeParse("laptop").success).toBe(true);
    expect(BehaviorSchema.shape.device.safeParse("smartfridge").success).toBe(false);
  });
  test("network enum", () => {
    expect(BehaviorSchema.shape.network.safeParse("slow-3g").success).toBe(true);
    expect(BehaviorSchema.shape.network.safeParse("dialup").success).toBe(false);
  });
});
