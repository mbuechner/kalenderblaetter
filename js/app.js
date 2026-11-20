(() => {
  "use strict";

  const TIME_ZONE = "Europe/Berlin";
  const DDB_URL = "https://www.deutsche-digitale-bibliothek.de/content/kalenderblatt?date=";
  const CONCURRENCY = 8;
  const TIMEOUT_MS = 180_000;
  // Die DDB benennt ihre Tageslisten nach Tag und Monat, zum Beispiel „29. Mai“.
  const dayFormatter = new Intl.DateTimeFormat("de-DE", { timeZone: TIME_ZONE, day: "numeric", month: "long" });

  const statuses = {
    open: { label: "Offen", color: "secondary" },
    running: { label: "Läuft", color: "primary" },
    ok: { label: "OK", color: "success" },
    rework: { label: "Überarbeiten", color: "warning" },
    error: { label: "Fehler", color: "danger" }
  };

  const form = document.getElementById("monthForm");
  const monthPicker = document.getElementById("monthPicker");
  const startButton = document.getElementById("btnStart");
  const cancelButton = document.getElementById("btnCancel");
  const alert = document.getElementById("uiAlert");
  const alertMessage = document.getElementById("alertMessage");
  const resultsBody = document.getElementById("resultsBody");
  const progress = document.getElementById("progress");
  const progressBar = document.getElementById("progressBar");
  const runStatus = document.getElementById("runStatus");
  const statTotal = document.getElementById("statTotal");
  const statOk = document.getElementById("statOk");
  const statRework = document.getElementById("statRework");
  const statError = document.getElementById("statErr");
  const statPending = document.getElementById("statPending");
  const headers = document.querySelectorAll("th[data-key]");
  const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });

  let items = [];
  let activeRun = null;
  let sortKey = "ts";
  let sortDirection = "ascending";
  let refreshFrame = null;
  let needsSort = false;

  function hideAlert() {
    alert.hidden = true;
    monthPicker.removeAttribute("aria-invalid");
    monthPicker.removeAttribute("aria-describedby");
  }

  function showAlert(message) {
    alertMessage.textContent = message;
    alert.hidden = false;
  }

  function updateStats() {
    const counts = { open: 0, running: 0, ok: 0, rework: 0, error: 0 };
    for (const item of items) counts[item.status]++;

    statTotal.textContent = items.length;
    statOk.textContent = counts.ok;
    statRework.textContent = counts.rework;
    statError.textContent = counts.error;
    statPending.textContent = counts.open + counts.running;

    const completed = counts.ok + counts.rework + counts.error;
    const percentage = items.length ? Math.round(completed / items.length * 100) : 0;
    progress.setAttribute("aria-valuenow", percentage);
    progressBar.style.width = percentage + "%";
    progressBar.textContent = percentage ? percentage + "%" : "";
  }

  function compareItems(a, b) {
    if (sortKey === "ts") return a.ts - b.ts;
    if (sortKey === "status") return collator.compare(statuses[a.status].label, statuses[b.status].label);
    return collator.compare(a[sortKey], b[sortKey]);
  }

  function renderRows() {
    needsSort = false;
    const direction = sortDirection === "ascending" ? 1 : -1;
    // Die Sortierung ändert nur die Anzeige. Die Worker behalten die Reihenfolge der Kalendertage.
    const rows = items.slice().sort((a, b) => direction * compareItems(a, b) || a.ts - b.ts).map(item => item.row);
    const displayed = resultsBody.rows;
    if (displayed.length === rows.length && rows.every((row, index) => row === displayed[index])) return;

    const focused = resultsBody.contains(document.activeElement) ? document.activeElement : null;
    resultsBody.replaceChildren(...rows);
    if (focused?.isConnected) focused.focus({ preventScroll: true });
  }

  function refreshResults() {
    if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);
    refreshFrame = null;
    if (needsSort) renderRows();
    updateStats();
  }

  function updateSortHeaders() {
    for (const header of headers) {
      const indicator = header.querySelector(".sort-indicator");
      if (header.dataset.key === sortKey) {
        header.setAttribute("aria-sort", sortDirection);
        indicator.textContent = sortDirection === "ascending" ? "↑" : "↓";
      } else {
        header.removeAttribute("aria-sort");
        indicator.textContent = "";
      }
    }
  }

  function updateRow(item, status, note = "") {
    item.status = status;
    item.note = note;
    item.badge.className = `badge text-bg-${statuses[status].color}`;
    item.badge.textContent = statuses[status].label;
    item.noteCell.textContent = note;

    if (!item.row.isConnected) return;
    // Mehrere API-Antworten können im selben Frame eintreffen. Statistik und Sortierung werden gebündelt.
    needsSort ||= sortKey === "status" || sortKey === "note";
    refreshFrame ??= requestAnimationFrame(refreshResults);
  }

  function createItem(date) {
    const iso = date.toISODate();
    // Der Link zum Kalenderblatt erwartet den Unix-Zeitstempel in Sekunden.
    const ts = date.toUnixInteger();
    const url = DDB_URL + ts;
    const row = document.createElement("tr");
    const dateCell = row.insertCell();
    dateCell.className = "font-monospace";
    dateCell.textContent = iso;
    const timestampCell = row.insertCell();
    timestampCell.className = "font-monospace";
    timestampCell.textContent = ts;

    const link = document.createElement("a");
    link.className = "calendar-link font-monospace";
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = url;
    row.insertCell().append(link);

    const badge = document.createElement("span");
    row.insertCell().append(badge);
    const noteCell = row.insertCell();
    noteCell.className = "small text-muted";

    const item = { iso, ts, url, row, badge, noteCell };
    updateRow(item, "open");
    return item;
  }

  async function checkItem(item, runSignal) {
    // Der Monatsabbruch stoppt jede laufende Tagesprüfung. Das Zeitlimit gilt einzeln pro Tag.
    const controller = new AbortController();
    const abortRequest = () => controller.abort();
    runSignal.addEventListener("abort", abortRequest, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortRequest();
    }, TIMEOUT_MS);

    updateRow(item, "running", "Anfrage läuft …");
    try {
      const day = dayFormatter.format(item.ts * 1000);
      const missingObject = await checkCalendarInDdbApi(day, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (missingObject) {
        updateRow(item, "rework", "Objekt(e) nicht mehr vorhanden");
      } else {
        updateRow(item, "ok");
      }
    } catch (error) {
      if (runSignal.aborted) {
        updateRow(item, "open");
      } else if (timedOut) {
        updateRow(item, "error", "Zeitlimit überschritten");
      } else {
        let note = "Die DDB-API ist nicht erreichbar.";
        if (error instanceof DdbApiError) {
          note = error.message;
        } else if (error instanceof SyntaxError) {
          note = "Die DDB-API hat ungültige JSON-Daten geliefert.";
        }
        updateRow(item, "error", note);
      }
    } finally {
      clearTimeout(timeout);
      runSignal.removeEventListener("abort", abortRequest);
    }
  }

  function setRunning(running) {
    const focused = document.activeElement;
    const moveFocus = running ? focused === startButton || focused === monthPicker : focused === cancelButton;
    startButton.disabled = running;
    cancelButton.disabled = !running;
    monthPicker.disabled = running;
    if (moveFocus) (running ? cancelButton : startButton).focus();
  }

  async function runMonth() {
    const controller = new AbortController();
    const { signal } = controller;
    const monthItems = items;
    // Jeder Worker übernimmt den nächsten freien Tag, bevor er auf die API wartet.
    let next = 0;

    async function worker() {
      while (!signal.aborted && next < monthItems.length) {
        await checkItem(monthItems[next++], signal);
      }
    }

    activeRun = controller;
    setRunning(true);
    runStatus.textContent = "Monatsprüfung gestartet.";
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, monthItems.length) }, worker));
      refreshResults();
      runStatus.textContent = signal.aborted ? "Monatsprüfung abgebrochen." : "Monatsprüfung abgeschlossen.";
    } finally {
      activeRun = null;
      setRunning(false);
    }
  }

  document.getElementById("btnDismiss").addEventListener("click", () => {
    hideAlert();
    monthPicker.focus();
  });

  for (const header of headers) {
    header.querySelector("button").addEventListener("click", () => {
      const key = header.dataset.key;
      sortDirection = sortKey === key && sortDirection === "ascending" ? "descending" : "ascending";
      sortKey = key;
      updateSortHeaders();
      renderRows();
    });
  }

  const DateTime = globalThis.luxon?.DateTime;
  if (!DateTime) {
    showAlert("Die Kalenderbibliothek konnte nicht geladen werden. Bitte lade die Seite erneut.");
    return;
  }

  const { checkCalendarInDdbApi, DdbApiError } = globalThis.ddbApi ?? {};
  if (!checkCalendarInDdbApi || !DdbApiError) {
    showAlert("Das Modul für die DDB-API konnte nicht geladen werden. Bitte lade die Seite erneut.");
    return;
  }

  monthPicker.value = DateTime.now().setZone(TIME_ZONE).toISODate().slice(0, 7);
  startButton.disabled = false;

  cancelButton.addEventListener("click", () => activeRun?.abort());
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (activeRun) return;
    hideAlert();

    const month = monthPicker.value;
    const firstDay = /^\d{4}-\d{2}$/.test(month) ? DateTime.fromISO(month + "-01", { zone: TIME_ZONE }) : null;
    if (!firstDay?.isValid || month < monthPicker.min || month > monthPicker.max) {
      showAlert("Bitte wähle einen Monat zwischen Januar 1900 und Dezember 2100 (JJJJ-MM).");
      monthPicker.setAttribute("aria-invalid", "true");
      monthPicker.setAttribute("aria-describedby", "alertMessage");
      monthPicker.focus();
      return;
    }

    // Kalendertage statt fester 24-Stunden-Schritte halten die Berliner Mitternacht bei Zeitumstellungen ein.
    items = Array.from({ length: firstDay.daysInMonth }, (_, dayOffset) =>
      createItem(firstDay.plus({ days: dayOffset }).startOf("day")));
    renderRows();
    updateStats();
    await runMonth();
  });
})();
