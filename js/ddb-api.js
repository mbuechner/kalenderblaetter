(() => {
  "use strict";

  const API_BASE = "https://api.deutsche-digitale-bibliothek.de/2/";
  const PORTAL = "DDB";
  // Die Konto-ID der Redaktion ist stabil. Der Anzeigename kann je nach Tagesliste variieren.
  const EDITORIAL_USER_ID = "56bf18c366c89d1915887decda83c0ab";
  const FOLDER_ID = /^[\w-]{1,128}$/;
  const CULTURAL_ITEM_ID = /^[A-Z0-9]{32}$/;
  const GND_ID = /^[0-9]{1,11}(?:-[0-9X]|X)?$/;
  const MAX_JSON_BYTES = 1024 * 1024;
  const NO_ITEM_MESSAGE = "No data row is available (size=0).";

  class DdbApiError extends Error {}

  async function readJson(response) {
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (mimeType !== "application/json" || !response.body) {
      await response.body?.cancel();
      throw new DdbApiError("Die DDB-API hat keine JSON-Daten geliefert.");
    }

    // Beim Lesen begrenzen wir die Größe und dekodieren UTF-8 auch über Blockgrenzen hinweg.
    let size = 0;
    let json = "";
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_JSON_BYTES) {
          await reader.cancel();
          throw new DdbApiError("Die DDB-API-Antwort ist zu groß.");
        }
        json += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(json + decoder.decode());
  }

  async function readList(response, key) {
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new DdbApiError(`Die DDB-API antwortete mit HTTP ${response.status}.`);
    }
    const data = await readJson(response);
    const entries = data?.[key];
    if (!Array.isArray(entries) || entries.length !== data.total) {
      throw new DdbApiError("Die DDB-API hat eine unvollständige Liste geliefert.");
    }
    return entries;
  }

  async function checkItem(response) {
    if (response.status === 200) {
      const identifier = (await readJson(response))?.item?.identifier;
      return typeof identifier === "string" && identifier.trim() ? false : null;
    }
    // Erst die DDB-Meldung für einen fehlenden Datensatz bestätigt, dass das Objekt fehlt.
    if (response.status === 404) return (await readJson(response))?.message === NO_ITEM_MESSAGE ? true : null;
    await response.body?.cancel();
    return null;
  }

  async function checkPerson(response, id) {
    if (response.status !== 200) {
      await response.body?.cancel();
      return null;
    }
    const data = await readJson(response);
    const matches = data?.response;
    // ENTITY umfasst auch andere Einträge. Eine leere Personensuche bleibt deshalb ergebnisoffen.
    const found = data?.responseHeader?.status === 0 && matches?.numFound === 1 &&
      Array.isArray(matches.docs) && matches.docs.length === 1 && matches.docs[0]?.id === id;
    return found ? false : null;
  }

  function bookmarkCheck({ itemId, portal, type }) {
    if (portal !== PORTAL || typeof itemId !== "string") return null;
    if (type === "CULTURAL_ITEM" && CULTURAL_ITEM_ID.test(itemId)) {
      return { path: `items/${itemId}/view`, verify: checkItem };
    }
    if (type !== "ENTITY" || !GND_ID.test(itemId)) return null;

    const id = `http://d-nb.info/gnd/${itemId}`;
    const query = new URLSearchParams({ q: `id:"${id}"`, rows: "1", fl: "id" });
    return { path: `search/index/person/select?${query}`, verify: response => checkPerson(response, id) };
  }

  /**
   * Findet die öffentliche Tagesliste über FA10 und lädt ihre Einträge über FA09.
   * @param {string} day Deutscher Listentitel, zum Beispiel „29. Mai“.
   * @param {{ fetchUpstream?: typeof fetch, signal?: AbortSignal }} [options]
   * @returns {Promise<boolean>} true bei einem fehlenden Objekt, false bei vollständiger Verfügbarkeit.
   * @throws {Error} Bei Abbruch oder wenn die Prüfung offenbleibt.
   */
  async function checkCalendarInDdbApi(day, { fetchUpstream = fetch, signal } = {}) {
    const requestOptions = {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal
    };
    const request = path => {
      signal?.throwIfAborted();
      return fetchUpstream(new URL(path, API_BASE), requestOptions);
    };

    const query = new URLSearchParams({ userId: EDITORIAL_USER_ID, title: day, portal: PORTAL });
    const folders = await readList(await request(`favourites/folders?${query}`), "folders");
    const matches = folders.filter(folder => folder?.title === day && folder.portal === PORTAL &&
      folder.userId === EDITORIAL_USER_ID && folder.blocked === false);
    const [folder] = matches;
    if (matches.length !== 1 || typeof folder.id !== "string" || !FOLDER_ID.test(folder.id) ||
        !Array.isArray(folder.bookmarkIds) || folder.bookmarkIds.length === 0) {
      throw new DdbApiError(`Die DDB-API hat keine eindeutige Kalenderliste für den ${day} geliefert.`);
    }

    // Vergleiche die IDs beider Antworten, damit eine Teilliste kein „OK“ ergibt.
    const bookmarks = await readList(await request(`favourites/folders/${folder.id}/bookmarks`), "bookmarks");
    const expectedIds = new Set(folder.bookmarkIds);
    if (bookmarks.length !== folder.bookmarkIds.length || expectedIds.size !== bookmarks.length ||
        !bookmarks.every(bookmark => typeof bookmark?.id === "string" && bookmark.id && expectedIds.delete(bookmark.id))) {
      throw new DdbApiError("Die DDB-API hat eine unvollständige Kalenderliste geliefert.");
    }

    // Mehrere Lesezeichen können auf denselben Eintrag verweisen. Ein unklarer Status kann sich dabei noch klären.
    const statusByPath = new Map();
    let hasUnsupported = false;
    for (const bookmark of bookmarks) {
      signal?.throwIfAborted();
      const check = bookmarkCheck(bookmark);
      if (!check) {
        hasUnsupported = true;
        continue;
      }
      if (statusByPath.get(check.path) === false) continue;

      // true steht für fehlend, false für verfügbar und null für einen unklaren Status.
      let missing = null;
      try {
        missing = await check.verify(await request(check.path));
      } catch {
        // Auch nach einem technischen Fehler kann ein weiterer Eintrag als fehlend bestätigt werden.
      }
      signal?.throwIfAborted();
      if (missing === true) return true;
      statusByPath.set(check.path, missing);
    }

    if (hasUnsupported || [...statusByPath.values()].includes(null)) {
      throw new DdbApiError("Die DDB-API konnte nicht alle Kalendereinträge prüfen.");
    }
    return false;
  }

  globalThis.ddbApi = { checkCalendarInDdbApi, DdbApiError };
})();
