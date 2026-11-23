import { toVegaLite, type ChartSpec } from "@okg/core/chart";

/** Vega wird erst beim ersten Diagramm geladen; die Chat-Oberfläche bleibt leicht. */
export async function renderChartInto(container: HTMLElement, spec: ChartSpec): Promise<void> {
  container.innerHTML = "";
  const figure = document.createElement("figure");
  figure.className = "chart";
  const canvas = document.createElement("div");
  figure.append(canvas);

  if (spec.note) {
    const note = document.createElement("figcaption");
    note.textContent = spec.note;
    figure.append(note);
  }
  container.append(figure);

  try {
    const { default: embed } = await import("vega-embed");
    const liteSpec = toVegaLite(spec) as Parameters<typeof embed>[1];
    await embed(canvas, liteSpec, { actions: false, renderer: "svg" });
  } catch (error) {
    figure.replaceChildren();
    figure.append(fallbackTable(spec));
    const note = document.createElement("figcaption");
    note.textContent = `Diagramm nicht renderbar (${
      error instanceof Error ? error.message : "Fehler"
    }), Daten als Tabelle.`;
    figure.append(note);
  }
}

/** Tabellenrückfall ohne innerHTML: Spaltentitel kommen vom Modell. */
function fallbackTable(spec: ChartSpec): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "chart-fallback";

  const head = document.createElement("tr");
  for (const title of [spec.xField, spec.yField]) {
    const cell = document.createElement("th");
    cell.textContent = title;
    head.append(cell);
  }
  table.append(head);

  for (const point of spec.series[0]?.points ?? []) {
    const row = document.createElement("tr");
    for (const value of [String(point.x), String(point.y)]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    table.append(row);
  }
  return table;
}
