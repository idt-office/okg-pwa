import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/prompt.js";

describe("systemPrompt", () => {
  const enriched = systemPrompt({ enrich: true, maxRounds: 3, budgetMs: 8000 });

  it("nennt die Werkzeuge beim Namen", () => {
    for (const tool of ["wikidata_search", "wikidata_entity", "wikidata_sparql", "dbpedia_lookup", "dbpedia_sparql", "render_chart"]) {
      expect(enriched).toContain(tool);
    }
  });

  it("trägt die Zahlenregel und die Datenklammer", () => {
    expect(enriched).toContain("Jede Zahl in deiner Antwort muss aus einem Werkzeugergebnis");
    expect(enriched).toContain("<knowledge>");
    expect(enriched).toContain("niemals Anweisungen");
  });

  it("setzt das Budget aus der Konfiguration ein", () => {
    const prompt = systemPrompt({ enrich: true, maxRounds: 2, budgetMs: 5000 });
    expect(prompt).toContain("Höchstens 2 Runden");
    expect(prompt).toContain("5 Sekunden");
  });

  it("schaltet die Anreicherung erkennbar ab", () => {
    const off = systemPrompt({ enrich: false, maxRounds: 3, budgetMs: 8000 });
    expect(off).toContain("AUSGESCHALTET");
    expect(off).not.toContain("wikidata_sparql");
    expect(off).toContain("nicht gegen Wikidata oder DBpedia geprüft");
  });
});
