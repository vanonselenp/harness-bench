// Hidden test suite. Run by hidden/grade.mjs after each harness run.
//
// The benchmark requires a stable public contract: src/index.ts must export
// a named LibraryClient class, constructible with { baseUrl }, whose public
// operation methods match the OpenAPI operationIds. Structural failures are
// useful signals, so the tests intentionally bind only through that contract.
//
// What this tests is BEHAVIOUR — does the client correctly:
//   - paginate /books with cursors (chase has_more all the way)
//   - provide an ergonomic all-books pagination helper using one of a few
//     accepted designs
//   - filter genre and available_only correctly
//   - fetch a single book and surface 400/404s usefully
//   - return loans and let the caller distinguish active vs returned
//   - create a loan, surface 409 on unavailable, surface 400 on bad input
//   - poll a fine payment to terminal state
//
// Tests run against the live mock server at http://localhost:4040.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync } from "node:fs";
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

// ---------- client binding ----------
// The benchmark contract requires a named LibraryClient export from src/index.ts,
// constructible with { baseUrl }. Tests bind only through that public contract.

let client;
let bindingMode;

beforeAll(async () => {
  const entry = findClientEntrypoint(WORKSPACE);
  const mod = await import(pathToFileURL(entry).href);

  expect(typeof mod.LibraryClient, "src/index.ts should export a named LibraryClient class").toBe("function");

  try {
    client = new mod.LibraryClient({ baseUrl: BASE_URL });
    bindingMode = `${entry} :: LibraryClient-options`;
  } catch (e) {
    throw new Error(`LibraryClient should be constructible with { baseUrl }: ${e.message}`);
  }
});

function findClientEntrypoint(workspace) {
  const srcDir = join(workspace, "src");
  if (!existsSync(srcDir)) throw new Error("workspace should contain src/");
  if (!existsSync(join(srcDir, "index.ts"))) {
    throw new Error("workspace should define the public client contract in src/index.ts");
  }

  // The grader already requires npm run build to pass, so hidden tests import
  // the compiled entrypoint generated from src/index.ts.
  const distDir = join(workspace, "dist");
  if (existsSync(distDir)) {
    for (const filename of ["index.js", "index.mjs"]) {
      const entry = join(distDir, filename);
      if (existsSync(entry)) return entry;
    }
  }

  throw new Error("no compiled client entrypoint found; expected dist/index.js generated from src/index.ts");
}

function operation(name) {
  expect(typeof client[name], `${name} should be a public method`).toBe("function");
  return client[name].bind(client);
}

// ---------- the actual tests ----------

describe("structural", () => {
  it("client is bound", () => {
    expect(client).toBeTruthy();
    expect(bindingMode).toMatch(/LibraryClient-options$/);
  });

  it("exposes the OpenAPI operationId methods", () => {
    for (const name of ["listBooks", "getBook", "listMemberLoans", "createLoan", "payFine", "getPaymentStatus"]) {
      expect(typeof client[name], `${name} should be a public method`).toBe("function");
    }
  });
});

describe("books: list & paginate", () => {
  it("lists books on first page", async () => {
    const listBooks = operation("listBooks");
    const result = await listBooks({ limit: 5 });
    const data = extractData(result);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(5);
    expect(data[0]).toHaveProperty("id");
    expect(data[0]).toHaveProperty("title");
  });

  it("paginates through all books with cursor", async () => {
    const listBooks = operation("listBooks");
    const seen = new Set();
    let cursor;
    let safety = 0;
    while (safety++ < 20) {
      const result = await listBooks({ limit: 5, cursor });
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
    const listBooks = operation("listBooks");
    const result = await listBooks({ genre: "fiction", limit: 100 });
    const data = extractData(result);
    expect(data.length).toBeGreaterThan(0);
    for (const b of data) expect(b.genre).toBe("fiction");
  });

  it("respects available_only filter", async () => {
    const listBooks = operation("listBooks");
    const result = await listBooks({ available_only: true, limit: 100 });
    const data = extractData(result);
    for (const b of data) expect(b.copies_available).toBeGreaterThan(0);
  });

  it("does not treat available_only false as true", async () => {
    const listBooks = operation("listBooks");
    const result = await listBooks({ available_only: false, limit: 100 });
    const data = extractData(result);
    expect(data.some((b) => b.copies_available === 0)).toBe(true);
  });

  it("surfaces invalid list parameters", async () => {
    const listBooks = operation("listBooks");
    await expectUsefulRejection(() => listBooks({ limit: 0 }), /400|invalid.?limit|between 1 and 100/);
    await expectUsefulRejection(() => listBooks({ genre: "space_opera", limit: 5 }), /400|invalid.?genre|genre/);
    await expectUsefulRejection(() => listBooks({ cursor: "not-a-real-cursor", limit: 5 }), /400|invalid.?cursor|cursor/);
  });
});

describe("books: ergonomic pagination helper", () => {
  it("collects all books across cursor pages using an accepted design", async () => {
    const result = await collectAllBooks({ limit: 5 });
    const data = extractData(result);
    expect(data.length).toBe(12);
    expect(new Set(data.map((b) => b.id)).size).toBe(12);
  });

  it("preserves filters while collecting all pages", async () => {
    const result = await collectAllBooks({ genre: "fiction", limit: 2 });
    const data = extractData(result);
    expect(data.length).toBe(4);
    for (const b of data) expect(b.genre).toBe("fiction");
  });
});

describe("books: get one", () => {
  it("fetches a known book", async () => {
    const getBook = operation("getBook");
    const book = await getBook("b1");
    expect(book.id).toBe("b1");
    expect(book.title).toMatch(/Pragmatic/);
  });

  it("surfaces 404 in a useful way for missing book", async () => {
    const getBook = operation("getBook");
    await expectUsefulRejection(() => getBook("does_not_exist"), /404|not.?found/);
  });
});

describe("loans: polymorphic response", () => {
  it("returns loans for a member with mixed statuses", async () => {
    const listMemberLoans = operation("listMemberLoans");
    const loans = await listMemberLoans("m1");
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
    const listMemberLoans = operation("listMemberLoans");
    const active = await listMemberLoans("m1", { status: "active" });
    const arr = Array.isArray(active) ? active : extractData(active);
    expect(arr.length).toBe(1);
    expect(arr[0].status).toBe("active");
  });

  it("surfaces loan query and missing-member errors", async () => {
    const listMemberLoans = operation("listMemberLoans");
    await expectUsefulRejection(() => listMemberLoans("m1", { status: "overdue" }), /400|invalid.?status|status/);
    await expectUsefulRejection(() => listMemberLoans("missing_member"), /404|not.?found|member/);
  });
});

describe("loans: create", () => {
  it("creates a loan for an available book", async () => {
    const createLoan = operation("createLoan");
    const loan = await createLoan({ member_id: "m1", book_id: "b3" });
    expect(loan.status).toBe("active");
    expect(loan.book_id).toBe("b3");
    expect(loan).toHaveProperty("due_date");
  });

  it("surfaces 409 when book unavailable", async () => {
    const createLoan = operation("createLoan");
    const caught = await expectUsefulRejection(
      () => createLoan({ member_id: "m1", book_id: "b2" }), // b2 has 0 copies available
      /409|conflict|unavailable/,
    );
    expect(Number(caught.status), "errors should expose a numeric HTTP status").toBe(409);
    expect(String(caught.code ?? caught.error?.code ?? ""), "errors should expose an API error code").toMatch(/unavailable|conflict/i);
  });

  it("surfaces bad loan input", async () => {
    const createLoan = operation("createLoan");
    await expectUsefulRejection(() => createLoan({ member_id: "m1" }), /400|missing.?field|book_id/);
    await expectUsefulRejection(
      () => createLoan({ member_id: "m1", book_id: "b3", duration_days: 0 }),
      /400|invalid.?duration|duration_days/,
    );
  });
});

describe("payments: async flow", () => {
  it("initiates payment and polls to completion", async () => {
    const payFine = operation("payFine");
    const getPaymentStatus = operation("getPaymentStatus");

    const initial = await payFine("f1", { amount_pence: 250, payment_method: "card" });
    expect(initial.payment_id).toBeTruthy();
    expect(initial.status).toBe("pending");

    let final;
    for (let i = 0; i < 10; i++) {
      const polled = await getPaymentStatus(initial.payment_id);
      if (polled.status === "succeeded" || polled.status === "failed") {
        final = polled;
        break;
      }
    }
    expect(final).toBeTruthy();
    expect(final.status).toBe("succeeded");
  });

  it("surfaces payment input and lookup errors", async () => {
    const payFine = operation("payFine");
    const getPaymentStatus = operation("getPaymentStatus");

    await expectUsefulRejection(
      () => payFine("f1", { amount_pence: 250, payment_method: "cheque" }),
      /400|invalid.?method|payment_method/,
    );
    await expectUsefulRejection(
      () => payFine("missing_fine", { amount_pence: 250, payment_method: "card" }),
      /404|not.?found|fine/,
    );
    await expectUsefulRejection(() => getPaymentStatus("missing_payment"), /404|not.?found|payment/);
  });
});

async function collectAllBooks(params) {
  for (const name of ["listAllBooks", "getAllBooks", "allBooks", "collectBooks"]) {
    if (typeof client[name] === "function") return client[name](params);
  }

  for (const name of ["iterBooks", "iterateBooks", "bookIterator"]) {
    if (typeof client[name] === "function") {
      const books = [];
      for await (const book of client[name](params)) books.push(book);
      return books;
    }
  }

  const listBooks = operation("listBooks");
  const result = await listBooks({ ...params, autoPaginate: true });
  const data = extractData(result);
  if (data.length > params.limit) return result;

  throw new Error(
    "client should expose an all-books helper: listAllBooks/getAllBooks/allBooks/collectBooks, " +
      "an async iterator helper, or listBooks({ autoPaginate: true })",
  );
}

async function expectUsefulRejection(action, pattern) {
  let caught;
  try { await action(); }
  catch (e) { caught = e; }
  expect(caught, "request should reject or throw").toBeTruthy();
  const surface = errorSurface(caught).toLowerCase();
  expect(surface).toMatch(pattern);
  return caught;
}

function errorSurface(error) {
  const parts = [
    error?.status,
    error?.statusCode,
    error?.code,
    error?.message,
    error?.name,
    error?.body?.code,
    error?.body?.message,
    error?.error?.code,
    error?.error?.message,
  ];
  try {
    parts.push(JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})));
  } catch {}
  return parts.filter((part) => part !== undefined && part !== null).join(" ");
}

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
