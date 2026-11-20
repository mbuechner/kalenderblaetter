"use strict";

const { checkCalendarInDdbApi, DdbApiError } = globalThis.ddbApi;
const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

const assert = {
  ok(value, message) {
    if (!value) throw new Error(message);
  },
  equal(actual, expected) {
    this.ok(actual === expected, `Expected ${expected}, received ${actual}`);
  },
  deepEqual(actual, expected) {
    this.equal(JSON.stringify(actual), JSON.stringify(expected));
  },
  match(actual, pattern) {
    this.ok(pattern.test(actual), `Expected ${actual} to match ${pattern}`);
  },
  async rejects(promise, { type, message, name } = {}) {
    try {
      await promise;
    } catch (error) {
      if (type) this.ok(error instanceof type, `Expected ${type.name}, received ${error}`);
      if (message) this.match(error.message, message);
      if (name) this.equal(error.name, name);
      return;
    }
    throw new Error("Expected the promise to reject");
  }
};

const OWNER = "56bf18c366c89d1915887decda83c0ab";
const FOLDER = "4ujSCj-lRMa2kVSdNqew0A";
const DAY = "29. Mai";
const FIRST_ITEM = "A".repeat(32);
const SECOND_ITEM = "66S6DDCRGK5SJJ5KIUU5O776FG7BSDFW";
const PERSON = "118577905";
const PERSON_GND = `http://d-nb.info/gnd/${PERSON}`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function bookmark(id, itemId, type = "CULTURAL_ITEM") {
  return { id, itemId, type, portal: "DDB" };
}

function assertRequest({ url, request, unexpected }, signal) {
  assert.equal(url.origin, "https://api.deutsche-digitale-bibliothek.de");
  assert.equal(request.cache, "no-store");
  assert.equal(request.credentials, "omit");
  assert.equal(request.method ?? "GET", "GET");
  assert.equal(request.redirect, "error");
  assert.equal(new Headers(request.headers).get("accept"), "application/json");
  assert.equal(request.signal, signal);

  if (url.pathname === "/2/favourites/folders") {
    assert.equal(url.searchParams.get("title"), DAY);
    assert.equal(url.searchParams.get("portal"), "DDB");
    assert.equal(url.searchParams.get("userId"), OWNER);
  } else if (url.pathname === "/2/search/index/person/select") {
    assert.equal(url.searchParams.get("q"), `id:"${PERSON_GND}"`);
    assert.equal(url.searchParams.get("rows"), "1");
    assert.equal(url.searchParams.get("fl"), "id");
  } else if (url.pathname !== `/2/favourites/folders/${FOLDER}/bookmarks`) {
    assert.match(url.pathname, /^\/2\/items\/[A-Z0-9]{32}\/view$/);
  }
  assert.ok(!unexpected, `Unexpected request for ${url.pathname}`);
}

function api({ bookmarks, responses = [], folderOverrides = {}, ambiguousFolder = false, bookmarkTotal = bookmarks.length }) {
  const requests = [];
  const controller = new AbortController();
  const folder = {
    title: DAY, portal: "DDB", id: FOLDER, userId: OWNER, publishingName: "  DDB Redaktion",
    blocked: false, published: false, bookmarkIds: bookmarks.map(entry => entry.id), ...folderOverrides
  };
  const folderEntries = ambiguousFolder ? [folder, { ...folder, id: "other-folder" }] : [folder];
  const options = {
    signal: controller.signal,
    fetchUpstream: async (url, request) => {
      const observed = { url, request };
      requests.push(observed);
      if (url.pathname === "/2/favourites/folders") {
        return json({ total: folderEntries.length, folders: folderEntries });
      }
      if (url.pathname === `/2/favourites/folders/${FOLDER}/bookmarks`) {
        return json({ total: bookmarkTotal, bookmarks });
      }
      const response = responses.shift();
      observed.unexpected = !response;
      return typeof response === "function" ? response(controller) : response;
    }
  };
  return {
    check: () => checkCalendarInDdbApi(DAY, options).finally(() => {
      // Validate here so assertions still fail when the API converts a request failure to an unresolved result.
      for (const request of requests) assertRequest(request, controller.signal);
    }),
    get calls() { return requests.map(({ url }) => url.pathname); }
  };
}

test("exports a classic browser client that defaults to fetch", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, request) => {
    calls.push([url.pathname, request.credentials]);
    return json({ total: 0, folders: [] });
  };
  try {
    await assert.rejects(checkCalendarInDdbApi(DAY), { type: DdbApiError });
    assert.deepEqual(calls, [["/2/favourites/folders", "omit"]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checks the complete editorial calendar and identifies the DDB item absence response", async () => {
  const lookups = api({
    bookmarks: [bookmark("institution", "example-institution", "INSTITUTION"), bookmark("item-1", FIRST_ITEM), bookmark("item-2", SECOND_ITEM)],
    responses: [json({ item: { identifier: "source-identifier" } }), json({ message: "No data row is available (size=0)." }, 404)]
  });
  assert.equal(await lookups.check(), true);
  assert.deepEqual(lookups.calls, [
    "/2/favourites/folders", `/2/favourites/folders/${FOLDER}/bookmarks`,
    `/2/items/${FIRST_ITEM}/view`, `/2/items/${SECOND_ITEM}/view`
  ]);
});

test("reports OK when all listed items have a valid item view", async () => {
  const lookups = api({
    bookmarks: [bookmark("item-1", FIRST_ITEM), bookmark("item-2", SECOND_ITEM)],
    folderOverrides: { publishingName: "ddb-daily" },
    responses: [json({ item: { identifier: "source-identifier-1" } }), json({ item: { identifier: "source-identifier-2" } })]
  });
  assert.equal(await lookups.check(), false);
});

test("checks repeated item references once and keeps invalid portals unresolved", async () => {
  const repeated = [bookmark("item-1", FIRST_ITEM), bookmark("item-2", FIRST_ITEM)];
  const lookups = api({ bookmarks: repeated, responses: [json({ item: { identifier: "source-identifier" } })] });
  assert.equal(await lookups.check(), false);
  assert.equal(lookups.calls.length, 3);

  const foreignPortal = api({
    bookmarks: [repeated[0], { ...repeated[1], portal: "ZP" }],
    responses: [json({ item: { identifier: "source-identifier" } })]
  });
  await assert.rejects(foreignPortal.check(), { message: /nicht alle Kalendereinträge/ });
  assert.equal(foreignPortal.calls.length, 3);
});

test("allows a later duplicate lookup to confirm an earlier failure", async () => {
  const repeated = [bookmark("item-1", FIRST_ITEM), bookmark("item-2", FIRST_ITEM)];
  for (const failure of [
    json({ message: "Service unavailable" }, 503),
    () => { throw new TypeError("Network unavailable"); }
  ]) {
    const lookups = api({
      bookmarks: repeated,
      responses: [failure, json({ item: { identifier: "source-identifier" } })]
    });
    assert.equal(await lookups.check(), false);
    assert.deepEqual(lookups.calls.slice(2), [`/2/items/${FIRST_ITEM}/view`, `/2/items/${FIRST_ITEM}/view`]);
  }
});

test("requires exactly one confirmed person in the search response", async () => {
  const bookmarks = [bookmark("person", PERSON, "ENTITY")];
  const personResponse = response => json({ responseHeader: { status: 0 }, response });
  const found = api({ bookmarks, responses: [personResponse({ numFound: 1, docs: [{ id: PERSON_GND }] })] });
  assert.equal(await found.check(), false);
  for (const response of [
    { numFound: 0, docs: [] },
    { numFound: 1, docs: [{ id: PERSON_GND }, { id: "another-person" }] }
  ]) {
    const unresolved = api({ bookmarks, responses: [personResponse(response)] });
    await assert.rejects(unresolved.check(), { message: /nicht alle Kalendereinträge/ });
  }
});

test("rejects another folder owner or an incomplete bookmarks response", async () => {
  const bookmarks = [bookmark("item-1", FIRST_ITEM)];
  for (const options of [
    { folderOverrides: { userId: "another-owner" } },
    { folderOverrides: { title: "30. Mai" } },
    { ambiguousFolder: true },
    { folderOverrides: { bookmarkIds: ["item-1", "item-2"] } },
    { bookmarkTotal: 2 }
  ]) {
    const lookups = api({ bookmarks, ...options });
    await assert.rejects(lookups.check(), {
      type: DdbApiError,
      message: /keine eindeutige Kalenderliste|unvollständige/
    });
    assert.equal(lookups.calls.some(path => path.includes("/items/")), false);
  }
});

test("rejects mismatched or duplicate bookmark IDs before checking items", async () => {
  for (const ids of [["first", "first"], ["first", "unknown"]]) {
    const lookups = api({
      bookmarks: [bookmark(ids[0], FIRST_ITEM), bookmark(ids[1], SECOND_ITEM)],
      folderOverrides: { bookmarkIds: ["first", "second"] }
    });
    await assert.rejects(lookups.check(), { type: DdbApiError, message: /unvollständige/ });
    assert.equal(lookups.calls.length, 2);
  }
});

test("treats unsupported item types and unrelated upstream responses as unresolved", async () => {
  const unsupported = api({ bookmarks: [bookmark("organization", "example-institution", "INSTITUTION")] });
  await assert.rejects(unsupported.check(), { message: /nicht alle Kalendereinträge/ });

  for (const response of [
    json({ message: "Wrong API route" }, 404),
    json({ message: "Service unavailable" }, 503),
    json({ message: "Unexpected success body" }),
    new Response("<title>Proxy error</title>", { headers: { "Content-Type": "text/html" } })
  ]) {
    const lookups = api({ bookmarks: [bookmark("item-1", FIRST_ITEM)], responses: [response] });
    await assert.rejects(lookups.check(), { message: /nicht alle Kalendereinträge/ });
  }
});

test("propagates cancellation from the parent request immediately", async () => {
  const lookups = api({
    bookmarks: [bookmark("item-1", FIRST_ITEM), bookmark("item-2", SECOND_ITEM)],
    responses: [controller => { controller.abort(); controller.signal.throwIfAborted(); }]
  });
  await assert.rejects(lookups.check(), { name: "AbortError" });
  assert.equal(lookups.calls.length, 3);
});

test("does not return a result when the final response arrives after cancellation", async () => {
  const lookups = api({
    bookmarks: [bookmark("item-1", FIRST_ITEM)],
    responses: [controller => {
      controller.abort();
      return json({ message: "No data row is available (size=0)." }, 404);
    }]
  });
  await assert.rejects(lookups.check(), { name: "AbortError" });
});

async function runTests() {
  const testResult = document.getElementById("test-result");
  const results = document.getElementById("results");
  let passed = 0;

  for (const { name, run } of tests) {
    const result = document.createElement("li");
    try {
      await run();
      result.textContent = `OK – ${name}`;
      passed++;
    } catch (error) {
      result.textContent = `Fehler – ${name}: ${error.message}`;
    }
    results.append(result);
  }

  document.getElementById("summary").textContent = `${passed} von ${tests.length} Tests bestanden.`;
  testResult.dataset.status = passed === tests.length ? "passed" : "failed";
}

runTests();
