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

describe("autoChartFromTable: Spaltenwahl", () => {
  const ledgerOf = (...values: number[]): NumberLedger => {
    const ledger = new NumberLedger();
    ledger.addFrom(values);
    return ledger;
  };

  it("nimmt die Label-Spalte statt der Q-ID-Achse", () => {
    const spec = autoChartFromTable(
      {
        vars: ["item", "itemLabel", "anzahl"],
        rows: [
          { item: "http://www.wikidata.org/entity/Q42", itemLabel: "Douglas Adams", anzahl: "7" },
          { item: "http://www.wikidata.org/entity/Q64", itemLabel: "Berlin", anzahl: "3" },
        ],
        source: "wikidata_sparql",
      },
      ledgerOf(7, 3),
    );
    expect(spec?.xField).toBe("itemLabel");
    expect(spec?.series[0]?.points).toEqual([
      { x: "Douglas Adams", y: 7 },
      { x: "Berlin", y: 3 },
    ]);
  });

  it("löst Q-IDs über die nachgeschlagenen Labels auf", () => {
    const spec = autoChartFromTable(
      {
        vars: ["plant", "leistung"],
        rows: [
          { plant: "http://www.wikidata.org/entity/Q1", leistung: "1400" },
          { plant: "http://www.wikidata.org/entity/Q2", leistung: "1060" },
        ],
        source: "wikidata_sparql",
        labels: { Q1: "Atdorf", Q2: "Goldisthal" },
      },
      ledgerOf(1400, 1060),
    );
    expect(spec?.series[0]?.points.map((point) => point.x)).toEqual(["Atdorf", "Goldisthal"]);
  });

  it("behandelt Datumsspalten als Achse, nicht als Messwert", () => {
    const spec = autoChartFromTable(
      {
        vars: ["start", "anzahl"],
        rows: [
          { start: "1990-01-01", anzahl: "5" },
          { start: "1991-01-01", anzahl: "6" },
          { start: "1992-01-01", anzahl: "7" },
          { start: "1993-01-01", anzahl: "8" },
        ],
        source: "wikidata_sparql",
      },
      ledgerOf(5, 6, 7, 8),
    );
    expect(spec?.yField).toBe("anzahl");
    expect(spec?.xField).toBe("start");
    expect(spec?.type).toBe("line");
  });

  it("erkennt Dezimaljahre als Achse", () => {
    const spec = autoChartFromTable(
      {
        vars: ["jahr", "anzahl"],
        rows: [
          { jahr: "1970.0", anzahl: "4" },
          { jahr: "1984.0", anzahl: "18" },
          { jahr: "1990.0", anzahl: "5" },
          { jahr: "2011.0", anzahl: "1" },
        ],
        source: "wikidata_sparql",
      },
      ledgerOf(4, 18, 5, 1),
    );
    expect(spec?.yField).toBe("anzahl");
    expect(spec?.type).toBe("line");
  });

  it("lässt sich von einer Rangspalte nicht die Messwertachse wegnehmen", () => {
    const spec = autoChartFromTable(
      {
        vars: ["nr", "land", "bip", "rang"],
        rows: [
          { nr: "1", land: "Monaco", bip: "315800", rang: "1" },
          { nr: "2", land: "Liechtenstein", bip: "207974", rang: "2" },
        ],
        source: "dbpedia_sparql",
      },
      ledgerOf(1, 315800, 207974, 2),
    );
    expect(spec?.yField).toBe("bip");
    expect(spec?.xField).toBe("land");
  });

  it("verwirft Indexspalten über die ganze Tabelle", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      nr: String(index + 1),
      land: `Land ${index + 1}`,
      wert: String(100 - index * 10),
    }));
    const spec = autoChartFromTable(
      { vars: ["nr", "land", "wert"], rows, source: "x" },
      ledgerOf(...rows.map((row) => Number(row.wert))),
    );
    expect(spec?.yField).toBe("wert");
  });

  it("akzeptiert Tausendertrenner konsistent zum Ledger", () => {
    const ledger = ledgerOf();
    ledger.addFrom("Markersbach 1 045,5 MW, Goldisthal 1 060 MW");
    const spec = autoChartFromTable(
      {
        vars: ["anlage", "leistung"],
        rows: [
          { anlage: "Markersbach", leistung: "1 045,5" },
          { anlage: "Goldisthal", leistung: "1 060" },
        ],
        source: "wikidata_sparql",
      },
      ledger,
    );
    expect(spec?.series[0]?.points).toEqual([
      { x: "Goldisthal", y: 1060 },
      { x: "Markersbach", y: 1045.5 },
    ]);
  });
});

describe("autoChartFromTable: Zeitreihe mit Kategorienspalte", () => {
  it("nimmt das Jahr als Achse, wenn die Kategorienspalte weniger Ausprägungen hat", () => {
    const rows = [];
    for (let year = 1960; year < 1980; year += 1) {
      rows.push({ jahr: String(year), type: "Druckwasser", anzahl: String(year - 1950) });
      rows.push({ jahr: String(year), type: "Siedewasser", anzahl: String(year - 1958) });
    }
    const ledger = new NumberLedger();
    ledger.addFrom(rows);
    const spec = autoChartFromTable(
      { vars: ["jahr", "type", "anzahl"], rows, source: "wikidata_sparql" },
      ledger,
    );
    expect(spec?.xField).toBe("jahr");
    expect(spec?.type).toBe("line");
    // Ein Verlauf darf nicht auf die ersten 15 Jahre gekürzt werden.
    expect(spec?.series[0]?.points).toHaveLength(20);
  });

  it("nimmt das Land als Achse, wenn es je Zeile einmal vorkommt", () => {
    const rows = [
      { land: "Monaco", jahr: "2022", bip: "315800" },
      { land: "Liechtenstein", jahr: "2022", bip: "207974" },
      { land: "Luxemburg", jahr: "2022", bip: "141079" },
    ];
    const ledger = new NumberLedger();
    ledger.addFrom(rows);
    const spec = autoChartFromTable(
      { vars: ["land", "jahr", "bip"], rows, source: "dbpedia_sparql" },
      ledger,
    );
    expect(spec?.xField).toBe("land");
    expect(spec?.yField).toBe("bip");
  });
});

describe("autoChartFromTable: Rückfallebene ohne Labels", () => {
  it("zeichnet auch mit Q-IDs, statt das Diagramm zu verlieren", () => {
    const ledger = new NumberLedger();
    ledger.addFrom([1400, 1060]);
    const spec = autoChartFromTable(
      {
        vars: ["plant", "leistung"],
        rows: [
          { plant: "http://www.wikidata.org/entity/Q1", leistung: "1400" },
          { plant: "http://www.wikidata.org/entity/Q2", leistung: "1060" },
        ],
        source: "wikidata_sparql",
      },
      ledger,
    );
    expect(spec).not.toBeNull();
    expect(spec?.series[0]?.points.map((point) => point.x)).toEqual(["Q1", "Q2"]);
  });
});

describe("autoChartFromTable: Gleichstand", () => {
  it("bevorzugt bei gleich vielen Ausprägungen die Namensspalte", () => {
    const rows = [
      { land: "Monaco", jahr: "2022", bip: "315800" },
      { land: "Luxemburg", jahr: "2020", bip: "141079" },
      { land: "Irland", jahr: "2021", bip: "108920" },
    ];
    const ledger = new NumberLedger();
    ledger.addFrom(rows);
    const spec = autoChartFromTable(
      { vars: ["land", "jahr", "bip"], rows, source: "dbpedia_sparql" },
      ledger,
    );
    expect(spec?.xField).toBe("land");
    expect(spec?.series[0]?.points.map((point) => point.x)).toContain("Monaco");
  });
});
