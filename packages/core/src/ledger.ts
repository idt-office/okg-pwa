/**
 * Sammlung aller Zahlen, die in diesem Turn aus Werkzeugen kamen. Der
 * Chart-Validator prüft dagegen, damit das Modell keine Zahlen in ein Diagramm
 * schreiben kann, die nirgends belegt sind.
 */
export class NumberLedger {
  private readonly values: number[] = [];

  addFrom(payload: unknown): void {
    this.walk(payload, 0);
  }

  has(value: number): boolean {
    if (!Number.isFinite(value)) return false;
    const tolerance = Math.max(1e-9, Math.abs(value) * 1e-6);
    return this.values.some((known) => Math.abs(known - value) <= tolerance);
  }

  get size(): number {
    return this.values.length;
  }

  private walk(payload: unknown, depth: number): void {
    if (depth > 12 || payload === null || payload === undefined) return;
    if (typeof payload === "number") {
      if (Number.isFinite(payload)) this.values.push(payload);
      return;
    }
    if (typeof payload === "string") {
      this.addFromText(payload);
      return;
    }
    if (Array.isArray(payload)) {
      for (const item of payload) this.walk(item, depth + 1);
      return;
    }
    if (typeof payload === "object") {
      for (const item of Object.values(payload as Record<string, unknown>)) {
        this.walk(item, depth + 1);
      }
    }
  }

  private addFromText(text: string): void {
    const cleaned = text
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/\b[QP]\d+\b/g, " ")
      .replace(/\b\d{4}-\d{2}-\d{2}T[\d:+-]+Z?\b/g, " ");
    for (const match of cleaned.matchAll(/-?\d+(?:[.,]\d+)?/g)) {
      const raw = match[0].replace(",", ".");
      const value = Number.parseFloat(raw);
      if (Number.isFinite(value)) this.values.push(value);
    }
  }
}
