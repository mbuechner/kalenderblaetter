# DDB Kalenderblatt – Monats-Check

Kleine Webanwendung zur Qualitätsprüfung der DDB-„Kalenderblatt“-Seiten für alle Tage eines ausgewählten Monats.

Die App erzeugt für jeden Tag im Monat den Timestamp für **00:00:00 Europe/Berlin**, ruft das Kalenderblatt ab und bewertet das Ergebnis:

- **OK**: Seite erreichbar, String nicht gefunden
- **Überarbeiten**: HTML enthält `Objekt nicht mehr vorhanden`
- **Fehler**: z. B. HTTP 404/500, Netzwerkfehler, Timeout

Alles läuft in **einem Node/Express-Container**:
- statisches Frontend (`web/index.html`)
- restriktiver Proxy-Endpoint (`/kalenderblatt?ts=...`) mit Whitelist & Rate-Limit

---

## Features

- Monatsauswahl, Start/Abbrechen
- Checks parallel mit fester Parallelität (**8**)
- Timeout fest auf **180 Sekunden**
- Sortierbare Tabelle (Default: **Timestamp aufsteigend**)

---

## Architektur

```
Browser (UI)
  └── GET /kalenderblatt?ts=...
        (Express)
          └── GET https://www.deutsche-digitale-bibliothek.de/content/kalenderblatt?date={ts}
```

Der Server baut die Ziel-URL serverseitig und erlaubt nur:

- Origin: `https://www.deutsche-digitale-bibliothek.de`
- Path: `/content/kalenderblatt`
- Query: `date=<timestamp>`

---

## Repository-Struktur

```
.
├─ Dockerfile
├─ package.json
├─ package-lock.json
├─ server.js
└─ web/
   └─ index.html
```

---

## Quickstart (lokal ohne Docker)

```bash
npm ci
node server.js
```

Dann im Browser: `http://localhost:8080/`

---

## Docker

### Build
```bash
docker build -t kalenderblaetter .
```

### Run
```bash
docker run --rm -p 8080:8080 kalenderblaetter
```

Öffnen: `http://localhost:8080/`

---

## Kubernetes (non-root)

Das Image ist für non-root geeignet (wenn im Dockerfile `USER node` gesetzt ist).
Empfohlener `securityContext`:

```yaml
securityContext:
  runAsNonRoot: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
```

Optional (wenn `readOnlyRootFilesystem: true` genutzt wird):

```yaml
volumeMounts:
  - name: tmp
    mountPath: /tmp
volumes:
  - name: tmp
    emptyDir: {}
```

---

## Konfiguration

Aktuell bewusst „fixed settings“ im Frontend:

- Parallelität: **8**
- Timeout: **180s**
- Proxy-Endpoint: **`/kalenderblatt?ts=`** (same-origin)

Server-Host: `HOST` via Env Var (Default 0.0.0.0).
Server-Port: `PORT` via Env Var (Default 8080).

---
