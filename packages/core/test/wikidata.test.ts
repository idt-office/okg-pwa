import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  entityFacts,
  formatEntityFacts,
  formatWikidataTime,
  parseWikidataYear,
  searchEntities,
} from "../src/wikidata.js";

async function fixture<T>(name: string): Promise<T> {
  const text = await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(text) as T;
}

async function stubNetwork(): Promise<void> {
  const routes: [string, unknown][] = [
    ["ids=Q339353", await fixture("wbgetentities-Q339353")],
    ["props=labels", await fixture("wbgetentities-labels")],
    ["wbsearchentities", await fixture("wbsearchentities")],
  ];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    const hit = routes.find(([pattern]) => url.includes(pattern));
    if (!hit) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(hit[1]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchEntities", () => {
  it("liest Treffer aus der aufgezeichneten Antwort", async () => {
    await stubNetwork();
    const hits = await searchEntities("Pumpspeicherkraftwerk");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toMatch(/^Q\d+$/);
    expect(hits[0]?.url).toContain("wikidata.org/wiki/Q");
  });
});

describe("entityFacts", () => {
  it("löst Labels, Verweise und Sitelinks auf", async () => {
    await stubNetwork();
    const entity = await entityFacts("Q339353");
    expect(entity.label).toBe("Pumpspeicherkraftwerk");
    expect(entity.description).toContain("Kraftwerk");
    expect(entity.sitelinks.enwiki).toBeTruthy();

    const subclass = entity.facts.find((fact) => fact.property === "P279");
    expect(subclass).toBeDefined();
    expect(subclass?.propertyLabel).toBe("Unterklasse von");
    expect(subclass?.values[0]?.value).toMatch(/^.+ \(Q\d+\)$/);
  });

  it("macht aus den Fakten lesbaren Text", async () => {
    await stubNetwork();
    const text = formatEntityFacts(await entityFacts("Q339353"));
    expect(text.split("\n")[0]).toContain("Pumpspeicherkraftwerk (Q339353)");
    expect(text).toContain("Unterklasse von (P279)");
  });

  it("weist ungültige IDs ab, ohne das Netz zu berühren", async () => {
    await expect(entityFacts("Berlin")).rejects.toThrow(/keine Wikidata-ID/);
  });
});

describe("Zeitformate", () => {
  it("formatiert nach Präzision", () => {
    expect(formatWikidataTime({ time: "+1984-06-01T00:00:00Z", precision: 11 })).toBe("1984-06-01");
    expect(formatWikidataTime({ time: "+1984-06-01T00:00:00Z", precision: 10 })).toBe("1984-06");
    expect(formatWikidataTime({ time: "+1984-06-01T00:00:00Z", precision: 9 })).toBe("1984");
  });

  it("behält v. Chr. als negatives Jahr", () => {
    expect(formatWikidataTime({ time: "-0044-03-15T00:00:00Z", precision: 11 })).toBe("-0044-03-15");
    expect(parseWikidataYear("-0044-03-15T00:00:00Z")).toBe(-44);
    expect(parseWikidataYear("+1990-01-01T00:00:00Z")).toBe(1990);
  });
});
