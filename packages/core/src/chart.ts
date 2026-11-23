import { z } from "zod";
import type { NumberLedger } from "./ledger.js";

export const CHART_TYPES = ["bar", "line", "table"] as const;

const pointSchema = z.object({
  x: z.union([z.string().min(1), z.number()]),
  y: z.number().refine(Number.isFinite, "y muss eine endliche Zahl sein"),
});

const seriesSchema = z.object({
  name: z.string().min(1).max(60),
  points: z.array(pointSchema).min(1).max(60),
});

export const chartSpecSchema = z.object({
  type: z.enum(CHART_TYPES),
  title: z.string().min(3).max(120),
  xField: z.string().min(1).max(40),
  yField: z.string().min(1).max(40),
  unit: z.string().max(20).optional(),
  series: z.array(seriesSchema).min(1).max(3),
  note: z.string().max(300).optional(),
});

export type ChartSpec = z.infer<typeof chartSpecSchema>;

export class ChartRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChartRejected";
  }
}

/**
 * Prüft einen Chart-Vorschlag des Modells. Zwei Regeln sind hart: jeder
 * y-Wert muss in diesem Turn aus einem Werkzeug stammen (NumberLedger), und
 * eine Linie braucht mindestens zwei Punkte.
 */
export function buildChart(raw: unknown, ledger: NumberLedger): ChartSpec {
  const parsed = chartSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`)
      .join("; ");
    throw new ChartRejected(`Chart-Spec ungültig: ${details}`);
  }

  const spec = parsed.data;
  const missing: number[] = [];
  for (const series of spec.series) {
    for (const point of series.points) {
      if (!ledger.has(point.y)) missing.push(point.y);
    }
  }
  if (missing.length > 0) {
    const unique = [...new Set(missing)].slice(0, 5);
    throw new ChartRejected(
      `Diese Werte stehen in keinem Werkzeugergebnis dieses Turns: ${unique.join(", ")}. ` +
        "Nur belegte Zahlen verwenden.",
    );
  }

  for (const series of spec.series) {
    const seen = new Set<string>();
    for (const point of series.points) {
      const key = String(point.x);
      if (seen.has(key)) {
        throw new ChartRejected(`Doppelter x-Wert "${key}" in Serie "${series.name}".`);
      }
      seen.add(key);
    }
  }

  if (spec.type === "line" && spec.series.every((series) => series.points.length < 2)) {
    throw new ChartRejected("Eine Linie braucht mindestens zwei Datenpunkte.");
  }

  return spec;
}

/** Wandelt die schmale Spec in Vega-Lite. Die Web-App rendert nur noch. */
export function toVegaLite(spec: ChartSpec) {
  const values = spec.series.flatMap((series) =>
    series.points.map((point) => ({ x: point.x, y: point.y, series: series.name })),
  );
  const numericX = values.every((row) => typeof row.x === "number" || /^-?\d+(\.\d+)?$/.test(row.x));
  const xType = numericX ? "quantitative" : "nominal";

  if (spec.type === "table") {
    return {
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
      data: { values },
      mark: { type: "text", align: "left" },
      encoding: {
        x: { field: "series", type: "nominal", axis: { title: null } },
        y: { field: "x", type: "nominal", axis: { title: spec.xField } },
        text: { field: "y", type: "quantitative" },
      },
    };
  }

  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    title: spec.title,
    data: { values },
    mark: spec.type === "bar" ? { type: "bar", tooltip: true } : { type: "line", point: true, tooltip: true },
    encoding: {
      x: {
        field: "x",
        type: xType,
        axis: { title: spec.xField, labelAngle: numericX ? 0 : -45 },
        ...(spec.type === "bar" ? { sort: "-y" } : {}),
      },
      y: { field: "y", type: "quantitative", axis: { title: spec.yField } },
      ...(spec.series.length > 1 ? { color: { field: "series", type: "nominal" } } : {}),
    },
  };
}

export interface SparqlTable {
  vars: string[];
  rows: Record<string, string>[];
  source: string;
}

/**
 * Sicherheitsnetz: Wenn das Modell kein Diagramm liefert, bauen wir eines aus
 * der letzten Abfragetabelle. Es zeigt exakt die Zahlen aus dem Werkzeug, nichts
 * Erfundenes, und ist als automatisch erzeugt gekennzeichnet.
 */
export function autoChartFromTable(table: SparqlTable, ledger: NumberLedger): ChartSpec | null {
  const vars = table.vars.length > 0 ? table.vars : Object.keys(table.rows[0] ?? {});
  if (vars.length < 2 || table.rows.length < 2) return null;

  const scores = new Map<string, number>();
  for (const name of vars) {
    const numeric = table.rows.filter((row) => toNumber(row[name]) !== null).length;
    scores.set(name, numeric / table.rows.length);
  }

  const numericVars = vars.filter((name) => (scores.get(name) ?? 0) >= 0.8);
  if (numericVars.length === 0) return null;
  const isYear = (name: string): boolean =>
    table.rows.every((row) => {
      const value = (row[name] ?? "").trim();
      return /^\d{4}$/.test(value) && Number(value) >= 1800 && Number(value) <= 2100;
    });
  // Jahreszahlen sind Achse, nicht Messwert.
  const yVar = numericVars.find((name) => !isYear(name));
  if (!yVar) return null;
  const xVar =
    vars.find((name) => name !== yVar && (scores.get(name) ?? 1) < 0.5) ??
    vars.find((name) => name !== yVar && isYear(name)) ??
    vars.find((name) => name !== yVar);
  if (!xVar) return null;

  const byX = new Map<string, number>();
  for (const row of table.rows) {
    const label = cleanLabel(row[xVar] ?? "");
    const value = toNumber(row[yVar]);
    if (!label || value === null) continue;
    const previous = byX.get(label);
    byX.set(label, previous === undefined ? value : Math.max(previous, value));
  }
  if (byX.size < 2) return null;

  const points = [...byX.entries()].map(([x, y]) => ({ x, y }));
  const years = points.every((point) => /^\d{4}$/.test(point.x) && Number(point.x) > 1800);
  const type: ChartSpec["type"] = years && points.length >= 4 ? "line" : "bar";

  const ordered =
    type === "line"
      ? points.sort((left, right) => Number(left.x) - Number(right.x))
      : points.sort((right, left) => left.y - right.y);
  const limited = ordered.slice(0, 15);

  try {
    return buildChart(
      {
        type,
        title: `${yVar} nach ${xVar}`.slice(0, 120),
        xField: xVar,
        yField: yVar,
        series: [{ name: yVar, points: limited }],
        note: `Automatisch aus dem Ergebnis von ${table.source} erzeugt.`,
      },
      ledger,
    );
  } catch {
    return null;
  }
}

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const cleaned = raw.replace(/<[^>]*>/g, "").trim();
  const match = /^([+-]?\d[\d.,\s]*)/.exec(cleaned);
  if (!match?.[1]) return null;
  let token = match[1].replace(/\s/g, "");
  const lastComma = token.lastIndexOf(",");
  const lastDot = token.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    token = token.split(thousands).join("");
    if (decimal === ",") token = token.replace(",", ".");
  } else if (lastComma >= 0) {
    token = token.replace(",", ".");
  } else if (lastDot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(token)) {
    token = token.replace(/\./g, "");
  }
  const value = Number.parseFloat(token);
  return Number.isFinite(value) ? value : null;
}

function cleanLabel(raw: string): string {
  const text = raw
    .replace(/^https?:\/\/\S+\/([^/]+)$/, "$1")
    .replace(/_/g, " ")
    .trim();
  return text.length > 40 ? `${text.slice(0, 39)}...` : text;
}
