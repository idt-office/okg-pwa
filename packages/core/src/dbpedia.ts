import { fetchJson, withQuery } from "./http.js";

export const DBPEDIA_LOOKUP = "https://lookup.dbpedia.org/api/search";

export interface LookupHit {
  resource: string;
  label: string;
  comment?: string;
  types: string[];
  url: string;
}

interface LookupResponse {
  docs?: {
    resource?: string[];
    label?: string[];
    comment?: string[];
    type?: string[];
    refCount?: string[];
  }[];
}

/**
 * Die Lookup-API ist der einzige Weg an Kurzbeschreibungen: der SPARQL-Endpunkt
 * liefert kein `dbo:abstract` mehr (gemessen: ASK { ?s dbo:abstract ?a } = false).
 */
export async function lookup(
  term: string,
  options: { maxResults?: number; signal?: AbortSignal } = {},
): Promise<LookupHit[]> {
  const { maxResults = 5, signal } = options;
  const url = withQuery(DBPEDIA_LOOKUP, { query: term, format: "json", maxResults });
  const data = await fetchJson<LookupResponse>(url, { timeoutMs: 15000, signal });
  return (data.docs ?? []).map((doc) => {
    const resource = doc.resource?.[0] ?? "";
    return {
      resource,
      label: cleanText(doc.label?.[0] ?? ""),
      comment: doc.comment?.[0] ? truncate(cleanText(doc.comment[0]), 400) : undefined,
      types: (doc.type ?? []).map((type) => type.replace("http://dbpedia.org/ontology/", "")),
      url: resource,
    };
  });
}

/** Entfernt das `<B>`-Markup der Suchtreffer und HTML-Entities. */
export function cleanText(raw: string): string {
  return raw
    .replace(/<\/?B>/gi, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}...`;
}

export function dbpediaUrlFromSitelink(title: string): string {
  return `https://dbpedia.org/resource/${title.replace(/ /g, "_")}`;
}

/**
 * DBpedia-Infobox-Zahlen sind Strings ("315800.0", "1,234", "1.234,56",
 * "12,5 MW"). Ohne Normalisierung ist kein Ranking möglich.
 */
export function parseDbpediaNumber(raw: string): number | null {
  const cleaned = raw.replace(/<[^>]*>/g, "").replace(/\u00a0/g, " ").trim();
  const match = /^[^\d+-]*([+-]?\d[\d.,\s]*)/.exec(cleaned);
  if (!match?.[1]) return null;

  let token = match[1].trim().replace(/\s/g, "");
  const lastComma = token.lastIndexOf(",");
  const lastDot = token.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    token = token.split(thousandsSeparator).join("");
    if (decimalSeparator === ",") token = token.replace(",", ".");
  } else if (lastComma >= 0) {
    token = isThousandsGroup(token, ",") ? token.replace(/,/g, "") : token.replace(",", ".");
  } else if (lastDot >= 0 && isThousandsGroup(token, ".")) {
    token = token.replace(/\./g, "");
  }

  const value = Number.parseFloat(token);
  return Number.isFinite(value) ? value : null;
}

function isThousandsGroup(token: string, separator: string): boolean {
  const pattern = separator === "," ? /^\d{1,3}(,\d{3})+$/ : /^\d{1,3}(\.\d{3})+$/;
  return pattern.test(token);
}
