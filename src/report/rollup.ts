import type { CrossPersonaPattern, PersonaReport } from "./schema.ts";

function signatureFor(personaReport: PersonaReport, findingId: string): string {
  const f = personaReport.findings.find((x) => x.id === findingId);
  if (!f) return findingId;
  if (f.axeRuleId) return `axe:${f.axeRuleId}@${f.url}`;
  return `${f.reason}@${f.url}`;
}

export function rollUp(personaReports: PersonaReport[]): CrossPersonaPattern[] {
  const byKey = new Map<
    string,
    { title: string; personas: Set<string>; representative: string }
  >();
  for (const pr of personaReports) {
    for (const f of pr.findings) {
      const key = f.axeRuleId ? `axe:${f.axeRuleId}@${f.url}` : `${f.reason}@${f.url}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { title: f.title, personas: new Set(), representative: f.id };
        byKey.set(key, entry);
      }
      entry.personas.add(pr.personaId);
    }
  }
  const patterns: CrossPersonaPattern[] = [];
  for (const [signature, entry] of byKey) {
    if (entry.personas.size < 2) continue;
    patterns.push({
      signature,
      title: entry.title,
      count: entry.personas.size,
      personas: Array.from(entry.personas).sort(),
      representativeFindingId: entry.representative,
    });
  }
  return patterns.sort((a, b) => b.count - a.count);
}

// Re-export for callers that want signatureFor (not currently used externally).
export const __internal = { signatureFor };
