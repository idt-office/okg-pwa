import type { ChartSpec } from "./chart.js";
import { buildChart, ChartRejected, type SparqlTable } from "./chart.js";
import { lookup, dbpediaUrlFromSitelink, truncate } from "./dbpedia.js";
import type { NumberLedger } from "./ledger.js";
import { runSparql, toCompactTable, DBPEDIA_SPARQL, WIKIDATA_SPARQL } from "./sparql.js";
import type { Source } from "./types.js";
import { describeError } from "./http.js";
import { entityFacts, fetchLabels, formatEntityFacts, searchEntities } from "./wikidata.js";

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const toolDefs: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "wikidata_search",
      description:
        "Löst einen Begriff zu Wikidata-Entitäten auf. Liefert Q-IDs mit Label und Kurzbeschreibung. Erster Schritt bei allen Namen, Orten, Anlagen, Personen.",
      parameters: {
        type: "object",
        properties: {
          term: { type: "string", description: "Suchbegriff, z. B. 'Pumpspeicherkraftwerk' oder 'Kernkraftwerk'" },
          language: { type: "string", enum: ["de", "en"], description: "Sprache der Suche, Standard de" },
        },
        required: ["term"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wikidata_entity",
      description:
        "Fakten zu einer Wikidata-Entität: Labels, Mengen mit Einheiten, Zeitangaben, Verweise. Für einzelne Objekte, nicht für Ranglisten.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Wikidata-ID, z. B. Q339353" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wikidata_ranking",
      description:
        "Rangliste einer Klasse nach einem Zahlenwert, numerisch sortiert. Deterministisch gebaut, keine eigene SPARQL-Abfrage noetig. Beispiel: class Q339353 (Pumpspeicherkraftwerk), property P2109 (Nennleistung), country Q183.",
      parameters: {
        type: "object",
        properties: {
          class: { type: "string", description: "Klasse als Q-ID, z. B. Q339353" },
          property: { type: "string", description: "Zahlenwert-Property als P-ID, z. B. P2109" },
          country: { type: "string", description: "Optionaler Staat als Q-ID, z. B. Q183" },
          limit: { type: "number", description: "1 bis 50, Standard 10" },
        },
        required: ["class", "property"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wikidata_timeline",
      description:
        "Zeitreihe: zaehlt je Jahr, wie viele Elemente einer Klasse ein Datum tragen. Beispiel: class Q134447 (Kernkraftwerk) mit P729 (Inbetriebnahme) oder P730 (Stilllegung).",
      parameters: {
        type: "object",
        properties: {
          class: { type: "string", description: "Klasse als Q-ID" },
          property: { type: "string", description: "Datums-Property als P-ID, z. B. P729" },
        },
        required: ["class", "property"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dbpedia_ranking",
      description:
        "Rangliste aus DBpedia-Infoboxen, numerisch sortiert und dedupliziert. Nur fuer Kennzahlen, die Wikidata duenn hat, vor allem BIP pro Kopf (dbp:gdpNominalPerCapita). Nicht fuer Bevoelkerung oder Flaeche: dort ist die Quelle lueckenhaft, dafuer wikidata_ranking mit P1082 oder P2046.",
      parameters: {
        type: "object",
        properties: {
          property: {
            type: "string",
            description: "Infobox-Property, z. B. dbp:gdpNominalPerCapita oder dbp:gdpPppPerCapita",
          },
          limit: { type: "number", description: "1 bis 50, Standard 10" },
        },
        required: ["property"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wikidata_sparql",
      description:
        "Eigene lesende SPARQL-Abfrage gegen query.wikidata.org für Zählungen, Ranglisten und Zeitreihen. Nur SELECT/ASK, SERVICE nur wikibase:label. P729 = Inbetriebnahme, P730 = Stilllegung, P2109 = Nennleistung, P17 = Staat.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "SPARQL-Abfrage" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dbpedia_lookup",
      description:
        "Sucht eine DBpedia-Ressource und liefert Kurzbeschreibung, Typen und die Ressourcen-URL. Einziger Weg an Abstracts, der SPARQL-Endpunkt liefert keine.",
      parameters: {
        type: "object",
        properties: {
          term: { type: "string", description: "Suchbegriff, meist der englische Artikelname" },
          maxResults: { type: "number", description: "1 bis 8, Standard 5" },
        },
        required: ["term"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dbpedia_sparql",
      description:
        "Lesende SPARQL-Abfrage gegen dbpedia.org/sparql. Für Rohzahlen aus Infoboxen: dbp:gdpNominalPerCapita, dbp:gdpPppPerCapita, dbp:gdpPppRank, dbo:populationTotal. Werte sind Strings und müssen normalisiert werden.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "SPARQL-Abfrage" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "render_chart",
      description:
        "Zeichnet ein Diagramm aus Zahlen, die in diesem Turn bereits aus einem Werkzeug kamen. Werte, die nicht belegt sind, werden abgelehnt.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["bar", "line", "table"] },
          title: { type: "string", description: "Kurzer Titel, deutsch" },
          xField: { type: "string", description: "Achsenbeschriftung x, z. B. 'Land' oder 'Jahr'" },
          yField: { type: "string", description: "Achsenbeschriftung y, z. B. 'Leistung in MW'" },
          unit: { type: "string", description: "Einheit, optional" },
          series: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                points: {
                  type: "array",
                  maxItems: 60,
                  items: {
                    type: "object",
                    properties: {
                      x: { type: ["string", "number"] },
                      y: { type: "number" },
                    },
                    required: ["x", "y"],
                  },
                },
              },
              required: ["name", "points"],
            },
          },
          note: { type: "string", description: "Ein Satz zur Datenlage, optional" },
        },
        required: ["type", "title", "xField", "yField", "series"],
        additionalProperties: false,
      },
    },
  },
];

/** Baut die Ranglisten-Abfrage. IDs werden geprueft, damit nichts eingeschleust wird. */
export function rankingQuery(
  classId: string,
  propertyId: string,
  countryId: string | undefined,
  limit: number,
): string {
  const classQ = requireId(classId, /^Q\d+$/, "class");
  const propertyP = requireId(propertyId, /^P\d+$/, "property");
  const country = countryId ? ` ; wdt:P17 wd:${requireId(countryId, /^Q\d+$/, "country")}` : "";
  return [
    `SELECT ?item ?itemLabel ?value WHERE {`,
    `  ?item wdt:P31 wd:${classQ}${country} ; wdt:${propertyP} ?value .`,
    `  SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en". }`,
    `} ORDER BY DESC(?value) LIMIT ${clamp(limit, 1, 50)}`,
  ].join("\n");
}

/** Baut die Zeitreihen-Abfrage: Ereignisse je Jahr. */
export function timelineQuery(classId: string, propertyId: string): string {
  const classQ = requireId(classId, /^Q\d+$/, "class");
  const propertyP = requireId(propertyId, /^P\d+$/, "property");
  return [
    "SELECT ?jahr (COUNT(?item) AS ?anzahl) WHERE {",
    `  ?item wdt:P31 wd:${classQ} ; wdt:${propertyP} ?datum .`,
    "  BIND(YEAR(?datum) AS ?jahr)",
    "} GROUP BY ?jahr ORDER BY ?jahr LIMIT 200",
  ].join("\n");
}

/** Baut die DBpedia-Rangliste mit numerischer Sortierung und Dedupe. */
export function dbpediaRankingQuery(property: string, limit: number): string {
  if (!/^(dbp|dbo):[A-Za-z0-9_]+$/.test(property)) {
    throw new Error("property muss die Form dbp:name oder dbo:name haben.");
  }
  return [
    `SELECT ?label (MAX(?value) AS ?wert) WHERE {`,
    `  ?item a dbo:Country ; ${property} ?raw .`,
    `  FILTER EXISTS { ?item dbo:capital ?capital }`,
    `  BIND(xsd:decimal(REPLACE(STR(?raw), ",", "")) AS ?value)`,
    `  FILTER(?value > 0)`,
    `  ?item rdfs:label ?label . FILTER(lang(?label) = "en")`,
    `} GROUP BY ?label ORDER BY DESC(?wert) LIMIT ${clamp(limit, 1, 50)}`,
  ].join("\n");
}

function requireId(value: string, pattern: RegExp, name: string): string {
  const trimmed = value.trim().toUpperCase();
  if (!pattern.test(trimmed)) throw new Error(`${name} muss die Form ${pattern.source} haben.`);
  return trimmed;
}

async function wikidataRanking(args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolResult> {
  const query = rankingQuery(
    String(args.class ?? ""),
    String(args.property ?? ""),
    args.country ? String(args.country) : undefined,
    Number(args.limit ?? 10),
  );
  return runCuratedQuery("wikidata_sparql", query, runtime, "Rangliste");
}

async function wikidataTimeline(args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolResult> {
  const query = timelineQuery(String(args.class ?? ""), String(args.property ?? ""));
  return runCuratedQuery("wikidata_sparql", query, runtime, "Zeitreihe");
}

async function dbpediaRanking(args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolResult> {
  const property = String(args.property ?? "");
  const query = dbpediaRankingQuery(property, Number(args.limit ?? 10));
  const result = await runCuratedQuery("dbpedia_sparql", query, runtime, "Rangliste");
  if (!result.ok) return result;
  // Die Quelle deckt nicht alle Staaten ab; das gehoert in die Antwort, sonst
  // liest sich eine Teilmenge wie eine vollstaendige Rangliste.
  return {
    ...result,
    content: `${result.content}\nHinweis: nur Staaten, fuer die DBpedia ${property} in der Infobox fuehrt. Fehlende Staaten bedeuten "kein Wert in der Quelle", nicht "Wert null". Fuer Bevoelkerung und Flaeche ist wikidata_ranking die bessere Quelle.`,
  };
}

async function runCuratedQuery(
  tool: "wikidata_sparql" | "dbpedia_sparql",
  query: string,
  runtime: ToolRuntime,
  label: string,
): Promise<ToolResult> {
  return tool === "wikidata_sparql"
    ? wikidataSparql({ query }, runtime, label)
    : dbpediaSparql({ query }, runtime, label);
}

/**
 * Zwei Syntaxfehler treten bei Wikidata-Abfragen immer wieder auf. Der
 * Fehlertext des Endpunkts nennt sie, sagt aber nicht, was zu tun ist.
 */
export function correctionHint(message: string, tool?: string): string | undefined {
  if (/encountered\s+"[^"]*"\s*"?service"?/i.test(message)) {
    return "Hinweis: SERVICE wikibase:label muss innerhalb der geschweiften Klammern der WHERE-Klausel stehen, nicht dahinter.";
  }
  if (/bad aggregate/i.test(message)) {
    return "Hinweis: Bei einer Zaehlung nur Gruppenvariablen und Aggregate projizieren; SERVICE wikibase:label nur fuer die Gruppenvariable, sonst steht ein Label ausserhalb des Aggregats.";
  }
  if (/\b429\b|too many requests/i.test(message)) {
    return "Hinweis: Der Endpunkt drosselt gerade. Wiederhole die Abfrage nicht sofort; antworte notfalls mit dem, was schon da ist.";
  }
  if (/fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|network|other side closed/i.test(message)) {
    // Keine Ersatzquelle empfehlen: fuer BIP pro Kopf etwa ist Wikidata P2132
    // eine Teilmenge, eine Ausweichrangliste waere nachweislich falsch.
    const source = tool?.includes("dbpedia") ? "dbpedia.org" : "query.wikidata.org";
    return `Hinweis: ${source} ist gerade nicht erreichbar; der Aufruf wurde bereits einmal wiederholt. Wenn die Frage ohne diese Quelle nicht beantwortbar ist, sage den Ausfall und liefere keine Ersatzrangliste aus einer lueckenhaften anderen Quelle.`;
  }
  if (/zeitüberschreitung|timeout|timed out/i.test(message)) {
    return tool?.includes("dbpedia")
      ? "Hinweis: Die DBpedia-Abfrage war zu langsam. Weniger Zeilen, konkrete Property, kein ORDER BY ueber alle Staaten."
      : "Hinweis: Die Abfrage war zu langsam. Nimm eine konkrete Klasse ohne tiefe P279*-Pfade, filtere frueher und setze ein kleineres LIMIT.";
  }
  return undefined;
}

export interface ToolRuntime {
  ledger: NumberLedger;
  sources: Source[];
  charts: ChartSpec[];
  deadline: number;
  signal?: AbortSignal;
  /** Alle Tabellen des Turns; die Rückfallebene nimmt die letzte zeichenbare. */
  tables?: SparqlTable[];
}

export interface ToolResult {
  content: string;
  ok: boolean;
  chart?: ChartSpec;
}

export function knowledgeBlock(source: string, body: string): string {
  // Fremdtext darf die Klammer nicht schliessen: sonst stuende danach eine
  // Anweisung ausserhalb des Datenblocks.
  return `<knowledge source="${source}">\n${maskToolTags(body)}\n</knowledge>`;
}

/** Maskiert beide Klammer-Tags, damit keine Sorte die andere aufbrechen kann. */
export function maskToolTags(body: string): string {
  return body.replace(/<(\/?)(knowledge|tool-error)([^>]*)>/gi, "&lt;$1$2$3&gt;");
}

/**
 * Fehlermeldungen sind keine Wissensgraph-Daten. Sie bekommen ein eigenes Tag,
 * damit `<knowledge>` weiterhin nur bedeutet: Inhalt ist Datum, keine Anweisung.
 */
export function toolError(body: string): string {
  return `<tool-error>\n${maskToolTags(body)}\n</tool-error>`;
}

/** Frist und Client-Abbruch kombiniert, damit kein Werkzeug weiterlaeuft. */
function toolSignal(runtime: ToolRuntime, capMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(toolTimeout(runtime, capMs));
  return runtime.signal ? AbortSignal.any([runtime.signal, timeout]) : timeout;
}

export async function executeTool(
  name: string,
  rawArgs: unknown,
  runtime: ToolRuntime,
): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "wikidata_search":
        return await wikidataSearch(args, runtime);
      case "wikidata_entity":
        return await wikidataEntity(args, runtime);
      case "wikidata_ranking":
        return await wikidataRanking(args, runtime);
      case "wikidata_timeline":
        return await wikidataTimeline(args, runtime);
      case "dbpedia_ranking":
        return await dbpediaRanking(args, runtime);
      case "wikidata_sparql":
        return await wikidataSparql(args, runtime);
      case "dbpedia_lookup":
        return await dbpediaLookup(args, runtime);
      case "dbpedia_sparql":
        return await dbpediaSparql(args, runtime);
      case "render_chart":
        return renderChart(args, runtime);
      default:
        return { content: toolError(`Unbekanntes Werkzeug: ${name}`), ok: false };
    }
  } catch (error) {
    const message = describeError(error);
    const hint = correctionHint(message, name);
    return { content: toolError(`Fehler: ${message}${hint ? `\n${hint}` : ""}`), ok: false };
  }
}

function budgetLeft(runtime: ToolRuntime): number {
  return runtime.deadline - Date.now();
}

function toolTimeout(runtime: ToolRuntime, capMs: number): number {
  // Ein Restbudget bleibt immer stehen, damit nach einem langsamen Aufruf noch
  // eine Runde fuer Diagramm und Antwort moeglich ist.
  const reserve = 2500;
  return Math.max(1500, Math.min(capMs, budgetLeft(runtime) - reserve));
}

function addSource(runtime: ToolRuntime, source: Source): void {
  const existing = runtime.sources.find(
    (entry) => entry.kg === source.kg && entry.id === source.id,
  );
  if (!existing) runtime.sources.push(source);
}

async function wikidataSearch(args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolResult> {
  const term = String(args.term ?? "").trim();
  if (!term) return { content: toolError("Fehler: term fehlt."), ok: false };
  const language = args.language === "en" ? "en" : "de";
  const hits = await searchEntities(term, {
    language,
    limit: 8,
    signal: toolSignal(runtime, 15000),
  });
  if (hits.length === 0) {
    return { content: knowledgeBlock("wikidata", `keine Treffer für "${term}"`), ok: true };
  }
  for (const hit of hits) {
    addSource(runtime, {
      kg: "wikidata",
      kind: "entity",
      id: hit.id,
      label: hit.label,
      url: hit.url,
    });
  }
  const body = hits
    .map((hit) =>
      [
        hit.id,
        hit.label,
        hit.description ?? "",
        hit.context && hit.context.length > 0 ? `ist: ${hit.context.join(", ")}` : "",
      ]
        .join("\t")
        .trimEnd(),
    )
    .join("\n");
  runtime.ledger.addFrom(body);
  return {
    content: knowledgeBlock(
      "wikidata",
      `Treffer für "${term}" (id\tlabel\tbeschreibung\tkontext)\n${body}`,
    ),
    ok: true,
  };
}

async function wikidataEntity(args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolResult> {
  const id = String(args.id ?? "").trim().toUpperCase();
  const entity = await entityFacts(id, toolSignal(runtime, 20000));
  addSource(runtime, {
    kg: "wikidata",
    kind: "entity",
    id: entity.id,
    label: entity.label,
    url: entity.url,
  });
  const text = formatEntityFacts(entity);
  runtime.ledger.addFrom(text);
  const dbpedia = entity.sitelinks.enwiki
    ? `\nDBpedia-Ressource: ${dbpediaUrlFromSitelink(entity.sitelinks.enwiki)}`
    : "";
  return { content: knowledgeBlock("wikidata", `${text}${dbpedia}`), ok: true };
}

async function wikidataSparql(
  args: Record<string, unknown>,
  runtime: ToolRuntime,
  label?: string,
): Promise<ToolResult> {
  const query = String(args.query ?? "");
  const result = await runSparql(WIKIDATA_SPARQL, query, {
    timeoutMs: toolTimeout(runtime, 14000),
    signal: runtime.signal,
  });
  const table = toCompactTable(result);
  const labelMap = await safeBackfillLabels(result.rows, runtime);
  runtime.tables = [
    ...(runtime.tables ?? []),
    {
      vars: result.vars,
      rows: result.rows,
      source: "wikidata_sparql",
      labels: labelMap ? Object.fromEntries(labelMap) : undefined,
    },
  ];
  const labels = labelMap
    ? [...labelMap.entries()].map(([id, label]) => `${label} (${id})`).join("\n")
    : undefined;
  const body = labels ? `${table}\nLabels:\n${labels}` : table;
  // Der Ledger bekommt das volle Ergebnis, der Prompt nur die gekuerzte Tabelle.
  runtime.ledger.addFrom(result.rows);
  runtime.ledger.addFrom(labels ?? "");
  addSource(runtime, {
    kg: "wikidata",
    kind: "query",
    id: `wikidata-sparql:${hash(query)}`,
    label: `${label ?? "Abfrage"}: ${truncate(query.replace(/\s+/g, " ").trim(), 70)}`,
    url: "https://query.wikidata.org/",
    query,
  });
  const note = result.truncated ? " (Ergebnis am LIMIT abgeschnitten)" : "";
  return { content: knowledgeBlock("wikidata", `SPARQL-Ergebnis${note}\n${body}`), ok: true };
}

async function safeBackfillLabels(
  rows: Record<string, string>[],
  runtime: ToolRuntime,
): Promise<Map<string, string> | undefined> {
  try {
    return await backfillEntityLabels(rows, runtime);
  } catch {
    // Labels sind eine Zugabe; ohne sie bleibt die Tabelle gültig.
    return undefined;
  }
}

/**
 * Eigene Abfragen liefern oft nur Q-IDs. Statt darauf zu hoffen, dass das Modell
 * SERVICE wikibase:label mitschreibt, lösen wir die IDs hier nach und hängen die
 * Namen an. Das Ergebnis bleibt Wahrheit aus dem Graphen, nur lesbarer.
 */
async function backfillEntityLabels(
  rows: Record<string, string>[],
  runtime: ToolRuntime,
): Promise<Map<string, string> | undefined> {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const value of Object.values(row)) {
      const match = /(?:^|\/)([QP]\d+)$/.exec(value);
      if (match?.[1]) ids.add(match[1]);
    }
  }
  if (ids.size === 0) return undefined;
  const wanted = [...ids].filter((id) => id.startsWith("Q")).slice(0, 40);
  if (wanted.length === 0) return undefined;
  // Ohne Restbudget keine Label-Runde: sonst ueberholt der Lauf seine Obergrenze.
  const left = budgetLeft(runtime);
  if (left < 800) return undefined;
  const labels = await fetchLabels(wanted, toolSignal(runtime, left));
  return labels.size === 0 ? undefined : labels;
}

function hash(text: string): string {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) {
    value = ((value * 33) ^ text.charCodeAt(index)) >>> 0;
  }
  return value.toString(36);
}

async function dbpediaLookup(args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolResult> {
  const term = String(args.term ?? "").trim();
  if (!term) return { content: toolError("Fehler: term fehlt."), ok: false };
  const maxResults = clamp(Number(args.maxResults ?? 5), 1, 8);
  const hits = await lookup(term, {
    maxResults,
    signal: toolSignal(runtime, 15000),
  });
  if (hits.length === 0) {
    return { content: knowledgeBlock("dbpedia", `keine Treffer für "${term}"`), ok: true };
  }
  for (const hit of hits) {
    addSource(runtime, {
      kg: "dbpedia",
      kind: "lookup",
      id: hit.resource || hit.label,
      label: hit.label || hit.resource,
      url: hit.url,
    });
  }
  const body = hits
    .map((hit) =>
      [hit.label, hit.types.join(", "), hit.comment ?? "", hit.url].filter(Boolean).join(" | "),
    )
    .join("\n");
  runtime.ledger.addFrom(body);
  return { content: knowledgeBlock("dbpedia", `Treffer für "${term}"\n${body}`), ok: true };
}

async function dbpediaSparql(
  args: Record<string, unknown>,
  runtime: ToolRuntime,
  label?: string,
): Promise<ToolResult> {
  const query = String(args.query ?? "");
  const result = await runSparql(DBPEDIA_SPARQL, query, {
    timeoutMs: toolTimeout(runtime, 20000),
    signal: runtime.signal,
  });
  const table = toCompactTable(result);
  runtime.tables = [...(runtime.tables ?? []), { vars: result.vars, rows: result.rows, source: "dbpedia_sparql" }];
  runtime.ledger.addFrom(result.rows);
  addSource(runtime, {
    kg: "dbpedia",
    kind: "query",
    id: `dbpedia-sparql:${hash(query)}`,
    label: `${label ?? "Abfrage"}: ${truncate(query.replace(/\s+/g, " ").trim(), 70)}`,
    url: "https://dbpedia.org/sparql",
    query,
  });
  return { content: knowledgeBlock("dbpedia", `SPARQL-Ergebnis\n${table}`), ok: true };
}

function renderChart(args: Record<string, unknown>, runtime: ToolRuntime): ToolResult {
  try {
    const spec = buildChart(args, runtime.ledger);
    if (runtime.charts.length > 0) {
      return { content: toolError("Chart abgelehnt: pro Antwort ist nur ein Diagramm erlaubt."), ok: false };
    }
    runtime.charts.push(spec);
    const points = spec.series.reduce((sum, series) => sum + series.points.length, 0);
    return {
      content: `Diagramm angenommen: ${spec.title} (${spec.type}), ${points} Datenpunkte.`,
      ok: true,
      chart: spec,
    };
  } catch (error) {
    if (error instanceof ChartRejected) {
      return { content: toolError(`Chart abgelehnt: ${error.message}`), ok: false };
    }
    throw error;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
