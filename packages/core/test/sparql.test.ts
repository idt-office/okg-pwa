import { describe, expect, it, vi, afterEach } from "vitest";
import {
  appliedLimit,
  guardSparql,
  QueryRejected,
  runSparql,
  stripLiteralsAndComments,
  toCompactTable,
} from "../src/sparql.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("guardSparql", () => {
  it("lässt ein einfaches SELECT durch und ergänzt LIMIT", () => {
    expect(guardSparql("SELECT ?x WHERE { ?x wdt:P31 wd:Q5 }")).toMatch(/LIMIT 200$/);
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

  it("weist SERVICE ohne Leerzeichen ab", () => {
    const query = "SELECT * WHERE { SERVICE<http://127.0.0.1:1/sparql>{ ?s ?p ?o } }";
    expect(() => guardSparql(query)).toThrow(QueryRejected);
  });

  it("weist ein umdefiniertes wikibase-Präfix ab", () => {
    const query =
      "PREFIX wikibase: <http://127.0.0.1:1/sparql#>\nSELECT ?x WHERE { SERVICE wikibase:label { ?x ?y ?z } }";
    expect(() => guardSparql(query)).toThrow(/wikibase/);
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

  it("verwechselt Variablen und Präfixnamen nicht mit Befehlen", () => {
    expect(() => guardSparql("SELECT ?add WHERE { ?add ?p ?o }")).not.toThrow();
    expect(() =>
      guardSparql("PREFIX ex: <http://example.org/>\nSELECT ?x WHERE { ?x ex:drop ?o }"),
    ).not.toThrow();
  });

  it("lässt sich nicht von Schlüsselwörtern in Literalen täuschen", () => {
    expect(() =>
      guardSparql('SELECT ?x WHERE { ?x rdfs:label "DELETE all data"@en } LIMIT 3'),
    ).not.toThrow();
  });

  it("lässt sich nicht von IRI-Fragmenten täuschen", () => {
    expect(() =>
      guardSparql("SELECT ?x WHERE { ?x <http://example.org/onto#DROP> ?y } LIMIT 3"),
    ).not.toThrow();
  });

  it("weist Nicht-Lese-Abfragen ab", () => {
    expect(() => guardSparql("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }")).toThrow(QueryRejected);
    expect(() => guardSparql("")).toThrow(QueryRejected);
  });

  it("hängt LIMIT hinter OFFSET, ohne in den Text zu schneiden", () => {
    const query = "SELECT ?x WHERE { ?x ?p ?o } OFFSET 10";
    const guarded = guardSparql(query);
    expect(guarded).toBe(`${query}\nLIMIT 200`);
  });

  it("schneidet beim Anhängen keine Literale oder IRIs an", () => {
    const query =
      'SELECT ?x WHERE { ?x rdfs:label "ein ziemlich langer Text"@de ; <http://example.org/a> ?y } OFFSET 10';
    const guarded = guardSparql(query);
    expect(guarded).toContain('"ein ziemlich langer Text"@de');
    expect(guarded).toContain("<http://example.org/a>");
    expect(guarded).toMatch(/LIMIT 200$/);
  });

  it("deckelt ein zu großes LIMIT", () => {
    const guarded = guardSparql("SELECT ?x WHERE { ?x ?p ?o } LIMIT 1000000");
    expect(guarded).toMatch(/LIMIT 1000/);
  });

  it("begrenzt die Abfragelänge", () => {
    expect(() => guardSparql(`SELECT ?x WHERE { ?${"a".repeat(5000)} }`)).toThrow(QueryRejected);
  });
});

describe("appliedLimit", () => {
  it("liest das letzte LIMIT", () => {
    expect(appliedLimit("SELECT ?x WHERE { ?x ?p ?o } LIMIT 7")).toBe(7);
    expect(appliedLimit("SELECT ?x WHERE { ?x ?p ?o }")).toBe(200);
  });
});

describe("stripLiteralsAndComments", () => {
  it("entfernt Kommentare und Literale", () => {
    const bare = stripLiteralsAndComments('SELECT ?x # DROP TABLE\nWHERE { ?x ?p "DROP" }');
    expect(bare).not.toContain("DROP TABLE");
    expect(bare).not.toContain('"DROP"');
  });
});

describe("runSparql", () => {
  const endpoint = "https://example.invalid/sparql";

  it("liest Bindings in Zeilen", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          head: { vars: ["a", "b"] },
          results: { bindings: [{ a: { value: "1" }, b: { value: "x" } }] },
        }),
        { status: 200, headers: { "content-type": "application/sparql-results+json" } },
      ),
    );
    const result = await runSparql(endpoint, "SELECT ?a ?b WHERE { ?a ?p ?b }");
    expect(result.rows).toEqual([{ a: "1", b: "x" }]);
    expect(result.limit).toBe(200);
    expect(result.truncated).toBe(false);
  });

  it("meldet truncated erst am gesetzten Limit", async () => {
    const bindings = Array.from({ length: 5 }, (_, index) => ({ a: { value: String(index) } }));
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ head: { vars: ["a"] }, results: { bindings } }), { status: 200 }),
    );
    const atLimit = await runSparql(endpoint, "SELECT ?a WHERE { ?a ?p ?o } LIMIT 5");
    expect(atLimit.truncated).toBe(true);

    const belowLimit = await runSparql(endpoint, "SELECT ?a WHERE { ?a ?p ?o } LIMIT 50");
    expect(belowLimit.truncated).toBe(false);
  });

  it("wirft bei HTTP-Fehlern mit Status und Rumpf", async () => {
    vi.stubGlobal("fetch", async () => new Response("kaputt", { status: 500 }));
    await expect(runSparql(endpoint, "SELECT ?a WHERE { ?a ?p ?o }")).rejects.toThrow(/500/);
  });

  it("wirft, wenn die Antwort kein JSON ist", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 200 }));
    await expect(runSparql(endpoint, "SELECT ?a WHERE { ?a ?p ?o }")).rejects.toThrow(/kein JSON/);
  });

  it("prüft die Abfrage vor dem Netzzugriff", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });
    await expect(runSparql(endpoint, "DROP GRAPH <g>")).rejects.toThrow(QueryRejected);
    expect(called).toBe(false);
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
      limit: 200,
    });
    expect(table.split("\n")).toHaveLength(3);
    expect(table).toContain("a | b");
  });

  it("kürzt lange Ergebnisse", () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({ a: String(index) }));
    const table = toCompactTable({ vars: ["a"], rows, truncated: true, limit: 200 }, 10);
    expect(table).toContain("70 weitere Zeilen abgeschnitten");
  });

  it("meldet leere Ergebnisse", () => {
    expect(toCompactTable({ vars: [], rows: [], truncated: false, limit: 200 })).toBe(
      "keine Treffer",
    );
  });
});
