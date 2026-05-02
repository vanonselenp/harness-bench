// Mock Library API server. Run with: node hidden/mock-server/server.mjs
// Listens on http://localhost:4040 by default.
//
// Deliberately implements the gnarly bits of the spec:
//   - cursor-based pagination on /books
//   - polymorphic loan responses on /members/{id}/loans
//   - async 202 + status-URL flow on /fines/{id}/pay
//   - default value semantics on `available_only` and `duration_days`

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 4040);

// ---------- fixture data ----------
const books = [
  { id: "b1", title: "The Pragmatic Programmer", author: "Hunt & Thomas", genre: "non_fiction", copies_total: 3, copies_available: 1, isbn: "9780201616224" },
  { id: "b2", title: "Clean Code", author: "Robert C. Martin", genre: "non_fiction", copies_total: 2, copies_available: 0, isbn: "9780132350884" },
  { id: "b3", title: "Project Hail Mary", author: "Andy Weir", genre: "fiction", copies_total: 4, copies_available: 4, isbn: "9780593135204" },
  { id: "b4", title: "Where the Wild Things Are", author: "Maurice Sendak", genre: "childrens", copies_total: 5, copies_available: 5, isbn: "9780064431781" },
  { id: "b5", title: "The Economist", author: "Various", genre: "periodical", copies_total: 1, copies_available: 0, isbn: null },
  { id: "b6", title: "Oxford English Dictionary", author: "OUP", genre: "reference", copies_total: 1, copies_available: 1, isbn: "9780198611868" },
  { id: "b7", title: "Dune", author: "Frank Herbert", genre: "fiction", copies_total: 3, copies_available: 2, isbn: "9780441013593" },
  { id: "b8", title: "Sapiens", author: "Yuval Noah Harari", genre: "non_fiction", copies_total: 2, copies_available: 1, isbn: "9780062316097" },
  { id: "b9", title: "The Hobbit", author: "J.R.R. Tolkien", genre: "fiction", copies_total: 4, copies_available: 0, isbn: "9780547928227" },
  { id: "b10", title: "Goodnight Moon", author: "Margaret Wise Brown", genre: "childrens", copies_total: 6, copies_available: 6, isbn: "9780064430173" },
  { id: "b11", title: "Foundation", author: "Isaac Asimov", genre: "fiction", copies_total: 2, copies_available: 2, isbn: "9780553293357" },
  { id: "b12", title: "Nature", author: "Various", genre: "periodical", copies_total: 1, copies_available: 1, isbn: null },
];

// member m1 has a mix of active and returned loans
const memberLoans = {
  m1: [
    { id: "l1", member_id: "m1", book_id: "b1", status: "active", loaned_at: "2026-04-15T10:00:00Z", due_date: "2026-04-29", renewals_remaining: 2 },
    { id: "l2", member_id: "m1", book_id: "b9", status: "returned", loaned_at: "2026-03-01T10:00:00Z", returned_at: "2026-03-20T14:30:00Z", late_days: 5 },
    { id: "l3", member_id: "m1", book_id: "b3", status: "returned", loaned_at: "2026-02-10T09:00:00Z", returned_at: "2026-02-22T11:00:00Z", late_days: 0 },
  ],
  m2: [
    { id: "l4", member_id: "m2", book_id: "b7", status: "active", loaned_at: "2026-04-20T15:00:00Z", due_date: "2026-05-04", renewals_remaining: 3 },
  ],
  m_empty: [],
};

const fines = {
  f1: { id: "f1", amount_pence: 250 },
  f2: { id: "f2", amount_pence: 1000 },
};

// payment_id -> { status, created_at, fine_id, succeeds_after_polls, polls_so_far }
const payments = new Map();

// ---------- helpers ----------
function send(res, status, body, extraHeaders = {}) {
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function err(res, status, code, message, details) {
  send(res, status, details ? { code, message, details } : { code, message });
}

function parseQuery(url) {
  const u = new URL(url, "http://localhost");
  return Object.fromEntries(u.searchParams.entries());
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function encodeCursor(offset) {
  return Buffer.from(String(offset)).toString("base64url");
}
function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  } catch { return null; }
}

// ---------- routes ----------
async function handle(req, res) {
  const { method, url } = req;
  const u = new URL(url, "http://localhost");
  const path = u.pathname;

  // GET /books
  if (method === "GET" && path === "/books") {
    const q = parseQuery(url);
    const limit = q.limit !== undefined ? Number(q.limit) : 20;
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      return err(res, 400, "invalid_limit", "limit must be between 1 and 100");
    }
    const cursor = q.cursor;
    const offset = decodeCursor(cursor);
    if (offset === null) return err(res, 400, "invalid_cursor", "cursor is malformed");

    let filtered = books;
    if (q.genre) {
      const valid = ["fiction", "non_fiction", "reference", "periodical", "childrens"];
      if (!valid.includes(q.genre)) {
        return err(res, 400, "invalid_genre", `genre must be one of ${valid.join(", ")}`);
      }
      filtered = filtered.filter((b) => b.genre === q.genre);
    }
    // available_only: default false. Note that the string "false" is NOT false-y.
    if (q.available_only === "true") {
      filtered = filtered.filter((b) => b.copies_available > 0);
    }

    const slice = filtered.slice(offset, offset + limit);
    const has_more = offset + limit < filtered.length;
    const page = has_more ? { has_more: true, next_cursor: encodeCursor(offset + limit) } : { has_more: false };
    return send(res, 200, { data: slice, page });
  }

  // GET /books/{book_id}
  const bookMatch = path.match(/^\/books\/([^/]+)$/);
  if (method === "GET" && bookMatch) {
    const id = bookMatch[1];
    const book = books.find((b) => b.id === id);
    if (!book) return err(res, 404, "not_found", `book ${id} not found`);
    return send(res, 200, book);
  }

  // GET /members/{member_id}/loans
  const loansMatch = path.match(/^\/members\/([^/]+)\/loans$/);
  if (method === "GET" && loansMatch) {
    const memberId = loansMatch[1];
    if (!(memberId in memberLoans)) {
      return err(res, 404, "not_found", `member ${memberId} not found`);
    }
    const q = parseQuery(url);
    const status = q.status ?? "all";
    if (!["active", "returned", "all"].includes(status)) {
      return err(res, 400, "invalid_status", "status must be one of: active, returned, all");
    }
    let result = memberLoans[memberId];
    if (status !== "all") result = result.filter((l) => l.status === status);
    return send(res, 200, result);
  }

  // POST /loans
  if (method === "POST" && path === "/loans") {
    let body;
    try { body = await readJson(req); } catch { return err(res, 400, "invalid_json", "request body is not valid JSON"); }
    if (!body.member_id || !body.book_id) {
      return err(res, 400, "missing_field", "member_id and book_id are required");
    }
    const book = books.find((b) => b.id === body.book_id);
    if (!book) return err(res, 404, "not_found", `book ${body.book_id} not found`);
    if (book.copies_available < 1) {
      return err(res, 409, "unavailable", `book ${book.id} has no copies available`);
    }
    const duration = body.duration_days ?? 14;
    if (!Number.isInteger(duration) || duration < 1 || duration > 90) {
      return err(res, 400, "invalid_duration", "duration_days must be an integer between 1 and 90");
    }
    const now = new Date();
    const due = new Date(now.getTime() + duration * 86400000);
    const loan = {
      id: `loan_${randomUUID().slice(0, 8)}`,
      member_id: body.member_id,
      book_id: body.book_id,
      status: "active",
      loaned_at: now.toISOString(),
      due_date: due.toISOString().slice(0, 10),
      renewals_remaining: 3,
    };
    return send(res, 201, loan);
  }

  // POST /fines/{fine_id}/pay
  const finePayMatch = path.match(/^\/fines\/([^/]+)\/pay$/);
  if (method === "POST" && finePayMatch) {
    const fineId = finePayMatch[1];
    if (!(fineId in fines)) return err(res, 404, "not_found", `fine ${fineId} not found`);
    let body;
    try { body = await readJson(req); } catch { return err(res, 400, "invalid_json", "request body is not valid JSON"); }
    if (typeof body.amount_pence !== "number" || body.amount_pence < 1) {
      return err(res, 400, "invalid_amount", "amount_pence must be a positive integer");
    }
    if (!["card", "cash", "account_credit"].includes(body.payment_method)) {
      return err(res, 400, "invalid_method", "payment_method must be card, cash, or account_credit");
    }
    const paymentId = `pay_${randomUUID().slice(0, 8)}`;
    payments.set(paymentId, {
      status: "pending",
      fine_id: fineId,
      polls_so_far: 0,
      succeeds_after_polls: 2, // first two polls return pending, third returns succeeded
    });
    return send(
      res,
      202,
      { payment_id: paymentId, status: "pending" },
      { Location: `/payments/${paymentId}` },
    );
  }

  // GET /payments/{payment_id}
  const paymentMatch = path.match(/^\/payments\/([^/]+)$/);
  if (method === "GET" && paymentMatch) {
    const id = paymentMatch[1];
    const p = payments.get(id);
    if (!p) return err(res, 404, "not_found", `payment ${id} not found`);
    p.polls_so_far += 1;
    if (p.polls_so_far > p.succeeds_after_polls) p.status = "succeeded";
    const out = { payment_id: id, status: p.status };
    return send(res, 200, out);
  }

  return err(res, 404, "not_found", `no route for ${method} ${path}`);
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    err(res, 500, "internal_error", "internal server error");
  });
});

server.listen(PORT, () => {
  console.log(`mock library API listening on http://localhost:${PORT}`);
});
