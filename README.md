# Festival flash sale

Runnable full-stack reference application for a 500-phone sale. Quantity is **1–500 units per order**, allocated all-or-nothing. PostgreSQL is the inventory authority; Redis performs atomic provisional admission; RabbitMQ and a durable PostgreSQL inbox/outbox dispatch asynchronous work. Payment is explicitly simulated.

See [the architecture, trade-offs, lifecycle, failure analysis, and requirement checklist](docs/architecture.md). This is a working reference, **not a verified 100,000-concurrent-request deployment**.

## Run

Requires Docker Engine and Docker Compose v2 (Compose supporting health-based dependencies), or Node.js 22+ with the three services. Development credentials in Compose are local demo values; replace them before deployment.

```sh
# From this repository. Opens the demo immediately:
SALE_START=2000-01-01T00:00:00Z docker compose up --build -d
# Inspect readiness and structured logs:
docker compose ps
docker compose logs --tail=50 api relay worker
```

The gateway serves the UI on port **8080**. The default event is October 28, 2026 at **8:00 PM Asia/Kolkata** (`2026-10-28T14:30:00Z`); set `SALE_START` to your event's ISO timestamp. It is server-enforced. Before the event, new checkout requests receive HTTP 425.

In a managed cloud environment that requires the session CA for dependency downloads, build with the provided CA first (do not disable TLS verification):

```sh
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -t festival-flash-app .
SALE_START=2000-01-01T00:00:00Z docker compose up -d --no-build
```

The optional Dockerfile CA mount supports ordinary local builds without a custom CA. Database migration runs once per Compose startup and is idempotent. Images use major-version tags for ease of development; pin reviewed digests in production.

### Host development

```sh
npm ci --ignore-scripts
docker compose up -d postgres redis rabbit
npm run migrate
# Separate terminals, same environment (or export values from .env.example):
SALE_START=2000-01-01T00:00:00Z npm start
npm run relay
npm run worker
```

Host Node processes default to loopback service ports and API port 3000. Node does not automatically load `.env`; either export variables or use `node --env-file=.env src/server.js` after copying `.env.example`. In Compose, `.env` supplies interpolation values for settings listed in `compose.yaml`. Only the gateway exposes the API in Compose. `docker compose up -d --scale api=3 --scale worker=2` adds replicas; Nginx least-connections balances API DNS members. Increase aggregate DB pool sizes only within the database connection budget.

### API

```sh
curl -i -X POST http://127.0.0.1:8080/api/checkout \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-checkout-000001' \
  -d '{"quantity":3,"paymentOutcome":"success"}'
# Read using the returned orderId and statusToken:
curl http://127.0.0.1:8080/api/orders/ORDER_ID -H 'Authorization: Bearer STATUS_TOKEN'
```

Save the idempotency key and body before sending. Retry the **same key and body** after any uncertain response. A changed payload with the same key returns 409. Accepted `202` is queued/reserved; **only `state: confirmed` means purchase success**. Duplicate terminal requests return 200 with the same order. `400` invalid, `425` not open, `429` rate limited, `503` overloaded/unavailable. Failures before the response can have an uncertain commit: retry, never switch keys. `GET /api/product` shows approximate cached availability; `GET /api/orders/:id` is the authoritative order view. No credentials in query strings.

`paymentOutcome` is a demo-only setting: `success`, `decline`, or `timeout`. Reservation is held for `RESERVATION_TTL_MS` (default 30 seconds). A simulated successful/declined payment becomes eligible after `PAYMENT_DELAY_MS` (default 1.5 seconds), and the relay dispatches due work at up to ~2-second intervals. An independent worker sweep releases expired reservations every 500 ms when the database is available. The UI can resume a pending checkout after a reload within the same tab.

## Essential tests

**Use a disposable database: these tests erase orders and reset stock. Stop API/relay/worker containers first** to avoid their modifying test data. Infrastructure services must be healthy.

```sh
npm ci --ignore-scripts
docker compose stop gateway api relay worker
docker compose up -d postgres redis rabbit
npm run migrate
ALLOW_TEST_RESET=1 npm test
```

The tests start their own host API on port 3100, relay, and worker, and use the configured service URLs. Five real-service tests cover concurrent allocation, multi-unit final-stock purchases, duplicate processing, payment decline/timeout/reuse, Redis admission/TTL, validation, idempotency conflict, status authorization, HTML delivery, and HTTP-to-broker-to-worker checkout. Tests clean up their child processes. Do not point them at a live sale.

```sh
# Small load run (the sale must be open):
REQUESTS=1000 CONCURRENCY=100 npm run load
# Target scenario; run only against a disposable, provisioned environment:
REQUESTS=100000 CONCURRENCY=100000 BASE_URL=https://YOUR_TEST_HOST npm run load
```

The generator reports response codes, latency, and throughput; it has a 15-second request timeout. It is a closed-loop generator, not proof of arrival rate or 100k established simultaneous connections. Use multiple load hosts, check file descriptor/ephemeral-port limits, and measure actual arrivals in the first 10 seconds. Single-IP tests intentionally hit rate limits; distributed legitimate users and abusive traffic need separate scenarios. Never disable production controls to claim capacity. No full-scale benchmark is included.

## Operations

- `docker compose logs -f api relay worker`: structured JSON events; no request bodies, keys or status tokens are logged.
- `docker compose exec postgres psql -U flash -d flash -c 'TABLE inventory;'`: inspect stock; `available + reserved + confirmed = 500`.
- `SELECT * FROM dead_letters;` records exhausted application retries. RabbitMQ `checkout.dead` retains failed delivery attempts/poison messages; investigate before reprocessing. DB dispatch is the authoritative pending-work retry source.
- Reconciliation audits aggregate order quantities against inventory every five seconds; it alerts/stops that worker on a mismatch, never repairs by guessing. Expiry uses order row locks, then updates stock transactionally. No manual counter resets during a sale.
- Broker outage: pending inbox rows persist and relay retries. Redis outage: new admission fails closed; existing work proceeds. DB outage: no new acceptance; existing requests remain pending until recovery. See the failure table for boundaries.
- Restart: `docker compose up -d --no-build`. Volumes retain database, Redis and broker data; live processes do not survive a new environment.
- Stop: `docker compose down` preserves named volumes. **`down -v` destroys sale data**; only use explicitly on disposable demos. There is no automatic inventory reset on restart or migrate.

## Files

```text
compose.yaml             PostgreSQL, Redis, RabbitMQ, migration, API, relay, worker, gateway
Dockerfile               Non-root Node.js application image
infra/nginx.conf         Limits, bounded timeouts, balancing, product cache
migrations/001.sql       Inventory invariants, order/inbox and dispatch schema
src/config.js            Environment settings and structured logging
src/db.js                Bounded pool and transaction helper
src/migrate.js           Serialized, idempotent schema setup
src/admission.js         Atomic Redis multi-unit admission leases and rate limiting
src/orders.js            Idempotency, enqueue, inventory state machine, reconciliation
src/broker.js            Durable bounded queues and publisher confirms
src/server.js            Validation, checkout/status API, frontend delivery
src/relay.js             Durable dispatch to RabbitMQ with retry
src/worker.js            Bounded consumption, transactional handling, expiry/audit
public/                  Accessible product/checkout UI (no frontend dependencies)
tests/checkout.test.js    Essential real-service integration tests
scripts/load.js          Configurable concurrent HTTP load generator
docs/architecture.md     Design, capacity plan, failures and requirement validation
```
