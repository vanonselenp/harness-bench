// Hidden test suite. Run by hidden/grade.mjs after each harness run.
//
// PROBLEM: every harness will design a different client API. We can't
// hard-code import paths or function names. So this suite uses an
// "adapter" pattern: it imports whatever the harness produced and tries
// a small number of conventional shapes to bind to it. If we can't bind,
// we record that as a structural failure — itself a useful signal.
//
// What this tests is BEHAVIOUR — does the client correctly:
//   - paginate /books with cursors (chase has_more all the way)
//   - filter genre and available_only correctly
//   - fetch a single book and surface 404s usefully
//   - return loans and let the caller distinguish active vs returned
//   - create a loan, surface 409 on unavailable, surface 400 on bad input
//   - poll a fine payment to terminal state
//
// Tests run against the live mock server at http://localhost:4040.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WORKSPACE = process.env.WORKSPACE_DIR;
if (!WORKSPACE) throw new Error("WORKSPACE_DIR env var must be set");

const BASE_URL = "http://localhost:4040";

// ---------- mock server lifecycle ----------
let serverProc;
beforeAll(async () => {
  serverProc = spawn("node", [resolve("hidden/mock-server/server.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: "4040" },
  });
  // wait for ready
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE_URL}/books?limit=1`);
      if (r.ok) return;
    } catch { /* not ready */ }
    await delay(100);
  }
  throw new Error("mock server failed to start");
});

afterAll(() => {
  if (serverProc && !serverProc.killed) serverProc.kill();
});

// ---------- adapter binding ----------
// We try a few conventional ways to instantiate whatever client the
// harness produced. We record which one worked.

let client;
let bindingMode;

beforeAll(async () => {
  const candidates = findClientEntrypoints(WORKSPACE);
  if (candidates.length === 0) {
    throw new Error("no client entrypoint found in workspace src/");
  }

  const errors = [];
  for (const entry of candidates) {
    try {
      const mod = await import(pathToFileURL(entry).href);
      const bound = tryBind(mod);
      if (bound) {
        client = bound.client;
        bindingMode = `${entry} :: ${bound.mode}`;
        return;
      }
    } catch (e) {
      errors.push(`${entry}: ${e.message}`);
    }
  }
  throw new Error(
    `could not bind to client from any entrypoint. Tried:\n${errors.join("\n")}`,
  );
});

function findClientEntrypoints(workspace) {
  const srcDir = join(workspace, "src");
  if (!existsSync(srcDir)) return [];
  const out = [];

  // 1. dist build outputs (preferred — proves it compiles)
  const distDir = join(workspace, "dist");
  if (existsSync(distDir)) {
    walkJs(distDir, out);
  }
  // 2. compiled .ts won't import directly; we rely on dist
  // 3. fall back to .mjs/.js in src
  walkJs(srcDir, out);

  // prioritise files named index, client, library, api
  const priority = (p) => {
    const name = p.toLowerCase();
    if (name.endsWith("/index.js") || name.endsWith("/index.mjs")) return 0;
    if (name.includes("client")) return 1;
    if (name.includes("library")) return 2;
    if (name.includes("api")) return 3;
    return 99;
  };
  return out.sort((a, b) => priority(a) - priority(b));
}

function walkJs(dir, acc) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walkJs(p, acc);
    else if (entry.endsWith(".js") || entry.endsWith(".mjs")) acc.push(p);
  }
}

function tryBind(mod) {
  // Mode A: default export is a class
  if (typeof mod.default === "function") {
    try {
      const c = new mod.default({ baseUrl: BASE_URL });
      return { client: c, mode: "default-class-options" };
    } catch {}
    try {
      const c = new mod.default(BASE_URL);
      return { client: c, mode: "default-class-baseurl" };
    } catch {}
    try {
      const c = mod.default({ baseUrl: BASE_URL });
      if (c) return { client: c, mode: "default-factory-options" };
    } catch {}
  }
  // Mode B: named export `LibraryClient` / `Client` / `createClient`
  for (const key of ["LibraryClient", "Client", "ApiClient"]) {
    if (typeof mod[key] === "function") {
      try { return { client: new mod[key]({ baseUrl: BASE_URL }), mode: `class-${key}-options` }; } catch {}
      try { return { client: new mod[key](BASE_URL), mode: `class-${key}-baseurl` }; } catch {}
    }
  }
  for (const key of ["createClient", "createLibraryClient", "client"]) {
    if (typeof mod[key] === "function") {
      try {
        const c = mod[key]({ baseUrl: BASE_URL });
        if (c) return { client: c, mode: `factory-${key}-options` };
      } catch {}
      try {
        const c = mod[key](BASE_URL);
        if (c) return { client: c, mode: `factory-${key}-baseurl` };
      } catch {}
    }
  }
  // Mode C: module itself is the client (functional style)
  if (typeof mod.listBooks === "function" || typeof mod.getBook === "function") {
    return { client: mod, mode: "module-as-client" };
  }
  return null;
}

// Probe the bound client for method names. Each operation has several
// likely names; we pick the first that exists.
function pick(...names) {
  for (const n of names) {
    if (typeof client[n] === "function") return n;
  }
  return null;
}

// ---------- the actual tests ----------

describe("structural", () => {
  it("client is bound", () => {
    expect(client).toBeTruthy();
  });
});

describe("books: list & paginate", () => {
  it("lists books on first page", async () => {
    const fn = pick("listBooks", "getBooks", "books");
    expect(fn, "client should expose a listBooks-like method").toBeTruthy();
    const result = await client[fn]({ limit: 5 });
    const data = extractData(result);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(5);
    expect(data[0]).toHaveProperty("id");
    expect(data[0]).toHaveProperty("title");
  });

  it("paginates through all books with cursor", async () => {
    const fn = pick("listBooks", "getBooks", "books");
    const seen = new Set();
    let cursor;
    let safety = 0;
    while (safety++ < 20) {
      const result = await client[fn]({ limit: 5, cursor });
      const data = extractData(result);
      for (const b of data) seen.add(b.id);
      const next = extractNextCursor(result);
      if (!next) break;
      cursor = next;
    }
    // The mock has 12 books total
    expect(seen.size).toBe(12);
  });

  it("filters by genre", async () => {
    const fn = pick("listBooks", "getBooks", "books");
    const result = await client[fn]({ genre: "fiction", limit: 100 });
    const data = extractData(result);
    expect(data.length).toBeGreaterThan(0);
    for (const b of data) expect(b.genre).toBe("fiction");
  });

  it("respects available_only filter", async () => {
    const fn = pick("listBooks", "getBooks", "books");
    const result = await client[fn]({ available_only: true, limit: 100 });
    const data = extractData(result);
    for (const b of data) expect(b.copies_available).toBeGreaterThan(0);
  });
});

describe("books: get one", () => {
  it("fetches a known book", async () => {
    const fn = pick("getBook", "fetchBook", "book");
    expect(fn).toBeTruthy();
    const book = await client[fn]("b1");
    expect(book.id).toBe("b1");
    expect(book.title).toMatch(/Pragmatic/);
  });

  it("surfaces 404 in a useful way for missing book", async () => {
    const fn = pick("getBook", "fetchBook", "book");
    let caught;
    try { await client[fn]("does_not_exist"); }
    catch (e) { caught = e; }
    expect(caught, "should throw or otherwise surface the 404").toBeTruthy();
    // The error should be inspectable — either status, code, or a recognisable shape
    const surface = JSON.stringify(caught, Object.getOwnPropertyNames(caught ?? {}));
    expect(surface.toLowerCase()).toMatch(/404|not.?found/);
  });
});

describe("loans: polymorphic response", () => {
  it("returns loans for a member with mixed statuses", async () => {
    const fn = pick("listMemberLoans", "getMemberLoans", "memberLoans", "loans");
    expect(fn).toBeTruthy();
    const loans = await client[fn]("m1");
    const arr = Array.isArray(loans) ? loans : extractData(loans);
    expect(arr.length).toBe(3);
    const active = arr.filter((l) => l.status === "active");
    const returned = arr.filter((l) => l.status === "returned");
    expect(active.length).toBe(1);
    expect(returned.length).toBe(2);
    // Active loans should expose due_date; returned should expose returned_at
    expect(active[0]).toHaveProperty("due_date");
    expect(returned[0]).toHaveProperty("returned_at");
  });

  it("filters loans by status", async () => {
    const fn = pick("listMemberLoans", "getMemberLoans", "memberLoans", "loans");
    const active = await client[fn]("m1", { status: "active" });
    const arr = Array.isArray(active) ? active : extractData(active);
    expect(arr.length).toBe(1);
    expect(arr[0].status).toBe("active");
  });
});

describe("loans: create", () => {
  it("creates a loan for an available book", async () => {
    const fn = pick("createLoan", "newLoan", "loan");
    expect(fn).toBeTruthy();
    const loan = await client[fn]({ member_id: "m1", book_id: "b3" });
    expect(loan.status).toBe("active");
    expect(loan.book_id).toBe("b3");
    expect(loan).toHaveProperty("due_date");
  });

  it("surfaces 409 when book unavailable", async () => {
    const fn = pick("createLoan", "newLoan", "loan");
    let caught;
    try { await client[fn]({ member_id: "m1", book_id: "b2" }); } // b2 has 0 copies available
    catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    const surface = JSON.stringify(caught, Object.getOwnPropertyNames(caught ?? {}));
    expect(surface.toLowerCase()).toMatch(/409|conflict|unavailable/);
  });
});

describe("payments: async flow", () => {
  it("initiates payment and polls to completion", async () => {
    const payFn = pick("payFine", "createPayment", "initiatePayment");
    expect(payFn).toBeTruthy();
    const pollFn = pick("getPaymentStatus", "getPayment", "pollPayment", "paymentStatus");
    expect(pollFn).toBeTruthy();

    const initial = await client[payFn]("f1", { amount_pence: 250, payment_method: "card" });
    expect(initial.payment_id).toBeTruthy();
    expect(initial.status).toBe("pending");

    let final;
    for (let i = 0; i < 10; i++) {
      const polled = await client[pollFn](initial.payment_id);
      if (polled.status === "succeeded" || polled.status === "failed") {
        final = polled;
        break;
      }
    }
    expect(final).toBeTruthy();
    expect(final.status).toBe("succeeded");
  });
});

// ---------- shape extractors ----------
// Different harnesses may unwrap pagination differently. Allow a few shapes.
function extractData(result) {
  if (Array.isArray(result)) return result;
  if (result?.data && Array.isArray(result.data)) return result.data;
  if (result?.items && Array.isArray(result.items)) return result.items;
  if (result?.results && Array.isArray(result.results)) return result.results;
  return [];
}
function extractNextCursor(result) {
  if (!result || typeof result !== "object") return null;
  if (result.page?.has_more && result.page?.next_cursor) return result.page.next_cursor;
  if (result.next_cursor) return result.next_cursor;
  if (result.nextCursor) return result.nextCursor;
  if (result.cursor && result.has_more) return result.cursor;
  return null;
}
