# Step-by-Step Implementation Guide (`step.md`)

This document details every development and architectural stage of the Clinic Booking API and React application from inception to production deployment on Vercel.

---

## Stage 1: Supabase Database Discovery & Connection Setup

1. **Database Discovery:**
   - Supabase project was identified as `koya-clinic-booking` (reference: `ozrdyjhzzvpgalhrpvau`, region: `eu-west-1`).
   - Inspected existing schema via MCP: `slots`, `bookings`, `idempotency_keys`, and `rate_limit_attempts`.
   - Verified schema columns, constraints, sequences, and indexes.

2. **Connection Configuration (`src/db.ts`):**
   - Configured `pg.Pool` with connection string targeting the Supabase transaction pooler on port 6543 (`aws-1-eu-west-1.pooler.supabase.com:6543`).
   - Configured single-connection pool (`max: 1`) per serverless instance to prevent connection exhaustion.
   - Tested atomic advisory locking syntax (`pg_advisory_xact_lock(hashtext(...))`) over transaction pooler mode.

---

## Stage 2: Level 1 - Core Routes (Slots, Bookings, Reset)

1. **Authentication Middleware:**
   - Created global Hono middleware validating the `X-API-Key` header against `process.env.API_KEY`.
   - Exempted `GET /` so the web UI could be loaded publicly without credentials.
   - Standardized 401 unauthorized responses to `{"error": "unauthorized"}`.

2. **`POST /reset`:**
   - Clears existing data (`bookings`, `slots`, `idempotency_keys`, `rate_limit_attempts`) within a single SQL transaction.
   - Inserts incoming slots with their ID, provider, start time, end time, and preserves raw string timestamps in `start_raw` and `end_raw`.

3. **`GET /slots`:**
   - Returns all slots ordered by start time ascending.
   - Supports optional `?provider=` exact filter.
   - Computes `available: false` if a confirmed booking is joined on `slot_id`.

4. **`GET /bookings/:id`:**
   - Fetches a booking record by UUID, returning 200 or 404 if not found.

- **Git Commit:** `Level 1: Slots, bookings, and reset routes` (pushed to `origin/main`).

---

## Stage 3: Level 2 - Validation & Business Logic

1. **Payload & Type Validation:**
   - Enforced string type checks for `slot_id`, `name`, and `email`.
   - Trimmed all string inputs and converted `email` to lower-case.
   - Validated email format using standard regex.
   - Returned 400 for malformed JSON or empty fields.

2. **Slot State Checks:**
   - Verified that the requested `slot_id` exists in the database (returning 404 if not found).
   - Checked that slot start time is strictly in the future (`start > now()`), returning 400 if the slot has already started.

- **Git Commit:** `Level 2: Input validation and slot existence/start-time checks` (pushed to `origin/main`).

---

## Stage 4: Level 3 - Concurrency Protection & Cancellation

1. **Partial Unique Index:**
   - Verified database partial unique index:
     ```sql
     CREATE UNIQUE INDEX idx_bookings_slot_confirmed ON public.bookings(slot_id) WHERE status = 'confirmed';
     ```
   - In `POST /bookings`, caught PostgreSQL unique violation error code `23505` and mapped it to HTTP `409 Conflict {"error": "slot already booked"}`.
   - Guarantees under simultaneous concurrent requests that only one booking succeeds and all others receive 409.

2. **`DELETE /bookings/:id`:**
   - Atomic update:
     ```sql
     UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *;
     ```
   - If zero rows returned, queries existence to differentiate between `404 Not Found` (unknown booking) and `409 Conflict` (already cancelled).
   - Cancelling a booking instantly frees up the slot for other patients.

- **Git Commit:** `Level 3: Concurrency handling with partial unique index and DELETE route` (pushed to `origin/main`).

---

## Stage 5: Level 4 - Idempotency & Cursor-Based Pagination

1. **Idempotency Engine (`Idempotency-Key` header):**
   - SHA-256 hashes raw request bodies.
   - Inserts key row into `idempotency_keys` table using `ON CONFLICT (key) DO NOTHING`.
   - If key already exists:
     - Verifies request body hash matches (returning 422 if mismatched).
     - Polls briefly for completed status code and stored JSON body.
   - Stores all terminal responses (excluding 429 rate limit responses).
   - Automatically cleans up pending keys if unexpected exceptions occur to prevent keys from getting permanently stuck.

2. **`GET /bookings` with Cursor Pagination:**
   - Requires valid `email` query parameter (matched case-insensitively).
   - Validates `limit` parameter (integer between 1 and 50, defaulting to 10).
   - Implements cursor pagination using PostgreSQL `bigserial` sequence column `seq`.
   - Encodes/decodes the last sequence ID as an opaque base64 string.
   - Queries `limit + 1` rows to determine whether `next_cursor` should be generated or set to `null`.

- **Git Commit:** `Level 4: Idempotency keys and paginated bookings list` (pushed to `origin/main`).

---

## Stage 6: Level 5 - Sliding-Window Rate Limiting

1. **Atomic Rate Limit per Email:**
   - Normalized emails (trimmed, lower-case) are rate-limited to a maximum of 5 attempts per 60-second sliding window.
   - Uses PostgreSQL advisory transaction lock:
     ```sql
     SELECT pg_advisory_xact_lock(hashtext('email@example.com'));
     ```
   - Checks attempts count in `rate_limit_attempts` table within the last 60 seconds.
   - If 5 or more attempts exist, calculates exact elapsed time until oldest attempt expires and returns `429 Too Many Requests` with a whole-second `Retry-After` header.
   - Records only allowed attempts in the database.
   - Idempotent replays bypass rate limit attempt increments.

- **Git Commit:** `Level 5: Atomic rate limiting per email with advisory locks` (pushed to `origin/main`).

---

## Stage 7: Phase 2 - Lean React Web Application

1. **React 19 + Vite Setup:**
   - Scaffolded frontend in `src/client` using React, TypeScript, and pure CSS.
   - Created `vite.config.ts` outputting build artifacts to `dist/`.
   - Configured custom `scripts/postbuild.js` script to automatically rename `dist/index.html` to `dist/template.html`.

2. **Template Serving & Dynamic Key Injection:**
   - In `src/app.ts`, handled `GET /` by reading `dist/template.html` and injecting:
     ```html
     <script>window.__API_KEY__="..."</script>
     ```
   - Served with `Cache-Control: no-store` and `Content-Type: text/html`.

3. **User Interface Features:**
   - Masked API key display (`••••••••••••`) with one-click clipboard copy button.
   - Automatic slot loader grouping available upcoming slots by medical provider and day.
   - Interactive booking modal with inline name and email validation.
   - Integration with `Idempotency-Key` using browser `crypto.randomUUID()`.
   - Real-time confirmation view with cancel button and dynamic slot re-fetching.
   - UI alerts for 400 validation, 409 slot taken, and 429 countdown wait time.

- **Git Commit:** `Web page: lean React booking UI with copy-only API key` (pushed to `origin/main`).

---

## Stage 8: Phase 3 - Vercel Deployment & Serverless Bridging

1. **Vercel Configuration:**
   - Created `vercel.json` with static routing for `/assets/*` and wildcards routed to `api/index.ts`.
   - Bundled `dist/template.html` using `includeFiles`.
   - Configured project `clinic-booking-api` linked to GitHub repository `Moshood44/Koya-Academy-Assessment`.

2. **Serverless Node.js Bridge (`api/index.ts`):**
   - Bridged standard Node.js `(req, res)` HTTP request/response streams into web standard `Request`/`Response` for Hono.
   - Configured production environment variables on Vercel:
     - `DATABASE_URL`: Supabase connection pooler URL.
     - `API_KEY`: 64-character hex string.

3. **Production Deployment & Verification:**
   - Deployed directly to production via `vercel --prod --yes`.
   - Verified live `GET /` serves the injected template with HTTP 200.
   - Verified live `GET /slots` with `X-API-Key` returns slot records with HTTP 200.
