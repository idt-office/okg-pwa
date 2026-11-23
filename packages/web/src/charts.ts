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
    await embed(canvas, toVegaLite(spec) as never, {
      actions: false,
      renderer: "svg",
    });
  } catch (error) {
    figure.innerHTML = "";
    const fallback = document.createElement("table");
    fallback.className = "chart-fallback";
    const head = document.createElement("tr");
    head.innerHTML = `<th>${spec.xField}</th><th>${spec.yField}</th>`;
    fallback.append(head);
    for (const point of spec.series[0]?.points ?? []) {
      const row = document.createElement("tr");
      const x = document.createElement("td");
      x.textContent = String(point.x);
      const y = document.createElement("td");
      y.textContent = String(point.y);
      row.append(x, y);
      fallback.append(row);
    }
    figure.append(fallback);
    const note = document.createElement("figcaption");
    note.textContent = `Diagramm nicht renderbar (${error instanceof Error ? error.message : "Fehler"}), Daten als Tabelle.`;
    figure.append(note);
  }
}
