# Erkenntnisse

Was beim Bau und in sieben Review-Runden gemessen wurde, was nicht funktioniert
hat, und welche Fäden offen sind. Die Begründung des Aufbaus steht in
[architektur.md](architektur.md); hier stehen die Beobachtungen, die man beim
Weiterbauen sonst neu machen müsste.

Stand: 2026-11-24.

## Endpunkt und Betrieb

- `chat.kiconnect.nrw` beantwortet den CORS-Preflight mit 401 und setzt keine
  `access-control-*`-Header. Ein Browser kann dort nicht direkt hin, auch mit
  gültigem Key nicht; deshalb der BFF.
- Vorhandene Modelle: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
  `mistralai-mistral-small-4-119b-2603`, `openai-gpt-oss-120b` (Default),
  `qwen-qwen3-8-27b`, `qwen-qwen3-embedding-8b`.
- `gpt-5.x` weist `max_tokens` ab und braucht `max_completion_tokens`. Wer die
  Modellliste erweitert, muss beide Formen bedienen.
- Die Antwortqualität hängt stark am Modell: `gpt-oss-120b` wählt zuverlässig
  die kuratierten Werkzeuge, `qwen-qwen3-8-27b` ist schneller, braucht aber
  mehr Führung im Prompt.

## Wikidata: was trägt und was nicht

- WDQS drosselt aggressiv: nach vielen Abfragen pro Minute kommt HTTP 429. Der
  Client wiederholt dann nicht, sondern weist auf die Drosselung hin.
- Einfache Abfragen antworten warm in 0,1 bis 0,5 s, teure Aggregationen
  brauchen bis 12 s. Tiefe Pfade (`wdt:P31/wdt:P279*`) laufen in die
  Zeitüberschreitung.
- `P2132` (BIP pro Kopf) deckt nur neun Länder ab und ist für eine Rangliste
  unbrauchbar. Das ist der Hauptgrund, warum DBpedia überhaupt im Spiel ist.
- Zeitreihen funktionieren über Ereignisse: `P729` (Inbetriebnahme) und `P730`
  (Stilllegung) mit `BIND(YEAR(?datum) AS ?jahr)` und `GROUP BY ?jahr`. Eine
  Bestandsrekonstruktion pro Jahr aus Ereignissen ist dagegen falsch und steht
  so im Prompt.
- Der Label-Dienst muss innerhalb der WHERE-Klammer stehen; Zählungen mit
  Labels außerhalb des Aggregats enden in "Bad aggregate". Beides sind
  Modellfehler, keine Endpunktfehler, und kosten je Lauf eine Runde.

## DBpedia: Datenqualität ist der eigentliche Aufwand

- Über SPARQL gibt es **kein** `dbo:abstract` (gemessen: `ASK` = false). Prosa
  nur über die Lookup-API.
- Infobox-Zahlen sind Strings mit Einheiten und Kommas, teils mehrfach pro
  Land (`Monaco` dreimal). `dbpedia_ranking` castet numerisch, gruppiert und
  dedupliziert; eine freie Abfrage sortiert sonst lexikografisch.
- `?item a dbo:Country` enthält auch Verbände: die EFTA stand als fünftes Land
  in der BIP-Rangliste. `FILTER EXISTS { ?item dbo:capital ?capital }` löst
  das (EFTA hat keine Hauptstadt, Monaco hat eine).
- BIP pro Kopf, gemessen: Monaco 315 800, Liechtenstein 207 974, Luxemburg
  141 079, Irland 108 920, Schweiz 104 896.
- `dbo:populationTotal` enthält historische Staaten und Unsinnswerte
  (Afsharid Iran 90 000 006 000 000). `dbo:dissolutionDate` und
  `dbp:iso3166code` filtern das nicht sauber weg. Bevölkerung kommt deshalb aus
  Wikidata (`P1082`), der Prompt sagt das, aber kein e2e-Fall prüft diesen Weg.
- Kalt bis 16 s, warm unter 2 s. Die deutsche DBpedia ist nicht erreichbar
  (HTTP 000).
- Der Endpunkt setzt einzelne Verbindungen aus: `fetch failed`, Sekunden später
  wieder HTTP 200. Die Namensauflösung lieferte in dieser Messung nur eine
  IPv6-Adresse (`2a12:4180:dc1:903::2`), was zu den sekundenweisen Aussetzern
  passen würde. Der Client versucht es dreimal (1,2 s und 3 s Pause); bleibt es
  dabei, sagt die Antwort den Ausfall.

## Modellverhalten, das man einplanen muss

- Freies SPARQL ist die Fehlerquelle: das Modell sortierte BIP-Strings
  lexikografisch ("Australien 54 348" als Spitze), produzierte "Bad aggregate"
  und stellte `SERVICE wikibase:label` hinter die WHERE-Klammer. Jeder dieser
  Fehler kostet eine Runde.
- Q-IDs werden geraten, wenn sie nicht im Werkzeugergebnis stehen: im Lauf
  stand "Liechtenstein Q233" in der Quellenzeile, Q233 ist Malta (Q347 wäre
  richtig). Der Prompt verbietet das jetzt ausdrücklich, erzwungen ist es
  nicht.
- Das Modell behauptet Diagramme, die es nicht gibt ("Das Balkendiagramm
  zeigt ..."), wenn die Chart-Erzeugung scheitert.
- Bei einem Ausfall einer Quelle neigt es zu einer Ersatzrangliste aus der
  lückenhaften anderen Quelle. Der Fehlerhinweis muss das ausdrücklich
  verbieten, sonst entsteht aus einem Netzfehler eine falsche Antwort.
- Mit 22 s Budget und 4 Runden kippten Abnahmeläufe; 26 s mit 14 s (Wikidata)
  und 20 s (DBpedia) je Abfrage und 2,5 s Reserve tragen.

## Was sich bewährt hat

- **Kuratierte Werkzeuge vor freiem SPARQL.** `wikidata_ranking`,
  `wikidata_timeline` und `dbpedia_ranking` bauen ihre Abfrage selbst, prüfen
  die IDs (`^Q\d+$`, `^P\d+$`, `^dbp:...$`), sortieren numerisch und
  deduplizieren. Freies SPARQL bleibt Notausgang.
- **Fehlertext lesbar machen.** WDQS stellt dem Rumpf `SPARQL-QUERY: queryStr=`
  voran; ein 300-Zeichen-Schnitt verliert die Ursache. `cleanEndpointError`
  schneidet ab der Exception, `correctionHint` nennt die konkrete Korrektur.
  Erst danach wurden die Abnahmeläufe stabil.
- **Zahlen-Ledger plus Diagrammprüfung.** Ein y-Wert, der nicht aus einem
  Werkzeugergebnis stammt, wird abgelehnt; `autoChartFromTable` baut sonst ein
  Diagramm aus der Abfragetabelle.
- **Eigene Tags statt einer Klammer.** `<knowledge>` trägt nur
  Wissensgraph-Daten, `<tool-error>` Fehler, Systemmeldungen ohne Tag. Beide
  Tags werden in beiden Blöcken maskiert.
- **Abnahmetest auf Inhalt, nicht auf Form.** Eine Prüfung "Monaco kommt vor"
  winkte "Australien 54 348 ... (z. B. Luxemburg fehlt)" durch. Der Test prüft
  jetzt Platz 1 und ob eine Antwort ein Diagramm behauptet, das nicht existiert.

## Offene Fäden

1. **DBpedia-Rückfallebene.** Ein datierter Snapshot der BIP-Rangliste (mit
   sichtbarem Datum) würde die Demo über einen Aussetzer hinweg tragen. Bewusst
   nicht eingebaut, weil er still veraltete Zahlen liefert.
2. **ENTSO-E oder Open Energy Data Server** als Werkzeug. Wikidata hat keine
   Stromverbrauchs-Property; der Anschluss ist vorgesehen, nicht gebaut.
3. **Browsertests.** Chart-Rendering (`renderChartInto`) und die Reset-Logik
   haben keinen DOM-Test; beide wurden nur im Browser geprüft.
4. **Bevölkerungsweg.** `wikidata_ranking` mit `P1082` ist in keinem e2e-Fall
   abgedeckt, und `dbpedia_ranking(dbo:populationTotal)` liefert weiter Unsinn.
5. **Client-Adresse hinter dem Container.** Ob `getConnInfo` hinter dem
   Podman-Portmapping die echte Adresse sieht, ist ungemessen; `TRUST_PROXY`
   ist dokumentiert.
6. **Lizenz.** Das Repo ist öffentlich, hat aber keine `LICENSE`. Ohne Lizenz
   gilt "alle Rechte vorbehalten".
7. **Alte Commit-SHAs.** Nach dem Umschreiben der Autorschaft können die alten
   SHAs auf GitHub bis zur Garbage Collection unter direkter URL abrufbar sein.

## Arbeitsweise, die sich gelohnt hat

- Sieben adversarial geführte Review-Runden fanden fast immer den Fehler im
  Fehlerpfad, nicht im Hauptpfad: Ausfall ohne Hinweis, Fehlermeldung ohne
  Ursache, Test ohne Inhalt. Wer weiterbaut, prüft zuerst den Pfad, den ein
  Vorführender selten auslöst.
- Gegenproben schlagen Zusicherungen: "jede gültige Abfrage bleibt gültig",
  "jede Werkzeugantwort ist markiert", "der Cache liefert Kopien". Jede dieser
  Zusagen war einmal falsch, ohne dass ein Test es merkte.

## Wo man ansetzt

| Vorhaben | Datei |
|---|---|
| Werkzeug hinzufügen | `packages/core/src/tools.ts` (`toolDefs`, Dispatcher, `executeTool`) |
| SPARQL-Grenzen | `packages/core/src/sparql.ts` (`guardSparql`, Cache, Retry) |
| Prompt und Quellenzuständigkeit | `packages/core/src/prompt.ts` |
| Budget und Runden | `packages/core/src/config.ts` |
| Diagrammwahl | `packages/core/src/chart.ts` |
| Abnahmefälle | `scripts/e2e.ts` |
| SSE und Routen | `packages/bff/src/app.ts` |
| Oberfläche | `packages/web/src/main.ts` |
