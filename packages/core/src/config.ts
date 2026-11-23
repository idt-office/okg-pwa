/** Grenzen und Endpunkte des Laufs. Alles per Env überschreibbar. */
export interface AgentConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  maxRounds: number;
  budgetMs: number;
  /** Zusatzfrist für die Schlussantwort, wenn das Budget im Werkzeuglauf verbraucht wurde. */
  finalAnswerMs: number;
}

export const DEFAULTS = {
  baseURL: "https://chat.kiconnect.nrw/api/v1",
  model: "openai-gpt-oss-120b",
  // Gemessen: mit 8 s und 3 Runden blieb für das Diagramm keine Runde übrig.
  // Eine einzelne teure Wikidata-Abfrage kann 12 s brauchen; 22 s lassen eine
  // Wiederholung und die Schlussantwort zu. Das Diagramm entsteht notfalls
  // automatisch aus der Abfragetabelle (autoChartFromTable).
  maxRounds: 4,
  budgetMs: 22000,
  finalAnswerMs: 15000,
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const apiKey = env.KICONNECT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "KICONNECT_API_KEY fehlt. Lege sie in .env ab (Vorlage: .env.example).",
    );
  }
  return {
    baseURL: env.KICONNECT_BASE_URL?.trim() || DEFAULTS.baseURL,
    apiKey,
    model: env.OKG_MODEL?.trim() || DEFAULTS.model,
    maxRounds: positiveInt(env.OKG_MAX_ROUNDS, DEFAULTS.maxRounds),
    budgetMs: positiveInt(env.OKG_BUDGET_MS, DEFAULTS.budgetMs),
    finalAnswerMs: positiveInt(env.OKG_FINAL_ANSWER_MS, DEFAULTS.finalAnswerMs),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * kiconnect lehnt bei den gpt-5-Modellen `max_tokens` ab und verlangt
 * `max_completion_tokens`. Wir setzen das Feld deshalb modellabhängig.
 */
export function tokenLimitField(model: string): "max_tokens" | "max_completion_tokens" {
  return /^gpt-5/i.test(model) ? "max_completion_tokens" : "max_tokens";
}
