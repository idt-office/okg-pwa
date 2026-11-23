import type { ChartSpec } from "@okg/core/chart";
import { escapeHtml, renderMarkdown } from "@okg/core/markdown";
import type { AgentEvent, Source } from "@okg/core/types";

import { renderChartInto } from "./charts.js";
import { clearTurns, loadTurns, saveTurns } from "./store.js";

interface ToolTrace {
  name: string;
  summary?: string;
  detail?: unknown;
  ms?: number;
  error?: boolean;
  running?: boolean;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  enrich: boolean;
  tools: ToolTrace[];
  charts: ChartSpec[];
  sources: Source[];
  truncated?: boolean;
  elapsedMs?: number;
  rounds?: number;
  error?: string;
}

const SUGGESTIONS = [
  "Wie hat sich der Ausbau der Kernkraft über die Zeit entwickelt, und wann ging sie zurück?",
  "Welche Länder haben das höchste BIP pro Kopf? Nenne die fünf obersten.",
  "Wie viele Pumpspeicherkraftwerke gibt es in Deutschland, und welche haben die größte Leistung?",
  "Welche Länder mit hohem BIP pro Kopf haben viele Kernkraftwerke stillgelegt?",
];

const state = {
  turns: [] as Turn[],
  busy: false,
  abort: undefined as AbortController | undefined,
  model: "",
  enrich: localStorage.getItem("okg.enrich") !== "false",
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app fehlt");

app.innerHTML = `
  <header class="top">
    <div class="brand">
      <img src="/icon.svg" alt="" width="32" height="32" />
      <div>
        <strong>OKG Chat</strong>
        <span class="sub">Antworten mit Wikidata und DBpedia</span>
      </div>
    </div>
    <div class="controls">
      <label class="toggle">
        <input type="checkbox" id="enrich" ${state.enrich ? "checked" : ""} />
        <span>Anreicherung</span>
      </label>
      <select id="model" aria-label="Modell"></select>
      <button id="reset" class="ghost" type="button">Neu</button>
    </div>
  </header>
  <main id="log" aria-live="polite"></main>
  <footer class="composer">
    <div id="suggestions" class="suggestions"></div>
    <form id="form">
      <textarea id="input" rows="1" placeholder="Frage zu Anlagen, Ländern, Kennzahlen ..."></textarea>
      <button id="send" type="submit">Senden</button>
    </form>
    <p class="hint">
      Jede Zahl stammt aus einem Werkzeugergebnis dieses Turns. Das Modell
      <span id="model-hint"></span> bekommt Wikidata und DBpedia vorab als Kontext.
    </p>
  </footer>
`;

const log = document.querySelector<HTMLElement>("#log")!;
const form = document.querySelector<HTMLFormElement>("#form")!;
const input = document.querySelector<HTMLTextAreaElement>("#input")!;
const sendButton = document.querySelector<HTMLButtonElement>("#send")!;
const enrichBox = document.querySelector<HTMLInputElement>("#enrich")!;
const modelSelect = document.querySelector<HTMLSelectElement>("#model")!;
const modelHint = document.querySelector<HTMLElement>("#model-hint")!;
const suggestionBox = document.querySelector<HTMLElement>("#suggestions")!;

for (const question of SUGGESTIONS) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = question;
  chip.addEventListener("click", () => {
    input.value = question;
    input.focus();
  });
  suggestionBox.append(chip);
}

enrichBox.addEventListener("change", () => {
  state.enrich = enrichBox.checked;
  localStorage.setItem("okg.enrich", String(state.enrich));
  document.body.classList.toggle("no-enrich", !state.enrich);
});
document.body.classList.toggle("no-enrich", !state.enrich);

document.querySelector("#reset")!.addEventListener("click", async () => {
  state.turns = [];
  log.innerHTML = "";
  await clearTurns();
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(200, input.scrollHeight)}px`;
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.busy) {
    state.abort?.abort();
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  void send(text);
});

void boot();

async function boot(): Promise<void> {
  await Promise.all([loadHistory(), loadModels()]);
  if (state.turns.length === 0) showIntro();
}

async function loadHistory(): Promise<void> {
  const stored = await loadTurns<Turn>();
  state.turns = stored.map((turn) => ({ ...turn, tools: turn.tools ?? [], charts: turn.charts ?? [], sources: turn.sources ?? [] }));
  if (state.turns.length === 0) return;
  for (const turn of state.turns) log.append(renderTurn(turn));
  scrollToEnd();
}

async function loadModels(): Promise<void> {
  try {
    const [health, models] = await Promise.all([
      fetch("/api/health").then((response) => response.json()),
      fetch("/api/models").then((response) => response.json()),
    ]);
    const ids: string[] = models.models ?? [];
    modelSelect.innerHTML = "";
    for (const id of ids) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      modelSelect.append(option);
    }
    state.model = health.model ?? ids[0] ?? "";
    if (state.model) modelSelect.value = state.model;
    modelHint.textContent = state.model;
  } catch {
    modelSelect.innerHTML = "<option>nicht erreichbar</option>";
  }
}

function showIntro(): void {
  const intro = document.createElement("div");
  intro.className = "intro";
  intro.innerHTML = `
    <h1>Fragen, die ein Modell allein nicht belastbar beantwortet</h1>
    <p>
      Zählungen, Ranglisten und Zeitreihen kommen aus Wikidata und DBpedia, bevor
      das Modell antwortet. Was in den Prompt ging, steht unter jeder Antwort im
      Quellenpanel.
    </p>`;
  log.append(intro);
}

async function send(text: string): Promise<void> {
  state.busy = true;
  sendButton.textContent = "Stop";
  document.body.classList.add("busy");

  const userTurn: Turn = {
    role: "user",
    content: text,
    enrich: state.enrich,
    tools: [],
    charts: [],
    sources: [],
  };
  const assistantTurn: Turn = {
    role: "assistant",
    content: "",
    enrich: state.enrich,
    tools: [],
    charts: [],
    sources: [],
  };
  state.turns.push(userTurn, assistantTurn);

  const userNode = renderTurn(userTurn);
  const assistantNode = renderTurn(assistantTurn, true);
  log.append(userNode, assistantNode);
  scrollToEnd();

  const controller = new AbortController();
  state.abort = controller;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: apiMessages(),
        enrich: state.enrich,
        model: state.model || undefined,
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({ error: response.statusText }));
      assistantTurn.error = body.error ?? `HTTP ${response.status}`;
      refresh(assistantTurn, assistantNode, false);
      return;
    }

    await readStream(response.body, assistantTurn, assistantNode);
  } catch (error) {
    assistantTurn.error =
      controller.signal.aborted
        ? "Abgebrochen."
        : error instanceof Error
          ? error.message
          : String(error);
  } finally {
    state.busy = false;
    state.abort = undefined;
    sendButton.textContent = "Senden";
    document.body.classList.remove("busy");
    refresh(assistantTurn, assistantNode, false);
    await saveTurns(state.turns);
    scrollToEnd();
  }
}

function apiMessages(): { role: "user" | "assistant"; content: string }[] {
  return state.turns
    .filter((turn) => turn.content.trim().length > 0)
    .slice(-12)
    .map((turn) => ({ role: turn.role, content: turn.content }));
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  turn: Turn,
  node: HTMLElement,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let scheduled = false;

  const scheduleRefresh = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      refresh(turn, node, true);
      scrollToEnd(true);
    });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (dataLine) {
        try {
          handleEvent(JSON.parse(dataLine) as AgentEvent, turn);
        } catch {
          // Ein kaputtes Ereignis darf den Stream nicht abbrechen.
        }
      }
      scheduleRefresh();
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function handleEvent(event: AgentEvent, turn: Turn): void {
  switch (event.type) {
    case "token":
      turn.content += event.text;
      break;
    case "tool": {
      if (event.phase === "start") {
        turn.tools.push({ name: event.name, detail: event.detail, running: true });
      } else {
        const open = [...turn.tools].reverse().find((tool) => tool.name === event.name && tool.running);
        if (open) {
          open.running = false;
          open.summary = event.summary;
          open.detail = event.detail;
          open.ms = event.ms;
          open.error = event.error;
        } else {
          turn.tools.push({ name: event.name, summary: event.summary, ms: event.ms, error: event.error });
        }
      }
      break;
    }
    case "chart":
      turn.charts.push(event.spec);
      break;
    case "sources":
      turn.sources = event.sources;
      break;
    case "done":
      turn.truncated = event.truncated;
      turn.elapsedMs = event.elapsedMs;
      turn.rounds = event.rounds;
      break;
    case "error":
      turn.error = event.message;
      break;
  }
}

function renderTurn(turn: Turn, streaming = false): HTMLElement {
  const article = document.createElement("article");
  article.className = `msg ${turn.role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  article.append(bubble);

  if (turn.role === "user") {
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = turn.content;
    bubble.append(text);
    return article;
  }

  const text = document.createElement("div");
  text.className = "text";
  bubble.append(text);

  const charts = document.createElement("div");
  charts.className = "charts";
  bubble.append(charts);

  const tools = document.createElement("details");
  tools.className = "panel tools";
  bubble.append(tools);

  const sources = document.createElement("details");
  sources.className = "panel sources";
  bubble.append(sources);

  const meta = document.createElement("div");
  meta.className = "meta";
  bubble.append(meta);

  refresh(turn, article, streaming);
  return article;
}

function refresh(turn: Turn, article: HTMLElement, streaming: boolean): void {
  const text = article.querySelector<HTMLElement>(".text");
  if (!text) return;

  if (turn.content) {
    if (streaming) {
      text.textContent = turn.content;
      text.classList.add("streaming");
    } else {
      text.innerHTML = renderMarkdown(turn.content);
      text.classList.remove("streaming");
    }
  }

  const chartsBox = article.querySelector<HTMLElement>(".charts");
  if (chartsBox) {
    const rendered = Number(chartsBox.dataset.count ?? "0");
    if (turn.charts.length > rendered) {
      for (const spec of turn.charts.slice(rendered)) {
        const holder = document.createElement("div");
        chartsBox.append(holder);
        void renderChartInto(holder, spec);
      }
      chartsBox.dataset.count = String(turn.charts.length);
    }
  }

  const toolsPanel = article.querySelector<HTMLDetailsElement>(".tools");
  if (toolsPanel) {
    if (turn.tools.length === 0) {
      toolsPanel.hidden = true;
    } else {
      toolsPanel.hidden = false;
      const open = turn.tools.some((tool) => tool.running);
      toolsPanel.open = open;
      const label = open ? "läuft" : `${turn.tools.length} Werkzeugaufrufe`;
      toolsPanel.innerHTML = `<summary>${label}</summary>${toolList(turn.tools)}`;
    }
  }

  const sourcesPanel = article.querySelector<HTMLDetailsElement>(".sources");
  if (sourcesPanel) {
    if (turn.sources.length === 0) {
      sourcesPanel.hidden = true;
    } else {
      sourcesPanel.hidden = false;
      const entities = turn.sources.filter((source) => source.kind !== "query").length;
      const queries = turn.sources.length - entities;
      sourcesPanel.innerHTML = `<summary>Quellen: ${entities} Entitäten, ${queries} Abfragen</summary>${sourceList(
        turn.sources,
      )}`;
    }
  }

  const meta = article.querySelector<HTMLElement>(".meta");
  if (meta) {
    const parts: string[] = [];
    if (!turn.enrich) parts.push("ohne Anreicherung");
    if (turn.rounds) parts.push(`${turn.rounds} Runden`);
    if (turn.elapsedMs) parts.push(`${(turn.elapsedMs / 1000).toFixed(1)} s`);
    if (turn.truncated) parts.push("Zeitbudget erreicht, Anreicherung unvollständig");
    meta.textContent = parts.join(" · ");
  }

  const errorBox = article.querySelector<HTMLElement>(".error");
  if (turn.error) {
    if (errorBox) {
      errorBox.textContent = turn.error;
    } else {
      const box = document.createElement("p");
      box.className = "error";
      box.textContent = turn.error;
      article.querySelector(".bubble")?.append(box);
    }
  } else {
    errorBox?.remove();
  }
}

function toolList(tools: ToolTrace[]): string {
  const items = tools
    .map((tool) => {
      const status = tool.running ? "läuft" : tool.error ? "Fehler" : "ok";
      const ms = tool.ms ? ` · ${tool.ms} ms` : "";
      const summary = tool.summary ? ` · ${escapeHtml(tool.summary)}` : "";
      const detail =
        tool.detail && typeof tool.detail === "object"
          ? `<pre>${escapeHtml(JSON.stringify(tool.detail, null, 2).slice(0, 1200))}</pre>`
          : "";
      return `<li><span class="tool-name">${escapeHtml(tool.name)}</span> <span class="tag ${status === "Fehler" ? "bad" : ""}">${status}${ms}</span>${summary}${detail}</li>`;
    })
    .join("");
  return `<ul class="tool-list">${items}</ul>`;
}

function sourceList(sources: Source[]): string {
  const items = sources
    .map((source) => {
      const href = source.url.startsWith("http") ? source.url : "#";
      const label = escapeHtml(source.label);
      const query = source.query
        ? `<details><summary>SPARQL</summary><pre>${escapeHtml(source.query)}</pre></details>`
        : "";
      return `<li><span class="kg ${source.kg}">${source.kg === "wikidata" ? "WD" : "DBp"}</span> <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>${query}</li>`;
    })
    .join("");
  return `<ul class="source-list">${items}</ul>`;
}

function scrollToEnd(soft = false): void {
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 240;
  if (soft && !nearBottom) return;
  window.scrollTo({ top: document.body.scrollHeight, behavior: soft ? "auto" : "smooth" });
}
