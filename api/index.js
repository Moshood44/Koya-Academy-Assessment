// api/index.ts
import { handle } from "@hono/node-server/vercel";

// src/app.ts
import { Hono } from "hono";

// src/db.ts
import pg from "pg";
var pool = null;
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    pool = new pg.Pool({
      connectionString,
      max: 1,
      ssl: false
    });
  }
  return pool;
}

// src/app.ts
import crypto from "node:crypto";
import pg2 from "pg";
import fs from "node:fs";
import path from "node:path";
var app = new Hono();
app.use("*", async (c, next) => {
  if (c.req.path === "/" && c.req.method === "GET") {
    return next();
  }
  const apiKey = c.req.header("X-API-Key");
  const expectedKey = process.env.API_KEY;
  if (!apiKey || !expectedKey || apiKey !== expectedKey) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});
app.get("/", (c) => {
  try {
    const templatePath = path.resolve(process.cwd(), "dist", "template.html");
    let html = fs.readFileSync(templatePath, "utf8");
    const apiKey = process.env.API_KEY || "";
    const escapedApiKey = JSON.stringify(apiKey);
    const scriptTag = `<script>window.__API_KEY__=${escapedApiKey};</script>`;
    if (html.includes("<!--API_KEY_SCRIPT-->")) {
      html = html.replace("<!--API_KEY_SCRIPT-->", scriptTag);
    } else {
      html = html.replace("</head>", `${scriptTag}</head>`);
    }
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.html(html);
  } catch (err) {
    return c.text("Template not found", 500);
  }
});
app.post("/reset", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "malformed body" }, 400);
  }
  if (!body || !Array.isArray(body.slots)) {
    return c.json({ error: "malformed body" }, 400);
  }
  for (const s of body.slots) {
    if (!s || typeof s.id !== "string" || typeof s.provider !== "string" || typeof s.start !== "string" || typeof s.end !== "string") {
      return c.json({ error: "malformed body" }, 400);
    }
  }
  const pool2 = getPool();
  const client = await pool2.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM bookings");
    await client.query("DELETE FROM slots");
    await client.query("DELETE FROM idempotency_keys");
    await client.query("DELETE FROM rate_limit_attempts");
    for (const s of body.slots) {
      await client.query(
        'INSERT INTO slots (id, provider, start, "end", start_raw, end_raw) VALUES ($1, $2, $3, $4, $5, $6)',
        [s.id, s.provider, s.start, s.end, s.start, s.end]
      );
    }
    await client.query("COMMIT");
    return c.json({ ok: true }, 200);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
    });
    return c.json({ error: "internal error" }, 500);
  } finally {
    client.release();
  }
});
app.get("/slots", async (c) => {
  const provider = c.req.query("provider");
  const pool2 = getPool();
  const client = await pool2.connect();
  try {
    let query = `
      SELECT 
        s.id, 
        s.provider, 
        s.start_raw, 
        s.end_raw, 
        s.start,
        CASE WHEN b.id IS NOT NULL THEN false ELSE true END AS available
      FROM slots s
      LEFT JOIN bookings b ON s.id = b.slot_id AND b.status = 'confirmed'
    `;
    const params = [];
    if (provider !== void 0) {
      query += " WHERE s.provider = $1";
      params.push(provider);
    }
    query += " ORDER BY s.start ASC";
    const res = await client.query(query, params);
    const slots = res.rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      start: r.start_raw || r.start.toISOString(),
      end: r.end_raw || r.end.toISOString(),
      available: r.available
    }));
    return c.json({ slots }, 200);
  } catch (err) {
    return c.json({ error: "internal error" }, 500);
  } finally {
    client.release();
  }
});
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
app.post("/bookings", async (c) => {
  const rawBodyText = await c.req.text();
  let body;
  try {
    body = JSON.parse(rawBodyText);
  } catch {
    return c.json({ error: "malformed body" }, 400);
  }
  const rawIdemKey = c.req.header("Idempotency-Key");
  const idemKey = rawIdemKey && rawIdemKey.trim() !== "" ? rawIdemKey.trim() : null;
  const pool2 = getPool();
  let bodyHash = "";
  if (idemKey) {
    bodyHash = crypto.createHash("sha256").update(rawBodyText).digest("hex");
    const client = await pool2.connect();
    let winner = false;
    try {
      const insRes = await client.query(
        "INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
        [idemKey, bodyHash]
      );
      winner = (insRes.rowCount ?? 0) > 0;
      if (!winner) {
        const existingRes = await client.query("SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1", [idemKey]);
        if (existingRes.rows.length > 0) {
          const row = existingRes.rows[0];
          if (row.request_hash !== bodyHash) {
            return c.json({ error: "idempotency key mismatch" }, 422);
          }
          if (row.status_code !== null && row.response_body !== null) {
            return c.json(row.response_body, row.status_code);
          }
        }
        let completedRow = null;
        for (let i = 0; i < 25; i++) {
          await new Promise((r) => setTimeout(r, 200));
          const pollRes = await client.query("SELECT status_code, response_body FROM idempotency_keys WHERE key = $1", [idemKey]);
          if (pollRes.rows.length > 0 && pollRes.rows[0].status_code !== null && pollRes.rows[0].response_body !== null) {
            completedRow = pollRes.rows[0];
            break;
          }
        }
        if (completedRow) {
          return c.json(completedRow.response_body, completedRow.status_code);
        }
        return c.json({ error: "internal error" }, 500);
      }
    } catch {
      return c.json({ error: "internal error" }, 500);
    } finally {
      client.release();
    }
  }
  let rateLimitEmail = null;
  if (body && typeof body === "object" && !Array.isArray(body) && typeof body.email === "string") {
    const trimmed = body.email.trim();
    if (trimmed.length > 0) {
      rateLimitEmail = trimmed.toLowerCase();
    }
  }
  if (rateLimitEmail) {
    const client = await pool2.connect();
    try {
      await client.query("BEGIN");
      const escapedEmail = pg2.escapeLiteral(rateLimitEmail);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext(${escapedEmail}))`);
      const now = /* @__PURE__ */ new Date();
      const windowStart = new Date(now.getTime() - 6e4);
      const attemptsRes = await client.query(
        "SELECT attempted_at FROM rate_limit_attempts WHERE email = $1 AND attempted_at >= $2 ORDER BY attempted_at ASC",
        [rateLimitEmail, windowStart.toISOString()]
      );
      if (attemptsRes.rows.length >= 5) {
        const oldestAttempt = new Date(attemptsRes.rows[0].attempted_at);
        const expiresAt = oldestAttempt.getTime() + 6e4;
        const diffMs = expiresAt - now.getTime();
        const retryAfter = Math.max(1, Math.ceil(diffMs / 1e3));
        await client.query("COMMIT");
        if (idemKey) {
          await pool2.query("DELETE FROM idempotency_keys WHERE key = $1", [idemKey]);
        }
        return new Response(JSON.stringify({ error: "too many requests" }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": retryAfter.toString()
          }
        });
      }
      await client.query("INSERT INTO rate_limit_attempts (email, attempted_at) VALUES ($1, $2)", [rateLimitEmail, now.toISOString()]);
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => {
      });
      if (idemKey) {
        await pool2.query("DELETE FROM idempotency_keys WHERE key = $1", [idemKey]);
      }
      return c.json({ error: "internal error" }, 500);
    } finally {
      client.release();
    }
  }
  const executeBooking = async () => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: "malformed body" } };
    }
    const { slot_id, name, email } = body;
    if (typeof slot_id !== "string" || typeof name !== "string" || typeof email !== "string") {
      return { status: 400, body: { error: "slot_id, name, and email must be strings" } };
    }
    const trimmedSlotId = slot_id.trim();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedSlotId || !trimmedName || !trimmedEmail) {
      return { status: 400, body: { error: "slot_id, name, and email must not be empty" } };
    }
    if (!isValidEmail(trimmedEmail)) {
      return { status: 400, body: { error: "invalid email address" } };
    }
    const normalizedEmail = trimmedEmail.toLowerCase();
    const client = await pool2.connect();
    try {
      const slotRes = await client.query("SELECT id, start FROM slots WHERE id = $1", [trimmedSlotId]);
      if (slotRes.rows.length === 0) {
        return { status: 404, body: { error: "slot not found" } };
      }
      const slotStart = new Date(slotRes.rows[0].start);
      if (slotStart <= /* @__PURE__ */ new Date()) {
        return { status: 400, body: { error: "slot has already started" } };
      }
      const bookingId = crypto.randomUUID();
      const res = await client.query(
        "INSERT INTO bookings (id, slot_id, name, email, status) VALUES ($1, $2, $3, $4, $5) RETURNING id, slot_id, name, email, status, created_at",
        [bookingId, trimmedSlotId, trimmedName, normalizedEmail, "confirmed"]
      );
      const row = res.rows[0];
      return {
        status: 201,
        body: {
          id: row.id,
          slot_id: row.slot_id,
          name: row.name,
          email: row.email,
          status: row.status,
          created_at: new Date(row.created_at).toISOString()
        }
      };
    } catch (err) {
      if (err && err.code === "23505") {
        return { status: 409, body: { error: "slot already booked" } };
      }
      return { status: 500, body: { error: "internal error" } };
    } finally {
      client.release();
    }
  };
  try {
    const outcome = await executeBooking();
    if (idemKey) {
      const client = await pool2.connect();
      try {
        if (outcome.status !== 429) {
          await client.query(
            "UPDATE idempotency_keys SET status_code = $1, response_body = $2 WHERE key = $3",
            [outcome.status, JSON.stringify(outcome.body), idemKey]
          );
        } else {
          await client.query("DELETE FROM idempotency_keys WHERE key = $1", [idemKey]);
        }
      } finally {
        client.release();
      }
    }
    return c.json(outcome.body, outcome.status);
  } catch (err) {
    if (idemKey) {
      const client = await pool2.connect();
      try {
        await client.query("DELETE FROM idempotency_keys WHERE key = $1", [idemKey]);
      } catch {
      } finally {
        client.release();
      }
    }
    return c.json({ error: "internal error" }, 500);
  }
});
app.get("/bookings", async (c) => {
  const rawEmail = c.req.query("email");
  if (rawEmail === void 0 || rawEmail === null) {
    return c.json({ error: "email query parameter is required" }, 400);
  }
  const trimmedEmail = rawEmail.trim();
  if (!trimmedEmail) {
    return c.json({ error: "email query parameter must not be empty" }, 400);
  }
  const normalizedEmail = trimmedEmail.toLowerCase();
  const limitQuery = c.req.query("limit");
  let limit = 10;
  if (limitQuery !== void 0) {
    if (!/^\d+$/.test(limitQuery)) {
      return c.json({ error: "limit must be an integer between 1 and 50" }, 400);
    }
    limit = parseInt(limitQuery, 10);
    if (limit < 1 || limit > 50) {
      return c.json({ error: "limit must be between 1 and 50" }, 400);
    }
  }
  const cursorQuery = c.req.query("cursor");
  let afterSeq = null;
  if (cursorQuery !== void 0 && cursorQuery !== null && cursorQuery !== "") {
    try {
      const decoded = Buffer.from(cursorQuery, "base64").toString("utf8");
      if (!/^\d+$/.test(decoded)) {
        return c.json({ error: "invalid cursor" }, 400);
      }
      afterSeq = BigInt(decoded);
    } catch {
      return c.json({ error: "invalid cursor" }, 400);
    }
  }
  const pool2 = getPool();
  const client = await pool2.connect();
  try {
    let query = "SELECT id, slot_id, name, email, status, created_at, seq FROM bookings WHERE LOWER(email) = $1";
    const params = [normalizedEmail];
    if (afterSeq !== null) {
      params.push(afterSeq.toString());
      query += ` AND seq > $${params.length}`;
    }
    query += " ORDER BY seq ASC";
    params.push(limit + 1);
    query += ` LIMIT $${params.length}`;
    const res = await client.query(query, params);
    const rows = res.rows;
    const hasMore = rows.length > limit;
    const returnedRows = hasMore ? rows.slice(0, limit) : rows;
    const bookings = returnedRows.map((r) => ({
      id: r.id,
      slot_id: r.slot_id,
      name: r.name,
      email: r.email,
      status: r.status,
      created_at: new Date(r.created_at).toISOString()
    }));
    const next_cursor = hasMore && returnedRows.length > 0 ? Buffer.from(returnedRows[returnedRows.length - 1].seq.toString()).toString("base64") : null;
    return c.json({ bookings, next_cursor }, 200);
  } catch {
    return c.json({ error: "internal error" }, 500);
  } finally {
    client.release();
  }
});
app.get("/bookings/:id", async (c) => {
  const id = c.req.param("id");
  const pool2 = getPool();
  const client = await pool2.connect();
  try {
    const res = await client.query(
      "SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1",
      [id]
    );
    if (res.rows.length === 0) {
      return c.json({ error: "booking not found" }, 404);
    }
    const row = res.rows[0];
    return c.json({
      id: row.id,
      slot_id: row.slot_id,
      name: row.name,
      email: row.email,
      status: row.status,
      created_at: new Date(row.created_at).toISOString()
    }, 200);
  } catch {
    return c.json({ error: "internal error" }, 500);
  } finally {
    client.release();
  }
});
app.delete("/bookings/:id", async (c) => {
  const id = c.req.param("id");
  const pool2 = getPool();
  const client = await pool2.connect();
  try {
    const res = await client.query(
      "UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING id, slot_id, name, email, status, created_at",
      [id]
    );
    if (res.rows.length > 0) {
      const row = res.rows[0];
      return c.json({
        id: row.id,
        slot_id: row.slot_id,
        name: row.name,
        email: row.email,
        status: row.status,
        created_at: new Date(row.created_at).toISOString()
      }, 200);
    }
    const checkRes = await client.query("SELECT id, status FROM bookings WHERE id = $1", [id]);
    if (checkRes.rows.length === 0) {
      return c.json({ error: "booking not found" }, 404);
    }
    return c.json({ error: "booking already cancelled" }, 409);
  } catch {
    return c.json({ error: "internal error" }, 500);
  } finally {
    client.release();
  }
});
app.notFound((c) => {
  return c.json({ error: "not found" }, 404);
});
app.onError((err, c) => {
  return c.json({ error: "internal error" }, 500);
});

// api/index.ts
var index_default = handle(app);
export {
  index_default as default
};
