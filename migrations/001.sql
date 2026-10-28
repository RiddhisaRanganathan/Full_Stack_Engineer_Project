CREATE TABLE IF NOT EXISTS inventory (
 id integer PRIMARY KEY CHECK (id = 1),
 total integer NOT NULL CHECK (total = 500),
 available integer NOT NULL CHECK (available >= 0),
 reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
 confirmed integer NOT NULL DEFAULT 0 CHECK (confirmed >= 0),
 CHECK (available + reserved + confirmed = total)
);
INSERT INTO inventory(id,total,available) VALUES(1,500,500) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS orders (
 id uuid PRIMARY KEY,
 idem_key text NOT NULL UNIQUE,
 status_token text NOT NULL,
 payload_hash text NOT NULL,
 quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 500),
 payment_outcome text NOT NULL CHECK (payment_outcome IN ('success','decline','timeout')),
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','reserved','confirmed','rejected','failed','expired')),
 payment_state text NOT NULL DEFAULT 'not_started' CHECK (payment_state IN ('not_started','pending','paid','declined','cancelled')),
 fulfillment_state text NOT NULL DEFAULT 'not_started' CHECK (fulfillment_state IN ('not_started','ready','shipped')),
 reason text,
 expires_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_pending ON orders(next_attempt_at) WHERE state IN ('queued','reserved');
CREATE INDEX IF NOT EXISTS orders_expiry ON orders(expires_at) WHERE state='reserved';
CREATE TABLE IF NOT EXISTS dispatch (
 order_id uuid PRIMARY KEY REFERENCES orders(id),
 next_publish_at timestamptz NOT NULL DEFAULT now(),
 publishes integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS dispatch_due ON dispatch(next_publish_at);
CREATE TABLE IF NOT EXISTS dead_letters (
 order_id uuid PRIMARY KEY REFERENCES orders(id),
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
-- Serialize only bounded inbox capacity checks; inventory is never touched by the API.
CREATE TABLE IF NOT EXISTS admission_lock(id integer PRIMARY KEY CHECK(id=1));
INSERT INTO admission_lock VALUES(1) ON CONFLICT DO NOTHING;
