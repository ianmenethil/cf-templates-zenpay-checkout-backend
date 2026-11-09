-- One row per checkout attempt. `id` is the merchantUniquePaymentId sent to ZenPay; a new one is made for every attempt.
-- `amount_cents` is the launch amount in whole cents, so money is never stored as a float.
-- `reference` and `gateway_status` come from the latest verified callback that changed the payment (a callback that
-- arrives after the payment is `succeeded` or `failed` changes nothing) and are null until one arrives.
CREATE TABLE payments (
  id                 TEXT PRIMARY KEY,
  mode               INTEGER NOT NULL CHECK (mode IN (0, 1, 2, 3)),
  amount_cents       INTEGER NOT NULL CHECK (amount_cents >= 0),
  customer_name      TEXT NOT NULL,
  customer_email     TEXT NOT NULL,
  customer_reference TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('pending', 'unverified', 'processing', 'succeeded', 'failed')),
  reference          TEXT,
  gateway_status     INTEGER,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- Lists every payment newest first, a page at a time.
CREATE INDEX payments_created ON payments (created_at DESC, id DESC);

-- Lists the payments in one state newest first.
CREATE INDEX payments_state_created ON payments (state, created_at DESC, id DESC);

-- Lets the daily clean-up find old payments without reading every row.
CREATE INDEX payments_updated ON payments (updated_at);

-- One row per callback body ZenPay (or anyone else) posts. A repeat of the same body for the same payment adds to
-- `deliveries` instead of adding a row. `payment_id` is null when the callback address carried no readable
-- payment, or named a payment that does not exist. `body_hash` is the SHA-256 of the body's bytes in hex.
-- `outcome` is what the Worker made of the callback: verified, unsigned, or rejected. `reason` says why a callback was
-- rejected and is null otherwise. `size` is the length in bytes of the body as received. `body` is that body as text,
-- cut to its first 4096 bytes (at a character) for a rejected callback or one with no payment; `size` stays the full length.
CREATE TABLE callbacks (
  id               TEXT PRIMARY KEY,
  payment_id       TEXT REFERENCES payments (id) ON DELETE CASCADE,
  body_hash        TEXT NOT NULL,
  received_at      TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  deliveries       INTEGER NOT NULL DEFAULT 1,
  outcome          TEXT NOT NULL CHECK (outcome IN ('verified', 'unsigned', 'rejected')),
  reason           TEXT,
  size             INTEGER NOT NULL,
  body             TEXT NOT NULL
);

-- The same body for the same payment is one callback. SQLite treats every NULL as different,
-- so callbacks with no payment are all stored.
CREATE UNIQUE INDEX callbacks_payment_body ON callbacks (payment_id, body_hash);

-- Lists a payment's callbacks newest first, and lets the payment list add up their deliveries without reading the rows.
CREATE INDEX callbacks_payment_received ON callbacks (payment_id, received_at DESC, id DESC, deliveries);

-- Lists every callback newest first, a page at a time.
CREATE INDEX callbacks_received ON callbacks (received_at DESC, id DESC);

-- Lists the callbacks with one outcome newest first.
CREATE INDEX callbacks_outcome_received ON callbacks (outcome, received_at DESC, id DESC);

-- Lets the daily clean-up find old callbacks that belong to no payment without reading every row.
CREATE INDEX callbacks_orphan_last_received ON callbacks (last_received_at) WHERE payment_id IS NULL;
