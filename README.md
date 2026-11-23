# OKG Chat

PWA-Chat, dessen Prompt vor dem Modellaufruf mit Wikidata und DBpedia
angereichert wird. Das Modell bekommt Werkzeuge, sucht Entitäten, schreibt
SPARQL, zählt und zeichnet Grafiken. Jede Zahl in der Antwort stammt aus einem
Werkzeugergebnis desselben Turns.

```
Browser (PWA)  --POST /api/chat-->  BFF  --ChatOpenAI-->  kiconnect.nrw
                                     |
                                     +--> query.wikidata.org
                                     +--> dbpedia.org/sparql, lookup.dbpedia.org
```

## Starten

```bash
cp .env.example .env       # KICONNECT_API_KEY eintragen
npm install
npm run dev                # BFF auf 8787, Vite auf 5173
```

Oder als Container:

```bash
podman build -t okg-pwa .
podman run --rm -p 8080:8787 --env-file .env okg-pwa
```

Die PWA lässt sich nur über `localhost` oder HTTPS installieren; ein Aufruf über
`http://<lan-ip>` zeigt die App, aber ohne Installationsangebot. Das ist eine
Browser-Regel, keine Einstellung.

## Endpunkte

| Pfad | Zweck |
|---|---|
| `POST /api/chat` | Chatlauf als Server-Sent Events (`token`, `tool`, `chart`, `sources`, `done`, `error`) |
| `GET /api/health` | Modell, Endpunkt, Budget |
| `GET /api/models` | Modellliste des Gateways, 60 s zwischengespeichert |

Der BFF ist kein öffentlicher OpenAI-Proxy: es gibt bewusst kein
`/v1/chat/completions`. Der Key bleibt serverseitig, der Browser sieht ihn nie.
Ein Rate-Limit von 15 Anfragen pro Minute schützt den geteilten Gateway-Key. Es
greift auf der Socket-Adresse; steht der BFF hinter einem Reverse Proxy, mit
`TRUST_PROXY=1` auf `x-forwarded-for` umschalten.

## Konfiguration

| Variable | Standard | Bedeutung |
|---|---|---|
| `KICONNECT_BASE_URL` | `https://chat.kiconnect.nrw/api/v1` | OpenAI-kompatibler Endpunkt |
| `KICONNECT_API_KEY` | – | Pflicht, nur im Backend |
| `OKG_MODEL` | `openai-gpt-oss-120b` | Modell mit Tool-Calling |
| `OKG_MAX_ROUNDS` | `4` | Obergrenze der Werkzeugrunden |
| `OKG_BUDGET_MS` | `26000` | Zeitbudget der Werkzeugrunden |
| `OKG_FINAL_ANSWER_MS` | `15000` | Zusatzfrist für die Schlussantwort, wenn das Budget im Werkzeuglauf verbraucht wurde |
| `PORT` | `8787` | Port des BFF |
| `TRUST_PROXY` | – | `1` vertraut `x-forwarded-for` (nur hinter eigenem Proxy) |

## Werkzeuge

| Werkzeug | Quelle | Rolle |
|---|---|---|
| `wikidata_search` | `wbsearchentities` | Begriff zu Q-IDs, mit Oberklassen zur Auswahl |
| `wikidata_entity` | `wbgetentities` | Fakten einer Entität, Mengen mit Einheit, Zeitangaben |
| `wikidata_ranking` | `query.wikidata.org` | Rangliste einer Klasse nach Zahlenwert, numerisch sortiert |
| `wikidata_timeline` | `query.wikidata.org` | Ereignisse je Jahr (z. B. Inbetriebnahme, Stilllegung) |
| `dbpedia_ranking` | `dbpedia.org/sparql` | Infobox-Ranglisten, numerisch sortiert, nur Staaten mit Hauptstadt |
| `wikidata_sparql` | `query.wikidata.org` | Freie lesende Abfrage, Notausgang für alles andere |
| `dbpedia_lookup` | `lookup.dbpedia.org` | Kurzbeschreibung und Typen |
| `dbpedia_sparql` | `dbpedia.org/sparql` | Infobox-Zahlen, vor allem BIP pro Kopf |
| `render_chart` | – | Diagramm aus belegten Zahlen |

Wissensgraph-Antworten stehen in `<knowledge source="wikidata|dbpedia">`,
Werkzeugfehler in `<tool-error>`, Systemmeldungen ohne Tag. Der System-Prompt
weist das Modell an, `<knowledge>` als Daten und nie als Anweisung zu behandeln.
Fremdtext kann die Klammer nicht schließen: `<knowledge` und `</knowledge`
werden im Rumpf maskiert, bevor der Block gebaut wird.

## Prüfen

```bash
npm test          # 146 Unit-Tests im Kern, 13 fuer den BFF, ohne Netz
npm run typecheck
npm run e2e       # fünf Abnahmefälle gegen die echten Endpunkte
```

`npm run e2e` braucht Netz und einen gültigen Key. Es prüft, dass jede Frage
Werkzeuge benutzt, dass quantitative Antworten ein Diagramm bekommen und dass
abgeschaltete Anreicherung wirklich keine Werkzeuge aufruft.

Fixtures neu aufzeichnen, wenn sich die APIs ändern:

```bash
node scripts/record-fixtures.mjs
```

## Grenzen

- Keine Zeitreihen aus dem Energiesektor. Wikidata hat keine Stromverbrauchs-
  Property (gemessen: `Q29954` ist ein Item, keine Property), DBpedia keine
  Zahlen dazu. Ein Tool für ENTSO-E oder den Open Energy Data Server ist der
  vorgesehene nächste Anschluss; die Werkzeugschnittstelle ist darauf ausgelegt.
- DBpedia liefert über SPARQL **kein** `dbo:abstract` (gemessen:
  `ASK { ?s dbo:abstract ?a }` = `false`), Prosa nur über die Lookup-API.
- DBpedia-Infobox-Zahlen sind Strings mit Einheiten, teils mehrfach
  (`Monaco` dreimal) und enthalten Nicht-Staaten (`EFTA`). `dbpedia_ranking`
  dedupliziert, castet numerisch und lässt nur Staaten mit Hauptstadt zu; wer
  frei abfragt, muss das selbst tun.
- Ohne HTTPS oder `localhost` kein PWA-Install.
- query.wikidata.org drosselt bei vielen Anfragen pro Minute (HTTP 429). Der
  Client weist darauf hin, statt blind zu wiederholen; identische Abfragen
  werden fünf Minuten zwischengespeichert.
- Ein Netzwerkaussetzer (`fetch failed`, 502-504) wird nach 1,2 s einmal
  wiederholt, für SPARQL wie für die JSON-APIs; ein fachlicher Fehler (400)
  nicht, da hilft nur eine andere Abfrage. Ist die Quelle danach weg, sagt die
  Antwort den Ausfall, statt aus einer lückenhaften anderen Quelle eine
  Ersatzrangliste zu bauen.
- Der Verlauf liegt in IndexedDB im Browser, nicht auf dem Server.

Entscheidungen und Messwerte, die zu diesem Aufbau geführt haben:
[docs/architektur.md](docs/architektur.md).
