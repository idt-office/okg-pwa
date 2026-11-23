import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { AIMessageChunk } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import type { ChartSpec } from "./chart.js";
import { autoChartFromTable } from "./chart.js";
import { tokenLimitField, type AgentConfig } from "./config.js";
import { NumberLedger } from "./ledger.js";
import { systemPrompt } from "./prompt.js";
import { executeTool, toolDefs, type ToolRuntime } from "./tools.js";
import type { AgentEvent, ChatMessage, ChatRequest, Source } from "./types.js";

const TOOL_TOKEN_LIMIT = 1200;
const FINAL_TOKEN_LIMIT = 1100;

export function buildModel(cfg: AgentConfig, modelOverride?: string): ChatOpenAI {
  const model = modelOverride?.trim() || cfg.model;
  return new ChatOpenAI({
    model,
    apiKey: cfg.apiKey,
    temperature: 0,
    streaming: true,
    configuration: { baseURL: cfg.baseURL },
    modelKwargs: { [tokenLimitField(model)]: TOOL_TOKEN_LIMIT },
  });
}

/**
 * Der Agentenlauf. Bewusst eine eigene Schleife statt `createAgent`: Runden und
 * Zeitbudget sind harte Grenzen, und der Fortschritt muss als SSE-Ereignis
 * hinausgehen, während er entsteht. Das Modell selbst kommt aus LangChain
 * (ChatOpenAI, Tool-Binding, Message-Typen, Streaming).
 */
export async function* runAgent(
  request: ChatRequest,
  cfg: AgentConfig,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const startedAt = Date.now();
  const deadline = startedAt + cfg.budgetMs;
  const enrich = request.enrich !== false;
  const model = buildModel(cfg, request.model);
  const bound = enrich ? model.bindTools(toolDefs) : model;

  const ledger = new NumberLedger();
  const sources: Source[] = [];
  const charts: ChartSpec[] = [];
  const runtime: ToolRuntime = { ledger, sources, charts, deadline, signal };

  const messages: BaseMessage[] = [
    new SystemMessage(
      systemPrompt({ enrich, maxRounds: cfg.maxRounds, budgetMs: cfg.budgetMs }),
    ),
    ...request.messages.map(toLangChainMessage),
  ];

  let rounds = 0;
  let truncated = false;
  let answerEmitted = false;

  try {
    while (rounds < cfg.maxRounds) {
      if (signal?.aborted) return;
      const remaining = deadline - Date.now();
      if (remaining < 3000) {
        truncated = true;
        break;
      }
      rounds += 1;

      const chunks = await collectStreamSafely(
        bound.stream(messages, { signal: withTimeout(signal, remaining) }),
        messages,
      );
      if (!chunks) {
        // Runde abgebrochen (Zeit oder Netz). Mit vorhandenen Werkzeugdaten
        // antworten wir trotzdem, statt den Nutzer mit nichts stehen zu lassen.
        truncated = true;
        break;
      }
      for (const chunk of chunks.deltas) {
        answerEmitted = true;
        yield { type: "token", text: chunk };
      }
      const answer = chunks.message;
      if (!answer) {
        truncated = true;
        break;
      }

      messages.push(answer);
      const calls = answer.tool_calls ?? [];
      if (calls.length === 0) break;

      for (const call of calls) {
        if (signal?.aborted) return;
        yield { type: "tool", name: call.name, phase: "start", detail: call.args };
        const toolStarted = Date.now();
        const result = await executeTool(call.name, call.args, runtime);
        yield {
          type: "tool",
          name: call.name,
          phase: "end",
          summary: summarize(result.content),
          detail: result.ok ? undefined : result.content,
          error: !result.ok,
          ms: Date.now() - toolStarted,
        };
        if (result.chart) yield { type: "chart", spec: result.chart };
        messages.push(
          new ToolMessage({
            content: enrich ? `${result.content}\n\n${statusLine(rounds, cfg, deadline)}` : result.content,
            tool_call_id: (call as { id?: string }).id ?? "",
          }),
        );
      }
      if (Date.now() >= deadline) {
        truncated = true;
        break;
      }
    }

    if (signal?.aborted) return;

    const lastMessage = messages[messages.length - 1];
    const needsFinalAnswer =
      !signal?.aborted && (lastMessage instanceof ToolMessage || !answerEmitted);
    if (needsFinalAnswer) {
      if (lastMessage instanceof ToolMessage) truncated = true;
      yield* streamFinalAnswer(model, messages, cfg, signal);
    }

    if (charts.length === 0) {
      // Rückfallebene: aus der letzten zeichenbaren Abfragetabelle ein Diagramm
      // bauen, damit eine quantitative Antwort nicht ohne Bild endet.
      for (const table of [...(runtime.tables ?? [])].reverse()) {
        const auto = autoChartFromTable(table, ledger);
        if (auto) {
          charts.push(auto);
          yield { type: "chart", spec: auto };
          break;
        }
      }
    }

    if (sources.length > 0) yield { type: "sources", sources };
    yield {
      type: "done",
      model: request.model?.trim() || cfg.model,
      rounds,
      elapsedMs: Date.now() - startedAt,
      truncated,
      enrich,
    };
  } catch (error) {
    if (signal?.aborted) return;
    yield { type: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Wenn das Budget im Werkzeuglauf aufgebraucht wurde, darf der Nutzer nicht mit
 * einer leeren Antwort sitzen bleiben: eine letzte Runde ohne Werkzeuge, mit
 * ausdrücklichem Hinweis auf die Lücke.
 */
async function* streamFinalAnswer(
  model: ChatOpenAI,
  messages: BaseMessage[],
  cfg: AgentConfig,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const closing = new SystemMessage(
    "Das Werkzeugbudget ist erschöpft. Antworte jetzt in zwei bis vier Sätzen: Kernergebnis mit höchstens fünf Zahlen, die wichtigste Lücke benennen, auf das Diagramm verweisen. Verwende keine langen Zahlenlisten und keine Tabellen.",
  );
  try {
    // Zwei Versuche: das Modell liefert gelegentlich eine Runde ohne Text
    // (nur Reasoning-Deltas). Dann ist eine Wiederholung billiger als eine
    // leere Antwort.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const collection = await collectStream(
        await model.stream([...messages, closing], { signal: withTimeout(signal, cfg.finalAnswerMs) }),
      );
      if (collection.deltas.length > 0) {
        for (const chunk of collection.deltas) {
          yield { type: "token", text: chunk };
        }
        return;
      }
    }
    yield {
      type: "token",
      text: "Die Antwort konnte nicht erzeugt werden. Die abgerufenen Quellen stehen im Quellenpanel.",
    };
  } catch {
    yield {
      type: "token",
      text: "\n\n(Die Anreicherung hat das Zeitbudget überschritten. Eine Zusammenfassung war nicht mehr möglich; die abgerufenen Quellen stehen im Quellenpanel.)",
    };
  }
}

interface Collected {
  message?: AIMessage;
  deltas: string[];
}

/**
 * Sammelt eine Modellrunde. Bricht die Runde ab (Frist oder Netz), wird `null`
 * zurückgegeben, damit der Lauf mit den vorhandenen Werkzeugdaten antworten
 * kann. Ohne Werkzeugdaten ist der Fehler echt und wird weitergereicht.
 */
async function collectStreamSafely(
  streamPromise: Promise<AsyncIterable<AIMessageChunk>>,
  messages: BaseMessage[],
): Promise<Collected | null> {
  try {
    return await collectStream(await streamPromise);
  } catch (error) {
    const hasToolResults = messages.some((message) => message instanceof ToolMessage);
    if (!hasToolResults) throw error;
    return null;
  }
}

async function collectStream(
  stream: AsyncIterable<AIMessageChunk>,
): Promise<Collected> {
  const deltas: string[] = [];
  let accumulated: AIMessageChunk | undefined;
  for await (const chunk of stream) {
    const text = typeof chunk.content === "string" ? chunk.content : "";
    if (text) deltas.push(text);
    accumulated = accumulated ? accumulated.concat(chunk) : chunk;
  }
  if (!accumulated) return { deltas };
  return {
    deltas,
    message: new AIMessage({
      content: accumulated.content,
      tool_calls: accumulated.tool_calls ?? [],
      invalid_tool_calls: accumulated.invalid_tool_calls ?? [],
    }),
  };
}

/** Verbindet den Abbruch des Clients mit der Frist der jeweiligen Runde. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1000, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function toLangChainMessage(message: ChatMessage): BaseMessage {
  switch (message.role) {
    case "system":
      return new SystemMessage(message.content);
    case "assistant":
      return new AIMessage(message.content);
    default:
      return new HumanMessage(message.content);
  }
}

function summarize(content: string): string {
  const withoutWrapper = content
    .replace(/^<knowledge[^>]*>\n?/, "")
    .replace(/\n?<\/knowledge>$/, "")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const first = withoutWrapper[0] ?? "";
  return first.length <= 140 ? first : `${first.slice(0, 139)}...`;
}

/**
 * Standanzeige in jeder Werkzeugantwort. Ohne sie verbraucht das Modell alle
 * Runden mit Nachfragen und hat für das Diagramm keine übrig (gemessen).
 */
function statusLine(round: number, cfg: { maxRounds: number }, deadline: number): string {
  const secondsLeft = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  const roundsLeft = Math.max(0, cfg.maxRounds - round);
  const chartHint =
    roundsLeft <= 2 || secondsLeft < 10
      ? " Wenn die Zahlen reichen: jetzt render_chart aufrufen und antworten."
      : " Zahlen gehören ins Diagramm, nicht als Liste in die Antwort.";
  return `[Status: Runde ${round}/${cfg.maxRounds}, ${secondsLeft} s übrig.${chartHint}]`;
}
