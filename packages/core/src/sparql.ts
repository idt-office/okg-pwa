import { describeError, USER_AGENT } from "./http.js";

export const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
export const DBPEDIA_SPARQL = "https://dbpedia.org/sparql";

export interface SparqlResult {
  vars: string[];
  rows: Record<string, string>[];
  truncated: boolean;
}

export class QueryRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryRejected";
  }
}

const UPDATE_KEYWORDS = /\b(INSERT|DELETE|CLEAR|DROP|LOAD|CREATE|ADD|MOVE|COPY|WITH)\b/i;
const DEFAULT_LIMIT = 200;
const MAX_QUERY_LENGTH = 4000;

/**
 * Erlaubt nur lesende Abfragen. Der Agent darf SPARQL selbst schreiben, weil
 * Aggregationen (Rankings, Zeitreihen) sich nicht in feste Werkzeuge pressen
 * lassen; die Alternative wäre, dem Modell jede Frage zu verbieten, die nicht
 * vorhergesehen wurde.
 */
export function guardSparql(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new QueryRejected("Die Abfrage ist leer.");
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new QueryRejected(`Die Abfrage ist länger als ${MAX_QUERY_LENGTH} Zeichen.`);
  }

  const bare = stripLiteralsAndComments(trimmed);
  const withoutPrefixes = bare.replace(/(?:\b(?:PREFIX|BASE)\s+\S+\s*<[^>]*>\s*)+/gi, " ").trim();

  if (!/^(SELECT|ASK)\b/i.test(withoutPrefixes)) {
    throw new QueryRejected("Nur SELECT- und ASK-Abfragen sind erlaubt.");
  }
  if (UPDATE_KEYWORDS.test(withoutPrefixes)) {
    throw new QueryRejected("Schreibende SPARQL-Befehle sind nicht erlaubt.");
  }
  for (const match of withoutPrefixes.matchAll(/\bSERVICE\s+([^\s{]+)/gi)) {
    const service = match[1] ?? "";
    if (!/^wikibase:label$/i.test(service)) {
      throw new QueryRejected(`Nur SERVICE wikibase:label ist erlaubt, nicht ${service}.`);
    }
  }

  if (!/\bLIMIT\s+\d+/i.test(withoutPrefixes)) {
    const offset = withoutPrefixes.search(/\bOFFSET\s+\d+/i);
    if (offset >= 0) {
      return `${trimmed.slice(0, offset)}LIMIT ${DEFAULT_LIMIT} ${trimmed.slice(offset)}`.trim();
    }
    return `${trimmed}\nLIMIT ${DEFAULT_LIMIT}`;
  }
  return trimmed;
}

/**
 * Entfernt IRIs, Literale und Kommentare, damit Schlüsselwörter in Strings oder
 * Fragment-IDs (`...#foo`) nicht als Befehl durchgehen.
 */
export function stripLiteralsAndComments(query: string): string {
  return query
    .replace(/<[^>\s]*>/g, "<iri>")
    .replace(/"""(?:[^"\\]|\\[\s\S]|"(?!""))*"""/g, '""')
    .replace(/'''(?:[^'\\]|\\[\s\S]|'(?!''))*'''/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/#[^\n]*/g, "");
}

export async function runSparql(
  endpoint: string,
  query: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SparqlResult> {
  const guarded = guardSparql(query);
  const { timeoutMs = 30000, signal } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      signal: combined,
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/sparql-results+json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ query: guarded }).toString(),
    });
  } catch (error) {
    throw new Error(`SPARQL-Anfrage fehlgeschlagen: ${describeError(error)}`);
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `SPARQL-Fehler ${response.status}: ${body.slice(0, 300).replace(/\s+/g, " ")}`,
    );
  }

  let parsed: SparqlBindingResponse;
  try {
    parsed = JSON.parse(body) as SparqlBindingResponse;
  } catch {
    throw new Error(`SPARQL-Antwort ist kein JSON: ${body.slice(0, 200)}`);
  }

  const vars = parsed.head?.vars ?? [];
  const bindings = parsed.results?.bindings ?? [];
  const rows = bindings.map((binding) => {
    const row: Record<string, string> = {};
    for (const [key, value] of Object.entries(binding)) {
      row[key] = value.value;
    }
    return row;
  });

  return { vars, rows, truncated: rows.length >= DEFAULT_LIMIT };
}

interface SparqlBindingResponse {
  head?: { vars?: string[] };
  results?: { bindings?: Record<string, { value: string }>[] };
}

/** Kompakte Textform für den Prompt: Kopfzeile plus Zeilen, harte Obergrenze. */
export function toCompactTable(result: SparqlResult, maxRows = 60): string {
  if (result.rows.length === 0) return "keine Treffer";
  const vars = result.vars.length > 0 ? result.vars : Object.keys(result.rows[0] ?? {});
  const lines = [vars.join(" | ")];
  for (const row of result.rows.slice(0, maxRows)) {
    lines.push(vars.map((name) => row[name] ?? "").join(" | "));
  }
  if (result.rows.length > maxRows) {
    lines.push(`... ${result.rows.length - maxRows} weitere Zeilen abgeschnitten`);
  }
  return lines.join("\n");
}
