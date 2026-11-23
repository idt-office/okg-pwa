import { AIMessageChunk } from "@langchain/core/messages";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/types.js";

/**
 * Die Schleife wird ohne Netz geprüft: ChatOpenAI ist durch ein Skript ersetzt,
 * das pro Runde eine feste Folge von Chunks liefert.
 */
const state = vi.hoisted(() => ({ rounds: [] as unknown[][] }));

vi.mock("@langchain/openai", () => {
  class FakeChatOpenAI {
    model: string;
    constructor(options: { model: string }) {
      this.model = options.model;
    }
    bindTools() {
      return this;
    }
    async stream() {
      const chunks = state.rounds.shift() ?? [];
      return (async function* generate() {
        for (const chunk of chunks) yield chunk;
      })();
    }
  }
  return { ChatOpenAI: FakeChatOpenAI };
});

const { runAgent } = await import("../src/agent.js");

const cfg = {
  baseURL: "http://example.invalid/v1",
  apiKey: "test",
  model: "test-model",
  maxRounds: 4,
  budgetMs: 5000,
  finalAnswerMs: 2000,
};

function text(value: string): AIMessageChunk {
  return new AIMessageChunk({ content: value });
}

function toolCall(name: string, args: Record<string, unknown>, id: string): AIMessageChunk {
  return new AIMessageChunk({
    content: "",
    tool_call_chunks: [{ name, args: JSON.stringify(args), id, index: 0, type: "tool_call_chunk" }],
  });
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const list: AgentEvent[] = [];
  for await (const event of events) list.push(event);
  return list;
}

function tokens(events: AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { type: "token" }> => event.type === "token")
    .map((event) => event.text)
    .join("");
}

afterEach(() => {
  state.rounds = [];
  vi.unstubAllGlobals();
});

describe("runAgent", () => {
  it("streamt eine direkte Antwort ohne Werkzeuge", async () => {
    state.rounds = [[text("Hallo "), text("Welt")]];
    const events = await collect(
      runAgent({ messages: [{ role: "user", content: "Hi" }], enrich: false }, cfg),
    );

    expect(tokens(events)).toBe("Hallo Welt");
    const done = events.find((event): event is Extract<AgentEvent, { type: "done" }> => event.type === "done");
    expect(done?.truncated).toBe(false);
    expect(done?.rounds).toBe(1);
    expect(done?.enrich).toBe(false);
  });

  it("führt einen Werkzeugaufruf aus und antwortet danach", async () => {
    const search = JSON.parse(
      await readFile(new URL("./fixtures/wbsearchentities.json", import.meta.url), "utf8"),
    );
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = String(input);
      if (url.includes("wbsearchentities")) {
        return new Response(JSON.stringify(search), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });

    state.rounds = [
      [toolCall("wikidata_search", { term: "Pumpspeicherkraftwerk" }, "call_1")],
      [text("Es gibt 42 Anlagen.")],
    ];

    const events = await collect(
      runAgent({ messages: [{ role: "user", content: "Wie viele?" }], enrich: true }, cfg),
    );

    const toolEvents = events.filter((event) => event.type === "tool");
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toMatchObject({ name: "wikidata_search", phase: "start" });
    expect(toolEvents[1]).toMatchObject({ name: "wikidata_search", phase: "end", error: false });
    expect(tokens(events)).toBe("Es gibt 42 Anlagen.");

    const sources = events.find((event): event is Extract<AgentEvent, { type: "sources" }> => event.type === "sources");
    expect(sources?.sources.length).toBeGreaterThan(0);
  });

  it("holt eine Schlussantwort, wenn das Budget vor der Antwort aufgebraucht ist", async () => {
    state.rounds = [[text("Nie gesendet")]];
    const events = await collect(
      runAgent({ messages: [{ role: "user", content: "Hi" }], enrich: false }, { ...cfg, budgetMs: 100 }),
    );

    const done = events.find((event): event is Extract<AgentEvent, { type: "done" }> => event.type === "done");
    expect(done?.truncated).toBe(true);
    expect(tokens(events)).toBe("Nie gesendet");
  });

  it("wiederholt eine leere Modellantwort, statt leer zu bleiben", async () => {
    state.rounds = [[], [text("Zweiter Versuch.")]];
    const events = await collect(
      runAgent({ messages: [{ role: "user", content: "Hi" }], enrich: false }, cfg),
    );

    expect(tokens(events)).toBe("Zweiter Versuch.");
  });

  it("bricht bei abgebrochenem Client ab, ohne done zu senden", async () => {
    state.rounds = [[text("Anfang")]];
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      runAgent({ messages: [{ role: "user", content: "Hi" }], enrich: false }, cfg, controller.signal),
    );
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
});
