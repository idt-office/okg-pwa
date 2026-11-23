/**
 * End-to-End-Lauf gegen die echten Endpunkte. Prüft, ob der Agent die
 * Abnahmefälle beantwortet und ob Charts nur mit belegten Zahlen entstehen.
 *
 *   npm run e2e            alle Fälle
 *   npm run e2e -- 3       nur Fall 3
 */
import { config as loadEnv } from "dotenv";
import { loadConfig, runAgent, type AgentEvent, type Source } from "../packages/core/src/index.ts";

loadEnv({ path: ".env", quiet: true });

interface Case {
  id: number;
  question: string;
  enrich: boolean;
  expect: {
    tools: boolean;
    chart: boolean;
    /** Muss in der Antwort stehen, sonst ist sie inhaltlich falsch. */
    answer?: RegExp;
    /** Darf nicht dastehen: ein Verband als Land, ein Diagramm ohne Bild. */
    notAnswer?: RegExp;
    /**
     * Die genannte Spitze muss vor allen anderen Kandidaten stehen. Eine
     * Erwähnung irgendwo im Text genügt nicht: "Australien 54 348 ... (z. B.
     * Luxemburg fehlt)" nennt Luxemburg, ist aber die falsche Rangliste.
     */
    rankFirst?: { name: RegExp; others: RegExp };
  };
}

const cases: Case[] = [
  {
    id: 1,
    question:
      "Wie hat sich der Ausbau der Kernkraft über die Zeit entwickelt, und wann ging sie zurück?",
    enrich: true,
    expect: { tools: true, chart: true },
  },
  {
    id: 2,
    question: "Welche Länder haben das höchste BIP pro Kopf? Nenne die fünf obersten.",
    enrich: true,
    // Die Spitzengruppe sind Steueroasen. Steht Monaco nicht zuerst, wurde
    // lexikografisch sortiert (Australien, Ungarn, ...).
    expect: {
      tools: true,
      chart: true,
      rankFirst: {
        name: /Monaco/i,
        others:
          /Liechtenstein|Luxemburg|Luxembourg|Irland|Ireland|Schweiz|Switzerland|Katar|Qatar|Australien|Neuseeland|Ungarn|Tschechien|Spanien|Singapur|Singapore/i,
      },
      notAnswer: /EFTA|European Free Trade|Freihandelsassoziation/i,
    },
  },
  {
    id: 3,
    question:
      "Wie viele Pumpspeicherkraftwerke gibt es in Deutschland, und welche haben die größte Leistung?",
    enrich: true,
    expect: { tools: true, chart: true, answer: /42/ },
  },
  {
    id: 4,
    question:
      "Welche Länder mit hohem BIP pro Kopf haben viele Kernkraftwerke stillgelegt? Nenne drei Beispiele.",
    enrich: true,
    expect: { tools: true, chart: false },
  },
  {
    id: 5,
    question: "Wie hat sich der Ausbau der Kernkraft über die Zeit entwickelt?",
    enrich: false,
    expect: { tools: false, chart: false },
  },
];

const onlyArg = process.argv[2];
const selected = onlyArg ? cases.filter((item) => String(item.id) === onlyArg) : cases;

const cfg = loadConfig();
let failures = 0;

for (const testCase of selected) {
  const started = Date.now();
  let answer = "";
  let charts = 0;
  let tools = 0;
  const toolNames: string[] = [];
  let errors = 0;
  let toolErrors = 0;
  let sources: Source[] = [];
  let done: Extract<AgentEvent, { type: "done" }> | undefined;

  console.log(`\n=== Fall ${testCase.id}: ${testCase.question}`);
  console.log(`    Anreicherung: ${testCase.enrich ? "an" : "aus"}`);

  for await (const event of runAgent(
    { messages: [{ role: "user", content: testCase.question }], enrich: testCase.enrich },
    cfg,
  )) {
    if (event.type === "token") answer += event.text;
    if (event.type === "tool" && event.phase === "start") {
    tools += 1;
    toolNames.push(event.name);
  }
  if (event.type === "tool" && event.phase === "end" && event.error) {
    toolErrors += 1;
    console.log(`      Werkzeugfehler ${event.name}: ${String(event.detail ?? event.summary).replace(/\s+/g, " ").slice(0, 260)}`);
  }
    if (event.type === "chart") {
      charts += 1;
      const points = event.spec.series.reduce((sum, series) => sum + series.points.length, 0);
      console.log(
        `      Diagramm: ${event.spec.type}, ${event.spec.xField} -> ${event.spec.yField}, ${points} Punkte${event.spec.note ? ` (${event.spec.note})` : ""}`,
      );
    }
    if (event.type === "sources") sources = event.sources;
    if (event.type === "error") {
      errors += 1;
      console.log(`    FEHLER: ${event.message}`);
    }
    if (event.type === "done") done = event;
  }

  const elapsed = Date.now() - started;
  const text = answer.trim();
  const problems: string[] = [];
  if (text.length < 40) problems.push("Antwort zu kurz");
  if (text.includes("konnte nicht erzeugt werden")) problems.push("keine Antwort erzeugt");
  if (testCase.expect.tools && tools === 0) problems.push("kein Werkzeugaufruf");
  if (!testCase.expect.tools && tools > 0) problems.push("Werkzeug trotz abgeschalteter Anreicherung");
  if (testCase.expect.chart && charts === 0) problems.push("kein Diagramm");
  if (!testCase.expect.chart && charts === 0 && /diagramm|grafik/i.test(text)) {
    problems.push("Diagramm erwähnt, aber keins erzeugt");
  }
  if (testCase.expect.answer && !testCase.expect.answer.test(text)) {
    problems.push(`Antwort enthält ${testCase.expect.answer} nicht`);
  }
  if (testCase.expect.rankFirst) {
    const { name, others } = testCase.expect.rankFirst;
    const flat = text.replace(/\s+/g, " ");
    const first = name.exec(flat);
    const other = others.exec(flat);
    // "Monaco ist in Wikidata nicht erfasst" ist keine Spitze, sondern ein Haken.
    const hedged = new RegExp(
      `${name.source}[^.;]{0,40}(nicht erfasst|nicht enthalten|fehlt|keine Daten|nicht in den Daten)`,
      "i",
    ).test(flat);
    if (!first) problems.push(`Antwort nennt ${name} nicht`);
    else if (first.index > 200) {
      problems.push(`Antwort nennt ${name} erst nach ${first.index} Zeichen, nicht als Spitze`);
    } else if (other && other.index < first.index) {
      problems.push(`Antwort nennt ${other[0]} vor ${first[0]}, die Rangliste stimmt nicht`);
    } else if (hedged) {
      problems.push(`Antwort nennt ${name} nur mit Einschränkung`);
    }
  }
  if (testCase.expect.notAnswer?.test(text)) {
    problems.push(`Antwort nennt ${testCase.expect.notAnswer}, das ist kein Land`);
  }
  if (errors > 0) problems.push(`${errors} Fehlerereignis(se)`);

  console.log(
    `    Werkzeuge: ${tools} (${toolNames.join(", ")}), Fehler: ${toolErrors}, Diagramme: ${charts}, Quellen: ${sources.length}, ${elapsed} ms`,
  );
  if (done) console.log(`    Runden: ${done.rounds}, abgeschnitten: ${done.truncated}`);
  console.log(`    Antwort: ${text.slice(0, 400).replace(/\s+/g, " ")}`);

  if (problems.length > 0) {
    failures += 1;
    console.log(`    PROBLEM: ${problems.join(", ")}`);
  } else if (toolErrors > 0) {
    // Ein korrigierter Werkzeugfehler ist kein Fehlschlag, aber sichtbar.
    console.log(`    OK (mit ${toolErrors} korrigierten Werkzeugfehler(n))`);
  } else {
    console.log("    OK");
  }
}

console.log(failures === 0 ? "\nAlle Fälle bestanden." : `\n${failures} Fall/Fälle mit Problemen.`);
process.exit(failures === 0 ? 0 : 1);
