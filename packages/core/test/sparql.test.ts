import { describe, expect, it } from "vitest";
import { guardSparql, QueryRejected, toCompactTable, stripLiteralsAndComments } from "../src/sparql.js";

describe("guardSparql", () => {
  it("lässt ein einfaches SELECT durch und ergänzt LIMIT", () => {
    const guarded = guardSparql("SELECT ?x WHERE { ?x wdt:P31 wd:Q5 }");
    expect(guarded).toMatch(/LIMIT 200$/);
  });

  it("behält ein vorhandenes LIMIT", () => {
    const query = "SELECT ?x WHERE { ?x wdt:P31 wd:Q5 } LIMIT 5";
    expect(guardSparql(query)).toBe(query);
  });

  it("akzeptiert PREFIX-Deklarationen vor SELECT", () => {
    const guarded = guardSparql(
      "PREFIX wd: <http://www.wikidata.org/entity/>\nSELECT ?x WHERE { ?x wdt:P31 wd:Q5 }",
    );
    expect(guarded).toContain("SELECT");
  });

  it("erlaubt SERVICE wikibase:label", () => {
    const query =
      'SELECT ?l WHERE { wd:Q1 rdfs:label ?l SERVICE wikibase:label { bd:serviceParam wikibase:language "de". } }';
    expect(() => guardSparql(query)).not.toThrow();
  });

  it("weist fremde SERVICE-Endpunkte ab", () => {
    const query = "SELECT ?x WHERE { SERVICE <http://example.org/sparql> { ?x ?p ?o } }";
    expect(() => guardSparql(query)).toThrow(QueryRejected);
  });

  it("weist schreibende Befehle ab", () => {
    for (const evil of [
      "DELETE WHERE { ?s ?p ?o }",
      "INSERT DATA { <a> <b> <c> }",
      "SELECT ?x WHERE { ?x ?p ?o } ; DROP GRAPH <g>",
      "CLEAR ALL",
    ]) {
      expect(() => guardSparql(evil), evil).toThrow(QueryRejected);
    }
  });

  it("lässt sich nicht von Schlüsselwörtern in Literalen täuschen", () => {
    const query =
      'SELECT ?x WHERE { ?x rdfs:label "DELETE all data"@en } LIMIT 3';
    expect(() => guardSparql(query)).not.toThrow();
  });

  it("lässt sich nicht von IRI-Fragmenten täuschen", () => {
    const query =
      "SELECT ?x WHERE { ?x <http://example.org/onto#DROP> ?y } LIMIT 3";
    expect(() => guardSparql(query)).not.toThrow();
  });

  it("weist Nicht-Lese-Abfragen ab", () => {
    expect(() => guardSparql("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }")).toThrow(QueryRejected);
    expect(() => guardSparql("")).toThrow(QueryRejected);
  });

  it("setzt LIMIT vor OFFSET, wenn nur OFFSET dasteht", () => {
    const guarded = guardSparql("SELECT ?x WHERE { ?x ?p ?o } OFFSET 10");
    expect(guarded).toMatch(/LIMIT 200\s+OFFSET 10$/);
  });

  it("begrenzt die Abfragelänge", () => {
    expect(() => guardSparql(`SELECT ?x WHERE { ${"?" + "a".repeat(5000)} }`)).toThrow(QueryRejected);
  });
});

describe("stripLiteralsAndComments", () => {
  it("entfernt Kommentare und Literale", () => {
    const bare = stripLiteralsAndComments('SELECT ?x # DROP TABLE\nWHERE { ?x ?p "DROP" }');
    expect(bare).not.toContain("DROP TABLE");
    expect(bare).not.toContain('"DROP"');
  });
});

describe("toCompactTable", () => {
  it("rendert Kopfzeile und Zeilen", () => {
    const table = toCompactTable({
      vars: ["a", "b"],
      rows: [
        { a: "1", b: "2" },
        { a: "3", b: "4" },
      ],
      truncated: false,
    });
    expect(table.split("\n")).toHaveLength(3);
    expect(table).toContain("a | b");
  });

  it("kürzt lange Ergebnisse", () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({ a: String(index) }));
    const table = toCompactTable({ vars: ["a"], rows, truncated: true }, 10);
    expect(table).toContain("70 weitere Zeilen abgeschnitten");
  });

  it("meldet leere Ergebnisse", () => {
    expect(toCompactTable({ vars: [], rows: [], truncated: false })).toBe("keine Treffer");
  });
});
