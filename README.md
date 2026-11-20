# DDB Kalenderblatt – Monats-Check

Ein Browser-Check für die redaktionellen Tageslisten der Deutschen Digitalen Bibliothek. Er prüft Monate von Januar 1900 bis Dezember 2100. Das Jahr bestimmt die Kalendertage und ihre Unix-Zeitstempel für Mitternacht in `Europe/Berlin`. Als Listenschlüssel dienen Tag und Monat, etwa `29. Mai`.

## Prüfpfad

1. **Tagesliste suchen** – `GET /2/favourites/folders` findet die eindeutige, ungesperrte Liste anhand von Redaktionskonto, Portal und Titel.
2. **Einträge laden** – `GET /2/favourites/folders/{id}/bookmarks` liefert die Einträge. Anzahl und IDs müssen zur Liste passen. [Favourite API](https://deutsche-digitale-bibliothek.atlassian.net/wiki/spaces/DDBDOK/pages/47830484/Favourite+API)
3. **Verweise prüfen** – Kulturobjekte über `GET /2/items/{id}/view`, Personen über ihre GND-ID im DDB-Personenindex. Bestätigte Ergebnisse werden pro Tag wiederverwendet. [DDB-API v2](https://labs.deutsche-digitale-bibliothek.de/app/ddbapi/)

| Status | Kriterium |
| --- | --- |
| **OK** | Alle Verweise sind bestätigt. |
| **Überarbeiten** | Ein Objektabruf liefert HTTP 404 mit der DDB-Meldung für einen fehlenden Datensatz. |
| **Fehler** | Die Liste oder ein Verweis lässt sich nicht eindeutig prüfen. |

Bis zu acht Tage laufen parallel, mit 180 Sekunden Zeitlimit pro Tag. Ein Abbruch lässt abgeschlossene Ergebnisse stehen und setzt laufende Tage auf **Offen**.
