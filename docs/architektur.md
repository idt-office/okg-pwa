# Architektur und Entscheidungen

Dieses Dokument hält fest, warum der Aufbau so aussieht. Es ist kein Changelog,
sondern die Begründung der tragenden Entscheidungen, jeweils mit dem Messwert,
der sie ausgelöst hat.

## Rollen

- **PWA (Client)** im Browser, installierbar, Verlauf in IndexedDB.
- **BFF (Backend for Frontend)** hält den Key, spricht mit dem Gateway und den
  Wissensgraphen, streamt Fortschritt als SSE.
- **kiconnect.nrw** als OpenAI-kompatibles Modell.

Der BFF stellt bewusst **keine** OpenAI-kompatible API bereit. Damit können
`open-webui`, Cursor oder curl nicht andocken; es gibt genau einen Endpunkt
`POST /api/chat` für diese Oberfläche.

## Warum ein BFF überhaupt nötig ist

`chat.kiconnect.nrw` beantwortet den CORS-Preflight mit 401 und setzt keine
`access-control-*`-Header (gemessen mit `curl -X OPTIONS -H "Origin:
http://localhost:5173"`). Ein Browser kann dort nicht direkt hin, auch mit
gültigem Key nicht. Zusätzlich wäre ein Key im Browser-Bundle bei einer
installierbaren PWA für jeden lesbar.

Die Wissensgraphen sind dagegen aus dem Browser erreichbar:

```
query.wikidata.org/sparql          access-control-allow-origin: *
www.wikidata.org/w/api.php?origin=* access-control-allow-origin: *
lookup.dbpedia.org/api/search      access-control-allow-origin: <Origin>
dbpedia.org/sparql                 access-control-allow-origin: <Origin>
```

Sie laufen trotzdem über den BFF: Rate-Limit, ein Ort für Caching, ein Ort für
den User-Agent, den Wikidata verlangt.

## Arbeitsteilung der Quellen

Gemessen gegen die echten Endpunkte:

| Frage | Wikidata | DBpedia |
|---|---|---|
| BIP pro Kopf, Rangliste | `P2132` für 9 Länder | `dbp:gdpNominalPerCapita` für 820 Zeilen |
| BIP nominal, Länder | `P2131` + `P1082` für 191 Länder | `dbo:`-Äquivalent für 6 |
| Kernkraftwerke | 445 Instanzen von `Q134447` | – |
| Pumpspeicher DE | 42 Instanzen von `Q339353` | – |
| Prosa | `schema:description`, ein Satz | kein `dbo:abstract` im SPARQL-Endpunkt |
| Deutsche DBpedia | – | `de.dbpedia.org` nicht erreichbar (HTTP 000) |

Daraus die Regel im Prompt: **Wikidata für Struktur, Beziehungen und Zeitreihen,
DBpedia für Infobox-Zahlen, die Wikidata dünn hat.** Für „reichste Länder" ist
DBpedia die bessere Quelle, für fast alles andere Wikidata.

## Warum eine eigene Agentenschleife statt `createAgent`

`ChatOpenAI`, Tool-Binding, Message-Typen und Streaming kommen aus LangChain.
Die Schleife selbst ist eigen, weil drei Dinge harte Grenzen brauchen:

1. Zeitbudget pro Anfrage (16 s), nicht pro Modellaufruf.
2. Rundenobergrenze (4), damit ein Agent nicht beliebig weiterforscht.
3. Fortschritt als SSE-Ereignis, während er entsteht: der Nutzer sieht
   „wikidata_sparql läuft", nicht einen Spinner.

Dazu kommt `@langchain/core` 1.5, dessen `tool()` Zod-v3-Schemata erwartet,
während das Projekt Zod 4 nutzt. Die Werkzeuge sind deshalb als
JSON-Schema-Objekte definiert und werden über `bindTools` gebunden.

## Zahlen, die nicht erfunden werden dürfen

`NumberLedger` sammelt alle Zahlen, die in einem Turn aus Werkzeugen kamen.
`render_chart` prüft dagegen: ein y-Wert, der nicht im Ledger steht, wird
abgelehnt und das Modell muss korrigieren. Das ist die einzige harte Regel im
Prompt, die auch technisch durchgesetzt wird.

## Diagramm als Rückfallebene

Gemessen: mit 8 s und 3 Runden blieb keine Runde für das Diagramm; mit 5 Runden
und 18 s wurde es langsam und blieb unzuverlässig (dasselbe Modell lieferte bei
gleicher Frage einmal ein Diagramm, einmal nicht). Deshalb: das Modell darf
wählen, aber wenn es keines liefert, baut `autoChartFromTable` eines aus der
letzten zeichenbaren Abfragetabelle: Jahreszahlen als Linie, Ranglisten als
Balken, doppelte x-Werte auf den größten Wert verdichtet. Das Ergebnis ist als
„automatisch erzeugt" gekennzeichnet.

## SPARQL vom Modell, aber mit Zügel

Aggregationen (Ranglisten, Zählungen, Zeitreihen) lassen sich nicht in feste
Werkzeuge pressen. Das Modell schreibt die Abfrage, `guardSparql` prüft:

- nur `SELECT`/`ASK`,
- keine schreibenden Befehle (`INSERT`, `DELETE`, `CLEAR`, `DROP`, `LOAD`,
  `CREATE`, `ADD`, `MOVE`, `COPY`, `WITH`),
- `SERVICE` nur als `wikibase:label`,
- `LIMIT` wird ergänzt, wenn keins dasteht,
- Obergrenze 4000 Zeichen.

Die Prüfung arbeitet auf einer Fassung ohne IRIs, Literale und Kommentare, damit
weder `"DELETE ..."` in einem Label noch `#DROP` in einer IRI als Befehl zählt.

## Daten aus fremden Quellen sind Daten

Wikidata und DBpedia sind offen editierbar. Jede Werkzeugantwort steckt in einem
`<knowledge source="...">`-Block, und der System-Prompt sagt: Inhalt darin sind
Daten, keine Anweisungen. Kein Musterfilter, keine Heuristik; die Klammer ist
die Grenze, und sie ist im Test abgedeckt.

## Was bewusst nicht drin ist

- Keine Zeitreihen aus ENTSO-E oder dem Open Energy Data Server. Der Anschluss
  ist als weiteres Werkzeug vorgesehen, nicht gebaut.
- Keine Karte. `render_chart` kennt `bar`, `line` und `table`; ohne
  Koordinatenwerkzeug wäre eine Karte eine leere Versprechung.
- Kein Server-Verlauf, kein Login, kein Mehrbenutzerbetrieb. Der Verlauf liegt
  im Browser.
- Kein OpenAI-kompatibler Endpunkt für Dritte.
