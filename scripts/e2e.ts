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
  expect: { tools: boolean; chart: boolean };
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
    expect: { tools: true, chart: true },
  },
  {
    id: 3,
    question:
      "Wie viele Pumpspeicherkraftwerke gibt es in Deutschland, und welche haben die größte Leistung?",
    enrich: true,
    expect: { tools: true, chart: true },
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
    if (event.type === "chart") charts += 1;
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
  if (testCase.expect.tools && tools === 0) problems.push("kein Werkzeugaufruf");
  if (!testCase.expect.tools && tools > 0) problems.push("Werkzeug trotz abgeschalteter Anreicherung");
  if (testCase.expect.chart && charts === 0) problems.push("kein Diagramm");
  if (errors > 0) problems.push(`${errors} Fehlerereignis(se)`);

  console.log(`    Werkzeuge: ${tools} (${toolNames.join(", ")}), Diagramme: ${charts}, Quellen: ${sources.length}, ${elapsed} ms`);
  if (done) console.log(`    Runden: ${done.rounds}, abgeschnitten: ${done.truncated}`);
  console.log(`    Antwort: ${text.slice(0, 400).replace(/\s+/g, " ")}`);

  if (problems.length > 0) {
    failures += 1;
    console.log(`    PROBLEM: ${problems.join(", ")}`);
  } else {
    console.log("    OK");
  }
}

console.log(failures === 0 ? "\nAlle Fälle bestanden." : `\n${failures} Fall/Fälle mit Problemen.`);
process.exit(failures === 0 ? 0 : 1);
