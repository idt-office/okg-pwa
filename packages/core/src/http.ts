/**
 * Wikidata und DBpedia verlangen einen aussagekräftigen User-Agent. Ohne ihn
 * antworten die SPARQL-Endpunkte mit 403 oder gar nicht.
 */
export const USER_AGENT = "okg-pwa/0.1 (IDT FH Aachen; okg-pwa@fh-aachen.de)";

export interface FetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const { timeoutMs = 20000, signal, headers } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {
      signal: combined,
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        ...headers,
      },
    });
  } catch (error) {
    throw new Error(`Anfrage fehlgeschlagen (${url}): ${describeError(error)}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `HTTP ${response.status} von ${url}: ${body.slice(0, 180).replace(/\s+/g, " ")}`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new Error(`Antwort von ${url} ist kein JSON: ${describeError(error)}`);
  }
}

/** Baut eine URL mit Query-Parametern und kodiert die Werte korrekt. */
export function withQuery(base: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "Zeitüberschreitung" : error.message;
  }
  return String(error);
}
