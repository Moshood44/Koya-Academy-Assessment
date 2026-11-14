# Clinic Booking API & Web Application

A robust, production-ready Clinic Booking API with an interactive React single-page frontend. Built with **Node.js**, **TypeScript**, **Hono**, **PostgreSQL (Supabase transaction pooler)**, and deployed serverless on **Vercel**.

---

## Live Endpoints

- **Web Application / Page:** [https://clinic-booking-api-lyart-one.vercel.app/](https://clinic-booking-api-lyart-one.vercel.app/)
- **Live Base URL:** `https://clinic-booking-api-lyart-one.vercel.app`
- **Production API Key:** `c2584a6f11e6401cb2cc555aa45c27ef902228f1c0354d039a9064563b122a9c`

---

## Overview & Architecture

### Backend: Runtime-Agnostic Hono on Node.js
- **Framework:** Hono with `@hono/node-server` bridge for standard Node.js serverless functions.
- **Database:** PostgreSQL on Supabase accessed via transaction pooler (port 6543) using `pg.Pool` (connection reuse, small pool, no prepared statements).
- **Authentication:** All API routes require `X-API-Key` header matching `API_KEY`. Unauthenticated requests receive `401 {"error": "unauthorized"}`. The root route (`GET /`) is exempt from this check to serve the frontend web page.
- **Concurrency & Double-Booking Protection:** Guaranteed by PostgreSQL partial unique index on `bookings(slot_id) WHERE status = 'confirmed'`. Simultaneous booking requests result in exactly one 201 Created and all others 409 Conflict.
- **Idempotency:** Implemented with `Idempotency-Key` header and request hash matching in `idempotency_keys` table. Safe under race conditions with response polling and conflict resolution.
- **Rate Limiting:** Atomic sliding-window rate limit (max 5 booking attempts per email per minute) enforced with PostgreSQL advisory transaction lock `pg_advisory_xact_lock(hashtext(email))`. Returns `429` with exact `Retry-After` header in whole seconds.

### Frontend: Lean React Single-Page App
- **Stack:** React 19 + TypeScript + Vite (vanilla CSS, zero heavyweight UI dependencies).
- **Security:** API key is securely injected at request-time into `dist/template.html` via `<script>window.__API_KEY__="..."</script>` with `Cache-Control: no-store`. The key is never committed to Git and is displayed only as masked dots (`••••••••••••`) with a one-click copy button.
- **Features:**
  - Displays upcoming available slots grouped by medical provider and day.
  - Interactive booking modal with client-side validation.
  - Automatically generates `crypto.randomUUID()` for idempotency on booking submissions.
  - Instant confirmation display with booking details and one-click cancellation.
  - Graceful handling and banner alerts for 400 (validation), 409 (conflict), 429 (rate-limit with countdown), and network errors.

---

## API Specification

All request and response payloads use JSON. All error responses conform to `{"error": "<message>"}`. Timestamps are formatted as ISO 8601 UTC strings.

### `POST /reset`
Resets the clinic database in a single atomic transaction: deletes all existing bookings, idempotency keys, rate limit attempts, and replaces all slots with the provided array.
- **Headers:** `X-API-Key: <key>`
- **Request Body:**
  ```json
  {
    "slots": [
      {
        "id": "s1",
        "provider": "Dr Ade",
        "start": "2026-12-10T09:00:00Z",
        "end": "2026-12-10T09:30:00Z"
      }
    ]
  }
  ```
- **Response:** `200 {"ok": true}` | `400 {"error": "malformed body"}`

---

### `GET /slots`
Returns all slots ordered earliest start first, including past and booked slots.
- **Headers:** `X-API-Key: <key>`
- **Query Params:** `?provider=<exact match>` (optional)
- **Response:** `200`
  ```json
  {
    "slots": [
      {
        "id": "s1",
        "provider": "Dr Ade",
        "start": "2026-12-10T09:00:00Z",
        "end": "2026-12-10T09:30:00Z",
        "available": true
      }
    ]
  }
  ```
  *(Note: `available` is `false` only if the slot has an active confirmed booking).*

---

### `POST /bookings`
Books a slot for a patient.
- **Headers:**
  - `X-API-Key: <key>`
  - `Idempotency-Key: <opaque-string>` (optional)
- **Request Body:**
  ```json
  {
    "slot_id": "s1",
    "name": "Jane Doe",
    "email": "jane@example.com"
  }
  ```
- **Response Status Codes:**
  - `201 Created`:
    ```json
    {
      "id": "uuid-here",
      "slot_id": "s1",
      "name": "Jane Doe",
      "email": "jane@example.com",
      "status": "confirmed",
      "created_at": "2026-11-14T14:00:00.000Z"
    }
    ```
  - `400 Bad Request`: Missing/empty/non-string fields, invalid email format, or slot has already started (`start <= now()`).
  - `404 Not Found`: Slot does not exist.
  - `409 Conflict`: Slot already booked by a confirmed booking.
  - `422 Unprocessable Entity`: Same `Idempotency-Key` sent with a different request body payload.
  - `429 Too Many Requests`: Exceeded 5 booking attempts for this email within 60 seconds. Includes `Retry-After: <seconds>` header.

---

### `GET /bookings`
Returns paginated bookings for a specific email, oldest first.
- **Headers:** `X-API-Key: <key>`
- **Query Params:**
  - `email` (required, matched case-insensitively)
  - `limit` (integer 1-50, default 10)
  - `cursor` (opaque base64 string from `next_cursor`, optional)
- **Response:** `200`
  ```json
  {
    "bookings": [
      {
        "id": "uuid",
        "slot_id": "s1",
        "name": "Jane Doe",
        "email": "jane@example.com",
        "status": "confirmed",
        "created_at": "2026-11-14T14:00:00.000Z"
      }
    ],
    "next_cursor": "MQ=="
  }
  ```

---

### `GET /bookings/:id`
Retrieves a booking by ID.
- **Headers:** `X-API-Key: <key>`
- **Response:** `200` with booking details or `404 {"error": "booking not found"}`.

---

### `DELETE /bookings/:id`
Cancels a confirmed booking and frees up the slot for other patients.
- **Headers:** `X-API-Key: <key>`
- **Response:**
  - `200 OK`: Updated booking with `"status": "cancelled"`.
  - `404 Not Found`: Booking ID does not exist.
  - `409 Conflict`: Booking has already been cancelled.

---

## Local Development & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Moshood44/Koya-Academy-Assessment.git
   cd Koya-Academy-Assessment
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment:**
   Create `.env` (git-ignored):
   ```ini
   DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-1-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=disable"
   API_KEY="your-secret-api-key"
   ```

4. **Build Frontend:**
   ```bash
   npm run build
   ```

5. **Run Locally:**
   ```bash
   npx tsx src/app.ts
   ```
