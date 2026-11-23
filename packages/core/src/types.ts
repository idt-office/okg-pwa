import type { ChartSpec } from "./chart.js";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type KnowledgeGraph = "wikidata" | "dbpedia";

export interface Source {
  kg: KnowledgeGraph;
  kind: "entity" | "lookup" | "query";
  id: string;
  label: string;
  url: string;
  /** Bei Abfragen: der abgesetzte SPARQL-Text. */
  query?: string;
}

export type AgentEvent =
  | { type: "token"; text: string }
  | {
      type: "tool";
      name: string;
      phase: "start" | "end";
      summary?: string;
      detail?: unknown;
      ms?: number;
      error?: boolean;
    }
  | { type: "chart"; spec: ChartSpec }
  | { type: "sources"; sources: Source[] }
  | {
      type: "done";
      model: string;
      rounds: number;
      elapsedMs: number;
      truncated: boolean;
      enrich: boolean;
    }
  | { type: "error"; message: string };

export interface ChatRequest {
  messages: ChatMessage[];
  enrich: boolean;
  model?: string;
}
