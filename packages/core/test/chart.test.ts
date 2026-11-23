import { describe, expect, it } from "vitest";
import { autoChartFromTable, buildChart, ChartRejected, toVegaLite } from "../src/chart.js";
import { NumberLedger } from "../src/ledger.js";

function ledgerWith(values: number[]): NumberLedger {
  const ledger = new NumberLedger();
  ledger.addFrom(values);
  return ledger;
}

const barSpec = {
  type: "bar" as const,
  title: "Pumpspeicher in Deutschland",
  xField: "Anlage",
  yField: "Leistung in MW",
  series: [
    {
      name: "Leistung",
      points: [
        { x: "Goldisthal", y: 1060 },
        { x: "Markersbach", y: 1045.5 },
      ],
    },
  ],
};

describe("buildChart", () => {
  it("akzeptiert ein Diagramm mit belegten Werten", () => {
    const spec = buildChart(barSpec, ledgerWith([1060, 1045.5]));
    expect(spec.series[0]?.points).toHaveLength(2);
  });

  it("weist Werte ab, die in keinem Werkzeugergebnis stehen", () => {
    expect(() => buildChart(barSpec, ledgerWith([1060]))).toThrow(ChartRejected);
    expect(() => buildChart(barSpec, ledgerWith([1060]))).toThrow(/1045.5/);
  });

  it("weist doppelte x-Werte ab", () => {
    const spec = {
      ...barSpec,
      series: [
        {
          name: "Leistung",
          points: [
            { x: "Goldisthal", y: 1060 },
            { x: "Goldisthal", y: 1045.5 },
          ],
        },
      ],
    };
    expect(() => buildChart(spec, ledgerWith([1060, 1045.5]))).toThrow(/Doppelter x-Wert/);
  });

  it("weist eine Linie mit nur einem Punkt ab", () => {
    const spec = {
      ...barSpec,
      type: "line" as const,
      series: [{ name: "Leistung", points: [{ x: "1984", y: 1060 }] }],
    };
    expect(() => buildChart(spec, ledgerWith([1060]))).toThrow(/mindestens zwei/);
  });

  it("erlaubt eine Tabelle mit einem Punkt", () => {
    const spec = {
      ...barSpec,
      type: "table" as const,
      series: [{ name: "Leistung", points: [{ x: "Goldisthal", y: 1060 }] }],
    };
    expect(buildChart(spec, ledgerWith([1060])).type).toBe("table");
  });

  it("weist mehr als drei Serien ab", () => {
    const series = [1, 2, 3, 4].map((index) => ({
      name: `S${index}`,
      points: [{ x: "a", y: 1060 }],
    }));
    expect(() => buildChart({ ...barSpec, series }, ledgerWith([1060]))).toThrow(ChartRejected);
  });

  it("weist einen unbekannten Typ ab", () => {
    expect(() => buildChart({ ...barSpec, type: "pie" }, ledgerWith([1060]))).toThrow(ChartRejected);
  });
});

describe("toVegaLite", () => {
  it("baut ein Balkendiagramm mit absteigender Sortierung", () => {
    const spec = buildChart(barSpec, ledgerWith([1060, 1045.5]));
    const vega = toVegaLite(spec) as {
      mark: { type: string };
      encoding: { x: { sort?: string; type: string } };
    };
    expect(vega.mark.type).toBe("bar");
    expect(vega.encoding.x.sort).toBe("-y");
  });

  it("erkennt numerische x-Werte als quantitativ", () => {
    const spec = buildChart(
      {
        ...barSpec,
        type: "line",
        series: [
          {
            name: "Stilllegungen",
            points: [
              { x: 2011, y: 5 },
              { x: 2019, y: 5 },
            ],
          },
        ],
      },
      ledgerWith([2011, 5, 2019]),
    );
    const vega = toVegaLite(spec) as { encoding: { x: { type: string } } };
    expect(vega.encoding.x.type).toBe("quantitative");
  });

  it("setzt Farbe nur bei mehreren Serien", () => {
    const single = toVegaLite(buildChart(barSpec, ledgerWith([1060, 1045.5]))) as {
      encoding: { color?: unknown };
    };
    expect(single.encoding.color).toBeUndefined();

    const multi = toVegaLite(
      buildChart(
        {
          ...barSpec,
          series: [
            { name: "A", points: [{ x: "a", y: 1060 }] },
            { name: "B", points: [{ x: "b", y: 1045.5 }] },
          ],
        },
        ledgerWith([1060, 1045.5]),
      ),
    ) as { encoding: { color?: { field: string } } };
    expect(multi.encoding.color?.field).toBe("series");
  });
});

describe("autoChartFromTable", () => {
  const ledgerOf = (values: number[]): NumberLedger => {
    const ledger = new NumberLedger();
    ledger.addFrom(values);
    return ledger;
  };

  it("macht aus Jahres-Werten eine Linie", () => {
    const spec = autoChartFromTable(
      {
        vars: ["jahr", "anzahl"],
        rows: [
          { jahr: "1984", anzahl: "18" },
          { jahr: "1970", anzahl: "4" },
          { jahr: "1990", anzahl: "5" },
          { jahr: "2011", anzahl: "1" },
        ],
        source: "wikidata_sparql",
      },
      ledgerOf([18, 4, 5, 1]),
    );
    expect(spec?.type).toBe("line");
    expect(spec?.series[0]?.points.map((point) => point.x)).toEqual([1970, 1984, 1990, 2011].map(String));
  });

  it("macht aus einer Rangliste einen Balken, absteigend", () => {
    const spec = autoChartFromTable(
      {
        vars: ["land", "bip"],
        rows: [
          { land: "Monaco", bip: "315800" },
          { land: "Liechtenstein", bip: "207974" },
          { land: "Luxemburg", bip: "141079" },
        ],
        source: "dbpedia_sparql",
      },
      ledgerOf([315800, 207974, 141079]),
    );
    expect(spec?.type).toBe("bar");
    expect(spec?.series[0]?.points[0]).toEqual({ x: "Monaco", y: 315800 });
  });

  it("behält bei doppelten x-Werten den größten Wert", () => {
    const spec = autoChartFromTable(
      {
        vars: ["land", "wert"],
        rows: [
          { land: "Monaco", wert: "300" },
          { land: "Monaco", wert: "315" },
          { land: "Irland", wert: "108" },
        ],
        source: "dbpedia_sparql",
      },
      ledgerOf([300, 315, 108]),
    );
    expect(spec?.series[0]?.points).toHaveLength(2);
    expect(spec?.series[0]?.points.find((point) => point.x === "Monaco")?.y).toBe(315);
  });

  it("versteht Dezimalkommas", () => {
    const spec = autoChartFromTable(
      {
        vars: ["anlage", "leistung"],
        rows: [
          { anlage: "Markersbach", leistung: "1.045,5" },
          { anlage: "Goldisthal", leistung: "1060" },
        ],
        source: "wikidata_sparql",
      },
      ledgerOf([1045.5, 1060]),
    );
    expect(spec?.series[0]?.points.find((point) => point.x === "Markersbach")?.y).toBe(1045.5);
  });

  it("gibt null zurück, wenn nichts zeichenbar ist", () => {
    const ledger = ledgerOf([1, 2]);
    expect(autoChartFromTable({ vars: ["a"], rows: [{ a: "1" }], source: "x" }, ledger)).toBeNull();
    expect(
      autoChartFromTable(
        { vars: ["name", "text"], rows: [{ name: "a", text: "b" }, { name: "c", text: "d" }], source: "x" },
        ledger,
      ),
    ).toBeNull();
  });
});
