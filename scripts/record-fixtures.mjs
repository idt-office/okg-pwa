/**
 * Zeichnet echte Antworten von Wikidata und DBpedia als Fixtures auf, damit die
 * Tests ohne Netz laufen. Einmalig ausführen: node scripts/record-fixtures.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UA = "okg-pwa/0.1 (IDT FH Aachen; okg-pwa@fh-aachen.de)";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "packages/core/test/fixtures");
await mkdir(dir, { recursive: true });

async function save(name, url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { "user-agent": UA, accept: "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${response.status} für ${name}`);
  const text = await response.text();
  JSON.parse(text);
  await writeFile(join(dir, `${name}.json`), text);
  console.log(`${name}.json  ${text.length} bytes`);
}

const WIKI = "https://www.wikidata.org/w/api.php";
const sparql = (endpoint, query) =>
  fetch(endpoint, {
    method: "POST",
    headers: {
      "user-agent": UA,
      accept: "application/sparql-results+json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ query }).toString(),
  });

await save(
  "wbsearchentities",
  `${WIKI}?action=wbsearchentities&search=Pumpspeicherkraftwerk&language=de&uselang=de&type=item&limit=8&format=json&origin=*`,
);
await save(
  "wbgetentities-Q339353",
  `${WIKI}?action=wbgetentities&ids=Q339353&props=labels|descriptions|claims|sitelinks&languages=de|en&sitefilter=dewiki|enwiki&format=json&origin=*`,
);
{
  // Alle Property- und Verweis-IDs aus der Entitäts-Fixture, damit Labels im
  // Test wirklich aufgelöst werden und nicht nur der Fallback greift.
  const entity = JSON.parse(
    await (await import("node:fs/promises")).readFile(join(dir, "wbgetentities-Q339353.json"), "utf8"),
  ).entities.Q339353;
  const ids = new Set(Object.keys(entity.claims ?? {}));
  for (const statements of Object.values(entity.claims ?? {})) {
    for (const statement of statements) {
      const value = statement.mainsnak?.datavalue?.value;
      if (statement.mainsnak?.datavalue?.type === "wikibase-entityid" && value?.id) ids.add(value.id);
      if (statement.mainsnak?.datavalue?.type === "quantity" && value?.unit) {
        ids.add(String(value.unit).slice(String(value.unit).lastIndexOf("/") + 1));
      }
    }
  }
  const list = [...ids].filter((id) => /^[QP]\d+$/.test(id)).slice(0, 50);
  await save(
    "wbgetentities-labels",
    `${WIKI}?action=wbgetentities&ids=${list.join("|")}&props=labels&languages=de|en&format=json&origin=*`,
  );
}
await save(
  "dbpedia-lookup",
  "https://lookup.dbpedia.org/api/search?query=Pumped-storage%20hydroelectricity&format=json&maxResults=3",
);

{
  const response = await sparql(
    "https://dbpedia.org/sparql",
    'SELECT ?country ?gdp WHERE { ?country a dbo:Country ; dbp:gdpNominalPerCapita ?gdp . FILTER(isNumeric(xsd:decimal(REPLACE(STR(?gdp), ",", "")))) } ORDER BY DESC(xsd:decimal(REPLACE(STR(?gdp), ",", ""))) LIMIT 10',
  );
  const text = await response.text();
  JSON.parse(text);
  await writeFile(join(dir, "dbpedia-sparql.json"), text);
  console.log(`dbpedia-sparql.json  ${text.length} bytes`);
}

{
  const response = await sparql(
    "https://query.wikidata.org/sparql",
    'SELECT ?year (COUNT(DISTINCT ?plant) AS ?retired) WHERE { ?plant wdt:P31/wdt:P279* wd:Q134447 ; wdt:P730 ?date . BIND(YEAR(?date) AS ?year) } GROUP BY ?year ORDER BY ?year',
  );
  const text = await response.text();
  JSON.parse(text);
  await writeFile(join(dir, "wikidata-sparql-timeline.json"), text);
  console.log(`wikidata-sparql-timeline.json  ${text.length} bytes`);
}
