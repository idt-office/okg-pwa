import { backoff, describeError, isTransportError, USER_AGENT } from "./http.js";

export const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
export const DBPEDIA_SPARQL = "https://dbpedia.org/sparql";

export interface SparqlResult {
  vars: string[];
  rows: Record<string, string>[];
  truncated: boolean;
  /** Das Limit, mit dem die Abfrage tatsächlich hinausging. */
  limit: number;
}

export class QueryRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryRejected";
  }
}

const UPDATE_KEYWORDS = /(?<![?$:\w])(INSERT|DELETE|CLEAR|DROP|LOAD|CREATE|ADD|MOVE|COPY|WITH)\b/i;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_QUERY_LENGTH = 4000;
const MAX_RESPONSE_BYTES = 8_000_000;

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

  // Ein umdefiniertes wikibase:-Präfix würde die SERVICE-Prüfung unten entwerten.
  // Jede Deklaration muss auf die echte Ontologie zeigen; die Anzahl muss
  // übereinstimmen, damit eine zweite Deklaration ohne Leerzeichen auffällt.
  const withoutComments = trimmed.replace(/(?:^|\s)#[^\n]*/g, " ");
  const declared = [...withoutComments.matchAll(/PREFIX\s+wikibase\s*:/gi)].length;
  const canonical = [
    ...withoutComments.matchAll(/PREFIX\s+wikibase\s*:\s*<http:\/\/wikiba\.se\/ontology#>/gi),
  ].length;
  if (declared !== canonical) {
    throw new QueryRejected("PREFIX wikibase: darf nur auf http://wikiba.se/ontology# zeigen.");
  }

  const withoutPrefixes = bare.replace(/(?:\b(?:PREFIX|BASE)\s+\S+\s*<[^>]*>\s*)+/gi, " ").trim();

  if (!/^(SELECT|ASK)\b/i.test(withoutPrefixes)) {
    throw new QueryRejected("Nur SELECT- und ASK-Abfragen sind erlaubt.");
  }
  if (UPDATE_KEYWORDS.test(withoutPrefixes)) {
    throw new QueryRejected("Schreibende SPARQL-Befehle sind nicht erlaubt.");
  }
  // Ohne Pflicht-Leerzeichen, sonst geht SERVICE<iri> durch.
  for (const match of withoutPrefixes.matchAll(/(?<![\w:])SERVICE\b\s*(?:SILENT\s*)?([^\s{]*)/gi)) {
    const service = match[1] ?? "";
    if (!/^wikibase:label$/i.test(service)) {
      throw new QueryRejected(
        `Nur SERVICE wikibase:label ist erlaubt, nicht "${service || "(leer)"}".`,
      );
    }
  }

  // Nur das abschließende LIMIT ist das äußere. Ein LIMIT in einer Subquery
  // darf den Deckel nicht ersetzen, und Literale werden nicht angefasst.
  const body = stripTrailingComments(trimmed);
  const tail = trimmed.slice(body.length);

  const trailingLimit = /(\bLIMIT\s+)(\d+)((?:\s+OFFSET\s+\d+)?)\s*$/i.exec(body);
  if (trailingLimit) {
    const value = Number.parseInt(trailingLimit[2] ?? "", 10);
    const capped = Number.isFinite(value) ? Math.min(value, MAX_LIMIT) : DEFAULT_LIMIT;
    return `${body.slice(0, trailingLimit.index)}${trailingLimit[1]}${capped}${trailingLimit[3] ?? ""}${tail}`;
  }

  // OFFSET ohne LIMIT davor: ergänzen. Steht schon eines im Text, bleibt die
  // Abfrage unangetastet, statt ein zweites LIMIT zu erzeugen. Nur ein Limit,
  // das selbst am Ende steht, deckt die Abfrage; eines in einer Subquery nicht.
  const trailingOffset = /\bOFFSET\s+\d+\s*$/i.exec(body);
  if (trailingOffset) {
    if (/\bLIMIT\s+\d+\s*$/i.test(stripLiteralsAndComments(body))) return `${body}${tail}`;
    return `${body.slice(0, trailingOffset.index)}LIMIT ${DEFAULT_LIMIT} ${body.slice(trailingOffset.index)}${tail}`;
  }
  return `${trimmed}\nLIMIT ${DEFAULT_LIMIT}`;
}

/** Schneidet abschließende Kommentare und Leerraum ab; der Rest ist die Anweisung. */
export function stripTrailingComments(query: string): string {
  // Auf einer längengetreuen Maske suchen, damit ein "#" in einem Literal oder
  // einer IRI nicht den Rest der Abfrage verschluckt.
  const masked = maskLiterals(query);
  const match = /(?:\s*#[^\n]*)*\s*$/.exec(masked);
  if (!match || match.index === undefined) return query;
  return query.slice(0, match.index);
}

function maskLiterals(query: string): string {
  return query
    .replace(/<[^>\s]*>/g, (match) => `<${"i".repeat(Math.max(0, match.length - 2))}>`)
    .replace(/"""(?:[^"\\]|\\[\s\S]|"(?!""))*"""/g, (match) => `"""${"l".repeat(Math.max(0, match.length - 6))}"""`)
    .replace(/'''(?:[^'\\]|\\[\s\S]|'(?!''))*'''/g, (match) => `'''${"l".repeat(Math.max(0, match.length - 6))}'''`)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (match) => `"${"l".repeat(Math.max(0, match.length - 2))}"`)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (match) => `'${"l".repeat(Math.max(0, match.length - 2))}'`);
}

/** Das äußere Limit, mit dem die Abfrage hinausgeht. */
export function appliedLimit(query: string): number {
  const match = /\bLIMIT\s+(\d+)\s*(?:OFFSET\s+\d+\s*)?$/i.exec(
    stripLiteralsAndComments(stripTrailingComments(query)),
  );
  const value = Number.parseInt(match?.[1] ?? "", 10);
  return Number.isFinite(value) ? value : DEFAULT_LIMIT;
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

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 50;
const CACHE_MAX_ROWS = 20_000;
const cache = new Map<string, { at: number; result: SparqlResult }>();

export async function runSparql(
  endpoint: string,
  query: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SparqlResult> {
  const guarded = guardSparql(query);
  const limit = appliedLimit(guarded);

  const cacheKey = `${endpoint}\u0000${guarded}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return {
      ...hit.result,
      rows: hit.result.rows.map((row) => ({ ...row })),
      truncated: hit.result.rows.length >= limit,
    };
  }
  const { timeoutMs = 30000, signal } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const request = (): Promise<Response> =>
    fetch(endpoint, {
      method: "POST",
      signal: combined,
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/sparql-results+json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ query: guarded }).toString(),
    });

  let response: Response | undefined;
  let lastError: unknown;
  // Nur echte Aussetzer des Servers werden wiederholt, kein 400; drei Versuche
  // mit wachsender Pause.
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      response = await request();
      if (response.status >= 502 && response.status <= 504 && attempt < attempts - 1) {
        await backoff(attempt);
        continue;
      }
      break;
    } catch (error) {
      lastError = error;
      // Ein Abbruch des Clients darf nicht wiederholt werden.
      if (signal?.aborted || !isTransportError(error) || attempt === attempts - 1) {
        throw new Error(`SPARQL-Anfrage fehlgeschlagen: ${describeError(error)}`);
      }
      await backoff(attempt);
    }
  }
  if (!response) {
    throw new Error(`SPARQL-Anfrage fehlgeschlagen: ${describeError(lastError)}`);
  }

  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error(`SPARQL-Antwort ist zu groß (${declaredLength} Bytes).`);
  }

  const body = await readCapped(response, MAX_RESPONSE_BYTES);
  if (!response.ok) {
    throw new Error(`SPARQL-Fehler ${response.status}: ${cleanEndpointError(body)}`);
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

  const result: SparqlResult = { vars, rows, truncated: rows.length >= limit, limit };
  // Zu grosse Ergebnisse werden nicht zwischengespeichert, sonst sprengt ein
  // einzelner Treffer die Zeilengrenze.
  if (rows.length <= CACHE_MAX_ROWS) {
    while (cache.size >= CACHE_MAX || cachedRows() + rows.length > CACHE_MAX_ROWS) {
      const oldest = [...cache.entries()].sort((left, right) => left[1].at - right[1].at)[0];
      if (!oldest) break;
      cache.delete(oldest[0]);
    }
    cache.set(cacheKey, { at: Date.now(), result });
  }
  // Der Cache und der Aufrufer teilen keine Arrays.
  return { ...result, rows: result.rows.map((row) => ({ ...row })) };
}

function cachedRows(): number {
  let total = 0;
  for (const entry of cache.values()) total += entry.result.rows.length;
  return total;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`SPARQL-Antwort ist größer als ${maxBytes} Bytes.`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * WDQS stellt dem Rumpf `SPARQL-QUERY: queryStr=...` voran. Wer den Rumpf
 * einfach abschneidet, verliert die eigentliche Ursache und das Modell rät.
 */
export function cleanEndpointError(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const stripped = flat.replace(/^SPARQL-QUERY:.*?(?=(?:java\.|org\.|com\.|Caused by|Exception|Error|HttpException|Virtuoso|SR\d))/, "");
  const marker = /(?:java\.|org\.|com\.|Caused by|Exception|Error|HttpException|Virtuoso|SR\d)/.exec(stripped);
  const tail = marker ? stripped.slice(marker.index) : stripped;
  return tail.slice(0, 300);
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
