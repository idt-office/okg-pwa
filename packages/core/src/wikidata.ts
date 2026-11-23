import { fetchJson, withQuery } from "./http.js";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const ENTITY_PREFIX = "http://www.wikidata.org/entity/";
const MAX_FACTS = 80;
const MAX_VALUES_PER_FACT = 8;
const LABEL_CHUNK = 50;

export interface EntityHit {
  id: string;
  label: string;
  description?: string;
  url: string;
  /** Oberklassen aus P31/P279, damit die Auswahl nicht geraten werden muss. */
  context?: string[];
}

export interface FactValue {
  value: string;
  /** Jahresangabe aus einem Qualifier P585, falls vorhanden. */
  year?: number;
}

export interface Fact {
  property: string;
  propertyLabel: string;
  values: FactValue[];
}

export interface EntityFacts {
  id: string;
  label: string;
  description?: string;
  url: string;
  facts: Fact[];
  sitelinks: { dewiki?: string; enwiki?: string };
}

interface SearchResponse {
  search?: { id: string; label?: string; description?: string }[];
}

interface LabelResponse {
  entities?: Record<string, { labels?: Record<string, { value: string }> }>;
}

interface EntityResponse {
  entities?: Record<string, RawEntity>;
}

interface RawEntity {
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, RawStatement[]>;
  sitelinks?: Record<string, { title?: string }>;
}

interface RawStatement {
  rank?: string;
  mainsnak?: RawSnak;
  qualifiers?: Record<string, RawSnak[]>;
}

interface RawSnak {
  snaktype?: string;
  datavalue?: { value: unknown; type: string };
}

const cache = new Map<string, { at: number; value: unknown }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await load();
  if (cache.size > 400) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function wikidataUrl(qid: string): string {
  return `https://www.wikidata.org/wiki/${qid}`;
}

/**
 * Sucht nach einem Begriff. Zuerst in der angegebenen Sprache, bei null
 * Treffern zusätzlich auf Englisch, weil die Wissensgraphen überwiegend
 * englisch erschlossen sind.
 */
export async function searchEntities(
  term: string,
  options: { language?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<EntityHit[]> {
  const { language = "de", limit = 8, signal } = options;
  const primary = await searchOnce(term, language, limit, signal);
  if (primary.length > 0 || language === "en") return primary;
  return searchOnce(term, "en", limit, signal);
}

async function searchOnce(
  term: string,
  language: string,
  limit: number,
  signal?: AbortSignal,
): Promise<EntityHit[]> {
  const url = withQuery(WIKIDATA_API, {
    action: "wbsearchentities",
    search: term,
    language,
    uselang: language,
    type: "item",
    limit,
    format: "json",
    origin: "*",
  });
  const hits = await cached(`search:${language}:${limit}:${term}`, async () => {
    const data = await fetchJson<SearchResponse>(url, { timeoutMs: 15000, signal });
    return (data.search ?? []).map((hit) => ({
      id: hit.id,
      label: hit.label ?? hit.id,
      description: hit.description,
      url: wikidataUrl(hit.id),
    }));
  });
  return enrichHits(hits, signal);
}

/**
 * Ergänzt die Treffer um ihre Oberklassen. Ohne diesen Schritt rät das Modell
 * Q-IDs und landet bei "Kernenergie" statt "Kernkraftwerk" - genau der Fehler,
 * den wir im ersten Durchlauf gemessen haben.
 */
async function enrichHits(hits: EntityHit[], signal?: AbortSignal): Promise<EntityHit[]> {
  const ids = hits.slice(0, 6).map((hit) => hit.id);
  if (ids.length === 0) return hits;
  try {
    const url = withQuery(WIKIDATA_API, {
      action: "wbgetentities",
      ids: ids.join("|"),
      props: "claims",
      format: "json",
      origin: "*",
    });
    const data = await cached(`searchctx:${ids.join("|")}`, () =>
      fetchJson<EntityResponse>(url, { timeoutMs: 12000, signal }),
    );
    const parents = new Map<string, string[]>();
    const wanted = new Set<string>();
    for (const [id, entity] of Object.entries(data.entities ?? {})) {
      const list: string[] = [];
      for (const property of ["P31", "P279"]) {
        for (const statement of entity.claims?.[property] ?? []) {
          const parent = entityIdOf(statement.mainsnak);
          if (parent) list.push(parent);
        }
      }
      parents.set(id, [...new Set(list)].slice(0, 3));
      for (const parent of list) wanted.add(parent);
    }
    if (wanted.size === 0) return hits;
    const labels = await fetchLabels([...wanted], signal);
    return hits.map((hit) => {
      const context = (parents.get(hit.id) ?? []).map(
        (parent) => `${labels.get(parent) ?? parent} (${parent})`,
      );
      return context.length > 0 ? { ...hit, context } : hit;
    });
  } catch {
    // Die Oberklassen sind eine Zugabe. Fällt der Zusatzaufruf aus, bleibt die Suche gültig.
    return hits;
  }
}

export async function entityFacts(qid: string, signal?: AbortSignal): Promise<EntityFacts> {
  if (!/^Q\d+$/.test(qid)) throw new Error(`${qid} ist keine Wikidata-ID (erwartet: Q123).`);

  const raw = await cached(`entity:${qid}`, async () => {
    const url = withQuery(WIKIDATA_API, {
      action: "wbgetentities",
      ids: qid,
      props: "labels|descriptions|claims|sitelinks",
      languages: "de|en",
      sitefilter: "dewiki|enwiki",
      format: "json",
      origin: "*",
    });
    const data = await fetchJson<EntityResponse>(url, { timeoutMs: 20000, signal });
    const entity = data.entities?.[qid];
    if (!entity) throw new Error(`Wikidata kennt ${qid} nicht.`);
    return entity;
  });

  const claims = raw.claims ?? {};
  const referenced = new Set<string>();
  for (const statements of Object.values(claims)) {
    for (const statement of statements) {
      const id = entityIdOf(statement.mainsnak);
      if (id) referenced.add(id);
    }
  }

  const labelMap = await fetchLabels([...referenced, ...Object.keys(claims)], signal);

  const facts: Fact[] = [];
  for (const [property, statements] of Object.entries(claims)) {
    const values: FactValue[] = [];
    for (const statement of statements) {
      if (statement.rank === "deprecated") continue;
      if (statement.mainsnak?.snaktype && statement.mainsnak.snaktype !== "value") continue;
      const formatted = formatSnak(statement.mainsnak, labelMap);
      if (!formatted) continue;
      const year = qualifierYear(statement);
      values.push(year ? { value: formatted, year } : { value: formatted });
      if (values.length >= MAX_VALUES_PER_FACT) break;
    }
    if (values.length === 0) continue;
    facts.push({
      property,
      propertyLabel: labelMap.get(property) ?? property,
      values,
    });
    if (facts.length >= MAX_FACTS) break;
  }

  const label = raw.labels?.de?.value ?? raw.labels?.en?.value ?? qid;
  const description = raw.descriptions?.de?.value ?? raw.descriptions?.en?.value;

  return {
    id: qid,
    label,
    description,
    url: wikidataUrl(qid),
    facts,
    sitelinks: {
      dewiki: raw.sitelinks?.dewiki?.title,
      enwiki: raw.sitelinks?.enwiki?.title,
    },
  };
}

export async function fetchLabels(ids: string[], signal?: AbortSignal): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const unique = [...new Set(ids.filter((id) => /^[QP]\d+$/.test(id)))];
  for (let index = 0; index < unique.length; index += LABEL_CHUNK) {
    const chunk = unique.slice(index, index + LABEL_CHUNK);
    const url = withQuery(WIKIDATA_API, {
      action: "wbgetentities",
      ids: chunk.join("|"),
      props: "labels",
      languages: "de|en",
      format: "json",
      origin: "*",
    });
    try {
      const data = await cached(`labels:${chunk.join("|")}`, () =>
        fetchJson<LabelResponse>(url, { timeoutMs: 15000, signal }),
      );
      for (const [id, entity] of Object.entries(data.entities ?? {})) {
        const label = entity.labels?.de?.value ?? entity.labels?.en?.value;
        if (label) labels.set(id, label);
      }
    } catch {
      // Fehlende Labels sind kein Grund, den ganzen Aufruf zu verwerfen.
    }
  }
  return labels;
}

function entityIdOf(snak: RawSnak | undefined): string | undefined {
  const value = snak?.datavalue?.value;
  if (snak?.datavalue?.type !== "wikibase-entityid") return undefined;
  return (value as { id?: string } | undefined)?.id;
}

function qualifierYear(statement: RawStatement): number | undefined {
  const qualifiers = statement.qualifiers?.P585;
  if (!qualifiers) return undefined;
  for (const qualifier of qualifiers) {
    const value = qualifier.datavalue?.value as { time?: string } | undefined;
    const year = parseWikidataYear(value?.time);
    if (year !== undefined) return year;
  }
  return undefined;
}

function formatSnak(snak: RawSnak | undefined, labels: Map<string, string>): string | undefined {
  const datavalue = snak?.datavalue;
  if (!datavalue) return undefined;

  switch (datavalue.type) {
    case "wikibase-entityid": {
      const id = (datavalue.value as { id?: string }).id;
      if (!id) return undefined;
      const label = labels.get(id);
      return label ? `${label} (${id})` : id;
    }
    case "time": {
      const value = datavalue.value as { time?: string; precision?: number };
      return formatWikidataTime(value);
    }
    case "quantity": {
      const value = datavalue.value as { amount?: string; unit?: string };
      const amount = value.amount?.replace(/^\+/, "");
      if (!amount) return undefined;
      const unit = value.unit && value.unit !== "1" ? labels.get(lastId(value.unit)) : undefined;
      return unit ? `${amount} ${unit}` : amount;
    }
    case "monolingualtext": {
      const value = datavalue.value as { text?: string };
      return value.text;
    }
    case "globecoordinate": {
      const value = datavalue.value as { latitude?: number; longitude?: number };
      if (value.latitude === undefined || value.longitude === undefined) return undefined;
      return `${value.latitude}, ${value.longitude}`;
    }
    case "string":
    case "url":
    case "external-id":
      return String(datavalue.value);
    default:
      return undefined;
  }
}

export function formatWikidataTime(value: { time?: string; precision?: number }): string | undefined {
  const match = /^([+-])(\d{4})-(\d{2})-(\d{2})T/.exec(value.time ?? "");
  if (!match) return value.time;
  const [, sign, year, month, day] = match;
  const signed = sign === "-" ? `-${year}` : year;
  const precision = value.precision ?? 11;
  if (precision >= 11) return `${signed}-${month}-${day}`;
  if (precision === 10) return `${signed}-${month}`;
  return signed;
}

export function parseWikidataYear(time: string | undefined): number | undefined {
  const match = /^([+-])(\d{4})-/.exec(time ?? "");
  if (!match) return undefined;
  const year = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(year)) return undefined;
  return match[1] === "-" ? -year : year;
}

function lastId(uri: string): string {
  return uri.slice(uri.lastIndexOf("/") + 1);
}

/** Textform für den Prompt. Bewusst knapp, damit die Token nicht weglaufen. */
export function formatEntityFacts(entity: EntityFacts): string {
  const head = [`${entity.label} (${entity.id})`, entity.description ?? ""]
    .filter(Boolean)
    .join(" - ");
  const lines = entity.facts.map((fact) => {
    const values = fact.values
      .map((value) => (value.year ? `${value.value} [${value.year}]` : value.value))
      .join("; ");
    return `${fact.propertyLabel} (${fact.property}): ${values}`;
  });
  return [head, ...lines].join("\n");
}
