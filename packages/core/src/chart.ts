import { z } from "zod";
import { parseDbpediaNumber } from "./dbpedia.js";
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
  const numericX = values.every(
    (row) => typeof row.x === "number" || /^-?\d+(\.\d+)?$/.test(row.x),
  );
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
    mark:
      spec.type === "bar"
        ? { type: "bar", tooltip: true }
        : { type: "line", point: true, tooltip: true },
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
  /** Nachgeschlagene Labels für Q-IDs, damit die Achse Namen statt Kürzel zeigt. */
  labels?: Record<string, string>;
}

const MEASURE_HINT =
  /(anzahl|count|wert|value|leistung|kapazit|capacity|bip|gdp|population|einwohner|summe|total|menge|prozent|percent|share|anteil|umsatz|produktion|emission|hoehe|height|flaeche|area)/i;
const LABEL_HINT = /(label|name|titel|title|land|country|stadt|city|anlage|plant|entity|item)/i;
const INDEX_NAME = /^(nr|no|index|rang|rank|id|position|pos)$/i;
// Eine blanke vierstellige Zahl ist nur dann ein Jahr, wenn die Spalte so heisst.
// Sonst wuerde jede Leistung in MW (1400) zur Zeitachse.
const YEAR_OR_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?(?:\.0+)?$/;
const DATE_WITH_SEPARATOR = /^\d{4}-\d{2}(?:-\d{2})?/;
const YEARISH_NAME = /(jahr|year|datum|date|zeit|time|periode|period|dekade|decade)/i;

interface Column {
  name: string;
  numeric: number;
  label: number;
  iri: number;
  yearish: boolean;
  indexish: boolean;
  /** Spannweite der Zahlenwerte, als Tie-Break für die Messwertspalte. */
  spread: number;
}

function describeColumns(table: SparqlTable): Column[] {
  const rows = table.rows;
  return table.vars.map((name) => {
    let numeric = 0;
    let label = 0;
    let iri = 0;
    let everyValueYearish = true;
    let everyValueDate = true;
    for (const row of rows) {
      const raw = (row[name] ?? "").trim();
      if (!raw) continue;
      // IRIs sind keine Zahlen, auch wenn am Ende eine Ziffer steht.
      if (/^(https?:\/\/|Q\d+$|P\d+$)/.test(raw)) {
        iri += 1;
      } else {
        if (parseDbpediaNumber(raw) !== null) numeric += 1;
        if (raw.length >= 2 && raw.length <= 60) label += 1;
      }
      if (!YEAR_OR_DATE.test(raw)) everyValueYearish = false;
      if (!DATE_WITH_SEPARATOR.test(raw)) everyValueDate = false;
    }
    const yearish =
      rows.length > 1 &&
      ((everyValueYearish && YEARISH_NAME.test(name)) || everyValueDate);
    const total = Math.max(1, rows.length);
    const values = rows.map((row) => (row[name] ?? "").trim());
    const numbers = rows
      .map((row) => parseDbpediaNumber(row[name] ?? ""))
      .filter((value): value is number => value !== null);
    const spread =
      numbers.length > 0 ? Math.max(...numbers) - Math.min(...numbers) : 0;
    const integers = values.map((value) => Number.parseInt(value, 10));
    const indexish =
      INDEX_NAME.test(name) ||
      (integers.every((value, index) => Number.isFinite(value) && value === index + 1) &&
        values.length > 2);
    return {
      name,
      numeric: numeric / total,
      label: label / total,
      iri: iri / total,
      yearish,
      indexish,
      spread,
    };
  });
}

/**
 * Sicherheitsnetz: Wenn das Modell kein Diagramm liefert, bauen wir eines aus
 * einer Abfragetabelle. Es zeigt exakt die Zahlen aus dem Werkzeug.
 */
export function autoChartFromTable(table: SparqlTable, ledger: NumberLedger): ChartSpec | null {
  const columns = describeColumns(table);
  if (columns.length < 2 || table.rows.length < 2) return null;

  const measureCandidates = columns.filter(
    (column) => column.numeric >= 0.8 && !column.yearish && !column.indexish,
  );
  const yColumn =
    measureCandidates.find((column) => MEASURE_HINT.test(column.name)) ??
    measureCandidates.sort((left, right) => right.spread - left.spread)[0];
  if (!yColumn) return null;

  const others = columns.filter((column) => column.name !== yColumn.name);
  // Achse: echte Namen vor IRIs, Jahreszahlen als Linienachse.
  const labelCandidates = others
    .filter((column) => column.label > 0.5 && column.numeric < 0.5 && column.iri < 0.5)
    .sort((left, right) => {
      const hintLeft = LABEL_HINT.test(left.name) ? 1 : 0;
      const hintRight = LABEL_HINT.test(right.name) ? 1 : 0;
      return hintRight - hintLeft || right.label - left.label;
    });
  const yearColumn = others.find((column) => column.yearish);
  const labelColumn = labelCandidates[0];
  // Achse ist die Spalte mit den meisten Ausprägungen: bei einer Rangliste das
  // Land, bei einer Zeitreihe mit Kategorienspalte das Jahr.
  const xColumn =
    yearColumn && labelColumn
      ? distinctCount(table, yearColumn.name) >= distinctCount(table, labelColumn.name)
        ? yearColumn
        : labelColumn
      : (labelColumn ?? yearColumn ?? others[0]);
  if (!xColumn) return null;

  const byX = new Map<string, number>();
  for (const row of table.rows) {
    const label = resolveLabel(row[xColumn.name] ?? "", table.labels);
    const value = parseDbpediaNumber(row[yColumn.name] ?? "");
    if (!label || value === null) continue;
    const previous = byX.get(label);
    byX.set(label, previous === undefined ? value : Math.max(previous, value));
  }
  if (byX.size < 2) return null;

  const points = [...byX.entries()].map(([x, y]) => ({ x, y }));
  const lineLike =
    xColumn.yearish || points.every((point) => YEAR_OR_DATE.test(point.x) && Number(point.x) > 1800);
  const type: ChartSpec["type"] = lineLike && points.length >= 4 ? "line" : "bar";

  const ordered =
    type === "line"
      ? points.sort((left, right) => Number(left.x) - Number(right.x))
      : points.sort((right, left) => left.y - right.y);
  // Eine Linie verliert durch Top-15 ihren Verlauf; dort nur gleichmäßig kürzen.
  const limited = type === "line" ? ordered.slice(0, 60) : ordered.slice(0, 15);

  try {
    return buildChart(
      {
        type,
        title: `${yColumn.name} nach ${xColumn.name}`.slice(0, 120),
        xField: xColumn.name,
        yField: yColumn.name,
        series: [{ name: yColumn.name, points: limited }],
        note: `Automatisch aus dem Ergebnis von ${table.source} erzeugt.`,
      },
      ledger,
    );
  } catch {
    return null;
  }
}

function distinctCount(table: SparqlTable, name: string): number {
  return new Set(table.rows.map((row) => (row[name] ?? "").trim())).size;
}

function resolveLabel(raw: string, labels: Record<string, string> | undefined): string {
  const id = /(?:^|\/)([QP]\d+)$/.exec(raw.trim())?.[1];
  if (id) {
    const label = labels?.[id];
    return label ? shorten(label) : "";
  }
  const text = raw
    .replace(/^https?:\/\/\S+\/([^/]+)$/, "$1")
    .replace(/_/g, " ")
    .trim();
  return text ? shorten(text) : "";
}

function shorten(text: string): string {
  return text.length > 40 ? `${text.slice(0, 39)}...` : text;
}
