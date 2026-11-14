import { Hono } from 'hono';
import { getPool } from './db.js';
import crypto from 'node:crypto';

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

// POST /bookings (Level 3: concurrency & conflict handling)
app.post('/bookings', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'malformed body' }, 400);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'malformed body' }, 400);
  }

  const { slot_id, name, email } = body;

  if (typeof slot_id !== 'string' || typeof name !== 'string' || typeof email !== 'string') {
    return c.json({ error: 'slot_id, name, and email must be strings' }, 400);
  }

  const trimmedSlotId = slot_id.trim();
  const trimmedName = name.trim();
  const trimmedEmail = email.trim();

  if (!trimmedSlotId || !trimmedName || !trimmedEmail) {
    return c.json({ error: 'slot_id, name, and email must not be empty' }, 400);
  }

  if (!isValidEmail(trimmedEmail)) {
    return c.json({ error: 'invalid email address' }, 400);
  }

  const normalizedEmail = trimmedEmail.toLowerCase();

  const pool = getPool();
  const client = await pool.connect();
  try {
    const slotRes = await client.query('SELECT id, start FROM slots WHERE id = $1', [trimmedSlotId]);
    if (slotRes.rows.length === 0) {
      return c.json({ error: 'slot not found' }, 404);
    }

    const slotStart = new Date(slotRes.rows[0].start);
    if (slotStart <= new Date()) {
      return c.json({ error: 'slot has already started' }, 400);
    }

    const bookingId = crypto.randomUUID();
    const res = await client.query(
      'INSERT INTO bookings (id, slot_id, name, email, status) VALUES ($1, $2, $3, $4, $5) RETURNING id, slot_id, name, email, status, created_at',
      [bookingId, trimmedSlotId, trimmedName, normalizedEmail, 'confirmed']
    );
    const row = res.rows[0];
    return c.json({
      id: row.id,
      slot_id: row.slot_id,
      name: row.name,
      email: row.email,
      status: row.status,
      created_at: new Date(row.created_at).toISOString(),
    }, 201);
  } catch (err: any) {
    if (err && err.code === '23505') {
      return c.json({ error: 'slot already booked' }, 409);
    }
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

// DELETE /bookings/:id (Level 3: cancellation)
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

    // Zero rows updated: check if booking exists to decide 404 vs 409
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
