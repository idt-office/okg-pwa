import { describe, expect, it } from "vitest";
import { cleanText, dbpediaUrlFromSitelink, parseDbpediaNumber, truncate } from "../src/dbpedia.js";

describe("parseDbpediaNumber", () => {
  it("liest einfache Dezimalstrings", () => {
    expect(parseDbpediaNumber("315800.0")).toBe(315800);
    expect(parseDbpediaNumber("141079")).toBe(141079);
  });

  it("unterscheidet Tausenderpunkt von Dezimalkomma", () => {
    expect(parseDbpediaNumber("1.234")).toBe(1234);
    expect(parseDbpediaNumber("12,5")).toBe(12.5);
    expect(parseDbpediaNumber("1.234,56")).toBe(1234.56);
    expect(parseDbpediaNumber("1,234.56")).toBe(1234.56);
  });

  it("verträgt Einheiten und Leerzeichen", () => {
    expect(parseDbpediaNumber("1 234")).toBe(1234);
    expect(parseDbpediaNumber("1060 MW")).toBe(1060);
    expect(parseDbpediaNumber("ca. 42")).toBe(42);
  });

  it("gibt null zurück, wenn nichts Numerisches dasteht", () => {
    expect(parseDbpediaNumber("k. A.")).toBeNull();
    expect(parseDbpediaNumber("")).toBeNull();
  });
});

describe("cleanText", () => {
  it("entfernt Suchmarkierung und Entities", () => {
    expect(cleanText("<B>Köln</B> Hauptbahnhof &amp; mehr")).toBe("Köln Hauptbahnhof & mehr");
  });
});

describe("truncate", () => {
  it("kürzt mit Auslassungszeichen", () => {
    const result = truncate("abcdefghij", 5);
    expect(result).toBe("abcd...");
    expect(result.length).toBeLessThanOrEqual(7);
  });
});

describe("dbpediaUrlFromSitelink", () => {
  it("baut die Ressourcen-URL aus einem Wikipedia-Titel", () => {
    expect(dbpediaUrlFromSitelink("Pumped-storage hydroelectricity")).toBe(
      "https://dbpedia.org/resource/Pumped-storage_hydroelectricity",
    );
  });
});
