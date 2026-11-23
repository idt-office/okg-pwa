import { describe, expect, it } from "vitest";
import { NumberLedger } from "../src/ledger.js";

describe("NumberLedger", () => {
  it("sammelt Zahlen aus verschachtelten Objekten", () => {
    const ledger = new NumberLedger();
    ledger.addFrom({ rows: [{ year: "1984", value: "18" }] });
    expect(ledger.has(1984)).toBe(true);
    expect(ledger.has(18)).toBe(true);
    expect(ledger.has(17)).toBe(false);
  });

  it("ignoriert URLs und Wikidata-IDs", () => {
    const ledger = new NumberLedger();
    ledger.addFrom("http://www.wikidata.org/entity/Q64 und Q339353");
    expect(ledger.has(64)).toBe(false);
    expect(ledger.has(339353)).toBe(false);
  });

  it("findet Zahlen in Text mit Einheit", () => {
    const ledger = new NumberLedger();
    ledger.addFrom("Goldisthal 1060 MW, Markersbach 1045,5 MW");
    expect(ledger.has(1060)).toBe(true);
    expect(ledger.has(1045.5)).toBe(true);
  });

  it("vergleicht mit Toleranz, nicht auf Bitgleichheit", () => {
    const ledger = new NumberLedger();
    ledger.addFrom([315800]);
    expect(ledger.has(315800.0000001)).toBe(true);
    expect(ledger.has(315801)).toBe(false);
  });

  it("verwirft NaN und Infinity", () => {
    const ledger = new NumberLedger();
    ledger.addFrom([Number.NaN, Number.POSITIVE_INFINITY]);
    expect(ledger.size).toBe(0);
    expect(ledger.has(Number.NaN)).toBe(false);
  });
});
