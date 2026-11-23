/**
 * Wikidata und DBpedia verlangen einen aussagekräftigen User-Agent. Ohne ihn
 * antworten die SPARQL-Endpunkte mit 403 oder gar nicht.
 */
export const USER_AGENT = "okg-pwa/0.1 (IDT FH Aachen; okg-pwa@fh-aachen.de)";

export interface FetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const { timeoutMs = 20000, signal } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const request = (): Promise<Response> =>
    fetch(url, {
      signal: combined,
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
      },
    });

  let response: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await request();
      if (response.status >= 502 && response.status <= 504 && attempt === 0) {
        await backoff();
        continue;
      }
      break;
    } catch (error) {
      lastError = error;
      if (signal?.aborted || !isTransportError(error) || attempt === 1) {
        throw new Error(`Anfrage fehlgeschlagen (${url}): ${describeError(error)}`);
      }
      await backoff();
    }
  }
  if (!response) {
    throw new Error(`Anfrage fehlgeschlagen (${url}): ${describeError(lastError)}`);
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

/** Netzwerkaussetzer, keine fachlichen Fehler. */
export function isTransportError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|other side closed/i.test(
    message,
  );
}

/** Kurze Pause vor dem zweiten Versuch; ein Aussetzer braucht einen Moment. */
export function backoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1200));
}
