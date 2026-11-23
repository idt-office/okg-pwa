import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown } from "../src/markdown.js";

describe("renderMarkdown", () => {
  it("maskiert HTML, statt es durchzureichen", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> und <script>alert(2)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("rendert fett und Code", () => {
    expect(renderMarkdown("Das ist **wichtig** und `code`.")).toBe(
      "<p>Das ist <strong>wichtig</strong> und <code>code</code>.</p>",
    );
  });

  it("rendert Listen", () => {
    const html = renderMarkdown("- eins\n- zwei");
    expect(html).toBe("<ul><li>eins</li><li>zwei</li></ul>");
  });

  it("rendert nummerierte Listen", () => {
    const html = renderMarkdown("1. eins\n2. zwei");
    expect(html).toBe("<ol><li>eins</li><li>zwei</li></ol>");
  });

  it("rendert Tabellen aus der Modellantwort", () => {
    const html = renderMarkdown("| Land | Wert |\n|---|---|\n| Monaco | 315800 |");
    expect(html).toContain("<th>Land</th>");
    expect(html).toContain("<td>Monaco</td>");
    expect(html).toContain("<td>315800</td>");
  });

  it("rendert Codeblöcke", () => {
    const html = renderMarkdown("```sparql\nSELECT ?x\n```");
    expect(html).toBe("<pre><code>SELECT ?x</code></pre>");
  });

  it("behandelt Sternchen in Fließtext nicht als Kursiv", () => {
    expect(renderMarkdown("2 * 3 = 6")).toBe("<p>2 * 3 = 6</p>");
  });
});

describe("escapeHtml", () => {
  it("maskiert alle fünf Zeichen", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
