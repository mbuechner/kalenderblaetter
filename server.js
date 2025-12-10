const path = require("path");
const express = require("express");
const fetch = require("node-fetch"); // v2
const rateLimit = require("express-rate-limit");

const app = express();

// Hard limits / Whitelist
const ALLOWED_ORIGIN = "https://www.deutsche-digitale-bibliothek.de";
const ALLOWED_PATH = "/content/kalenderblatt";
const MIN_TS = -2208988800000;  // ~1900-01-01
const MAX_TS =  4102444800000;  // ~2100-01-01

app.disable("x-powered-by");

// Rate limit gegen Missbrauch
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120, // pro Minute/IP
  standardHeaders: true,
  legacyHeaders: false
}));

// Static UI
const webDir = path.join(__dirname, "web");
app.use(express.static(webDir, { index: "index.html" }));

// Proxy-Endpoint: /kalenderblatt?ts=...
app.get("/kalenderblatt", async (req, res) => {
  try {
    const tsRaw = String(req.query.ts ?? "").trim();
    if (!/^-?\d{10,17}$/.test(tsRaw)) return res.status(400).send("Invalid ts");

    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || ts < MIN_TS || ts > MAX_TS) return res.status(400).send("ts out of range");

    // Ziel-URL serverseitig bauen (Client darf keine URL übergeben)
    const target = new URL(ALLOWED_PATH, ALLOWED_ORIGIN);
    target.searchParams.set("date", String(ts));

    if (target.origin !== ALLOWED_ORIGIN || target.pathname !== ALLOWED_PATH) {
      return res.status(400).send("Target not allowed");
    }

    const upstream = await fetch(target.toString(), {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "DDB-Kalenderblatt-Checker/1.0" }
    });

    const text = await upstream.text();

    res.status(upstream.status);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(text);
  } catch {
    res.status(502).send("Upstream error");
  }
});

// SPA-Fallback (falls später weitere Routen hinzukommen)
app.get(/.*/, (_req, res) => res.sendFile(path.join(webDir, "index.html")));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on :${PORT}`));
