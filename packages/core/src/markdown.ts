/**
 * Minimaler Markdown-Renderer für Modellantworten. Bewusst klein: Tabellen,
 * Listen, Code, fett. Alles wird zuerst maskiert, damit Modelltext kein HTML
 * einschleusen kann.
 */
export function renderMarkdown(input: string): string {
  const escaped = escapeHtml(input.replace(/\r\n/g, "\n"));
  const blocks = escaped.split(/\n{2,}/);
  const out: string[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    const trimmed = block.trim();
    if (!trimmed) continue;

    if (/^```/.test(trimmed)) {
      const code = trimmed.replace(/^```[^\n]*\n?/, "").replace(/```$/, "").replace(/\n$/, "");
      out.push(`<pre><code>${code}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(4, (heading[1] ?? "#").length);
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      continue;
    }

    if (isTable(lines)) {
      out.push(renderTable(lines));
      continue;
    }

    if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
      const items = lines.map((line) => `<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
      const items = lines.map((line) => `<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
  }

  return out.join("\n");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "<em>$1</em>");
}

function isTable(lines: string[]): boolean {
  return (
    lines.length >= 2 &&
    /^\s*\|.*\|\s*$/.test(lines[0] ?? "") &&
    /^\s*\|[\s:|-]+\|\s*$/.test(lines[1] ?? "")
  );
}

function renderTable(lines: string[]): string {
  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  const head = cells(lines[0] ?? "");
  const body = lines.slice(2).map(cells);
  const headHtml = head.map((cell) => `<th>${inline(cell)}</th>`).join("");
  const bodyHtml = body
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}
