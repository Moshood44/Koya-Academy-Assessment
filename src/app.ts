import { Hono } from 'hono';
import { getPool } from './db.js';
import crypto from 'node:crypto';
import pg from 'pg';

export const app = new Hono();

// Auth middleware: exempt GET /
app.use('*', async (c, next) => {
  if (c.req.path === '/' && c.req.method === 'GET') {
    return next();
  }
  const apiKey = c.req.header('X-API-Key');
  const expectedKey = process.env.API_KEY;
  if (!apiKey || !expectedKey || apiKey !== expectedKey) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
});

// GET / returns 404 for now
app.get('/', (c) => {
  return c.json({ error: 'not found' }, 404);
});

// POST /reset (Level 1)
app.post('/reset', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'malformed body' }, 400);
  }

  if (!body || !Array.isArray(body.slots)) {
    return c.json({ error: 'malformed body' }, 400);
  }

  for (const s of body.slots) {
    if (!s || typeof s.id !== 'string' || typeof s.provider !== 'string' || typeof s.start !== 'string' || typeof s.end !== 'string') {
      return c.json({ error: 'malformed body' }, 400);
    }
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM bookings');
    await client.query('DELETE FROM slots');
    await client.query('DELETE FROM idempotency_keys');
    await client.query('DELETE FROM rate_limit_attempts');

    for (const s of body.slots) {
      await client.query(
        'INSERT INTO slots (id, provider, start, "end", start_raw, end_raw) VALUES ($1, $2, $3, $4, $5, $6)',
        [s.id, s.provider, s.start, s.end, s.start, s.end]
      );
    }

    await client.query('COMMIT');
    return c.json({ ok: true }, 200);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return c.json({ error: 'internal error' }, 500);
  } finally {
    client.release();
  }
});

// GET /slots (Level 1)
app.get('/slots', async (c) => {
  const provider = c.req.query('provider');
  const pool = getPool();
  const client = await pool.connect();
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
    const params: any[] = [];
    if (provider !== undefined) {
      query += ' WHERE s.provider = $1';
      params.push(provider);
    }
    query += ' ORDER BY s.start ASC';

    const res = await client.query(query, params);
    const slots = res.rows.map((r: any) => ({
      id: r.id,
      provider: r.provider,
      start: r.start_raw || r.start.toISOString(),
      end: r.end_raw || r.end.toISOString(),
      available: r.available,
    }));

    return c.json({ slots }, 200);
  } catch (err) {
    return c.json({ error: 'internal error' }, 500);
  } finally {
    client.release();
  }
});

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// POST /bookings (Levels 1 to 5)
// Order: auth, parse JSON, idempotency lookup, rate limit, field validation, slot exists, slot not started, insert (409 on conflict), store idempotent response.
app.post('/bookings', async (c) => {
  // 1. Auth handled in middleware

  // 2. Parse JSON
  const rawBodyText = await c.req.text();
  let body: any;
  try {
    body = JSON.parse(rawBodyText);
  } catch {
    return c.json({ error: 'malformed body' }, 400);
  }

  // 3. Idempotency lookup
  const rawIdemKey = c.req.header('Idempotency-Key');
  const idemKey = rawIdemKey && rawIdemKey.trim() !== '' ? rawIdemKey.trim() : null;
  const pool = getPool();

  let bodyHash = '';
  if (idemKey) {
    bodyHash = crypto.createHash('sha256').update(rawBodyText).digest('hex');

    const client = await pool.connect();
    let winner = false;
    try {
      const insRes = await client.query(
        'INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [idemKey, bodyHash]
      );
      winner = (insRes.rowCount ?? 0) > 0;

      if (!winner) {
        // Loser: check hash
        const existingRes = await client.query('SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1', [idemKey]);
        if (existingRes.rows.length > 0) {
          const row = existingRes.rows[0];
          if (row.request_hash !== bodyHash) {
            return c.json({ error: 'idempotency key mismatch' }, 422);
          }
          if (row.status_code !== null && row.response_body !== null) {
            return c.json(row.response_body, row.status_code);
          }
        }

        // Poll briefly for completed response
        let completedRow = null;
        for (let i = 0; i < 25; i++) {
          await new Promise((r) => setTimeout(r, 200));
          const pollRes = await client.query('SELECT status_code, response_body FROM idempotency_keys WHERE key = $1', [idemKey]);
          if (pollRes.rows.length > 0 && pollRes.rows[0].status_code !== null && pollRes.rows[0].response_body !== null) {
            completedRow = pollRes.rows[0];
            break;
          }
        }

        if (completedRow) {
          return c.json(completedRow.response_body, completedRow.status_code);
        }
        return c.json({ error: 'internal error' }, 500);
      }
    } catch {
      return c.json({ error: 'internal error' }, 500);
    } finally {
      client.release();
    }
  }

  // 4. Rate limit check (Level 5)
  // Key the limit on the trimmed, lower-cased email whenever the email is a non-empty string.
  let rateLimitEmail: string | null = null;
  if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.email === 'string') {
    const trimmed = body.email.trim();
    if (trimmed.length > 0) {
      rateLimitEmail = trimmed.toLowerCase();
    }
  }

  if (rateLimitEmail) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const escapedEmail = pg.escapeLiteral(rateLimitEmail);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext(${escapedEmail}))`);

      const now = new Date();
      const windowStart = new Date(now.getTime() - 60000);

      const attemptsRes = await client.query(
        'SELECT attempted_at FROM rate_limit_attempts WHERE email = $1 AND attempted_at >= $2 ORDER BY attempted_at ASC',
        [rateLimitEmail, windowStart.toISOString()]
      );

      if (attemptsRes.rows.length >= 5) {
        const oldestAttempt = new Date(attemptsRes.rows[0].attempted_at);
        const expiresAt = oldestAttempt.getTime() + 60000;
        const diffMs = expiresAt - now.getTime();
        const retryAfter = Math.max(1, Math.ceil(diffMs / 1000));

        await client.query('COMMIT');

        // Clean up uncompleted idempotency key so it is not stuck
        if (idemKey) {
          await pool.query('DELETE FROM idempotency_keys WHERE key = $1', [idemKey]);
        }

        return new Response(JSON.stringify({ error: 'too many requests' }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': retryAfter.toString(),
          },
        });
      }

      await client.query('INSERT INTO rate_limit_attempts (email, attempted_at) VALUES ($1, $2)', [rateLimitEmail, now.toISOString()]);
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK').catch(() => {});
      if (idemKey) {
        await pool.query('DELETE FROM idempotency_keys WHERE key = $1', [idemKey]);
      }
      return c.json({ error: 'internal error' }, 500);
    } finally {
      client.release();
    }
  }

  // 5. Field validation & 6. Slot checks & 7. Insert
  const executeBooking = async () => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'malformed body' } };
    }

    const { slot_id, name, email } = body;
    if (typeof slot_id !== 'string' || typeof name !== 'string' || typeof email !== 'string') {
      return { status: 400, body: { error: 'slot_id, name, and email must be strings' } };
    }

    const trimmedSlotId = slot_id.trim();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (!trimmedSlotId || !trimmedName || !trimmedEmail) {
      return { status: 400, body: { error: 'slot_id, name, and email must not be empty' } };
    }

    if (!isValidEmail(trimmedEmail)) {
      return { status: 400, body: { error: 'invalid email address' } };
    }

    const normalizedEmail = trimmedEmail.toLowerCase();
    const client = await pool.connect();
    try {
      const slotRes = await client.query('SELECT id, start FROM slots WHERE id = $1', [trimmedSlotId]);
      if (slotRes.rows.length === 0) {
        return { status: 404, body: { error: 'slot not found' } };
      }

      const slotStart = new Date(slotRes.rows[0].start);
      if (slotStart <= new Date()) {
        return { status: 400, body: { error: 'slot has already started' } };
      }

      const bookingId = crypto.randomUUID();
      const res = await client.query(
        'INSERT INTO bookings (id, slot_id, name, email, status) VALUES ($1, $2, $3, $4, $5) RETURNING id, slot_id, name, email, status, created_at',
        [bookingId, trimmedSlotId, trimmedName, normalizedEmail, 'confirmed']
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
          created_at: new Date(row.created_at).toISOString(),
        },
      };
    } catch (err: any) {
      if (err && err.code === '23505') {
        return { status: 409, body: { error: 'slot already booked' } };
      }
      return { status: 500, body: { error: 'internal error' } };
    } finally {
      client.release();
    }
  };

  try {
    const outcome = await executeBooking();

    // 8. Store idempotent response
    if (idemKey) {
      const client = await pool.connect();
      try {
        if (outcome.status !== 429) {
          await client.query(
            'UPDATE idempotency_keys SET status_code = $1, response_body = $2 WHERE key = $3',
            [outcome.status, JSON.stringify(outcome.body), idemKey]
          );
        } else {
          await client.query('DELETE FROM idempotency_keys WHERE key = $1', [idemKey]);
        }
      } finally {
        client.release();
      }
    }

    return c.json(outcome.body, outcome.status as any);
  } catch (err) {
    if (idemKey) {
      const client = await pool.connect();
      try {
        await client.query('DELETE FROM idempotency_keys WHERE key = $1', [idemKey]);
      } catch {}
      finally {
        client.release();
      }
    }
    return c.json({ error: 'internal error' }, 500);
  }
});

// GET /bookings (Level 4: Pagination by email)
app.get('/bookings', async (c) => {
  const rawEmail = c.req.query('email');
  if (rawEmail === undefined || rawEmail === null) {
    return c.json({ error: 'email query parameter is required' }, 400);
  }

  const trimmedEmail = rawEmail.trim();
  if (!trimmedEmail) {
    return c.json({ error: 'email query parameter must not be empty' }, 400);
  }
  const normalizedEmail = trimmedEmail.toLowerCase();

  const limitQuery = c.req.query('limit');
  let limit = 10;
  if (limitQuery !== undefined) {
    if (!/^\d+$/.test(limitQuery)) {
      return c.json({ error: 'limit must be an integer between 1 and 50' }, 400);
    }
    limit = parseInt(limitQuery, 10);
    if (limit < 1 || limit > 50) {
      return c.json({ error: 'limit must be between 1 and 50' }, 400);
    }
  }

  const cursorQuery = c.req.query('cursor');
  let afterSeq: bigint | null = null;
  if (cursorQuery !== undefined && cursorQuery !== null && cursorQuery !== '') {
    try {
      const decoded = Buffer.from(cursorQuery, 'base64').toString('utf8');
      if (!/^\d+$/.test(decoded)) {
        return c.json({ error: 'invalid cursor' }, 400);
      }
      afterSeq = BigInt(decoded);
    } catch {
      return c.json({ error: 'invalid cursor' }, 400);
    }
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    let query = 'SELECT id, slot_id, name, email, status, created_at, seq FROM bookings WHERE LOWER(email) = $1';
    const params: any[] = [normalizedEmail];

    if (afterSeq !== null) {
      params.push(afterSeq.toString());
      query += ` AND seq > $${params.length}`;
    }

    query += ' ORDER BY seq ASC';
    params.push(limit + 1);
    query += ` LIMIT $${params.length}`;

    const res = await client.query(query, params);
    const rows = res.rows;
    const hasMore = rows.length > limit;
    const returnedRows = hasMore ? rows.slice(0, limit) : rows;

    const bookings = returnedRows.map((r: any) => ({
      id: r.id,
      slot_id: r.slot_id,
      name: r.name,
      email: r.email,
      status: r.status,
      created_at: new Date(r.created_at).toISOString(),
    }));

    const next_cursor = hasMore && returnedRows.length > 0
      ? Buffer.from(returnedRows[returnedRows.length - 1].seq.toString()).toString('base64')
      : null;

    return c.json({ bookings, next_cursor }, 200);
  } catch {
    return c.json({ error: 'internal error' }, 500);
  } finally {
    client.release();
  }
});

// GET /bookings/:id (Level 1)
app.get('/bookings/:id', async (c) => {
  const id = c.req.param('id');
  const pool = getPool();
  const client = await pool.connect();
  try {
    const res = await client.query(
      'SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1',
      [id]
    );
    if (res.rows.length === 0) {
      return c.json({ error: 'booking not found' }, 404);
    }
    const row = res.rows[0];
    return c.json({
      id: row.id,
      slot_id: row.slot_id,
      name: row.name,
      email: row.email,
      status: row.status,
      created_at: new Date(row.created_at).toISOString(),
    }, 200);
  } catch {
    return c.json({ error: 'internal error' }, 500);
  } finally {
    client.release();
  }
});

// DELETE /bookings/:id (Level 3)
app.delete('/bookings/:id', async (c) => {
  const id = c.req.param('id');
  const pool = getPool();
  const client = await pool.connect();
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
        created_at: new Date(row.created_at).toISOString(),
      }, 200);
    }

    const checkRes = await client.query('SELECT id, status FROM bookings WHERE id = $1', [id]);
    if (checkRes.rows.length === 0) {
      return c.json({ error: 'booking not found' }, 404);
    }
    return c.json({ error: 'booking already cancelled' }, 409);
  } catch {
    return c.json({ error: 'internal error' }, 500);
  } finally {
    client.release();
  }
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  return c.json({ error: 'internal error' }, 500);
});
