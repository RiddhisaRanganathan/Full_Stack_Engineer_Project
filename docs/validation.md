# Validation record

Validated October 28, 2026 in the development environment.

- Node.js v24.19.0 host; Node.js 22 application container. Dependency installation used the lockfile. Application Docker image built with TLS verification and the session CA.
- PostgreSQL 16, Redis 7 and RabbitMQ 4 real containers started and became healthy. Nginx 1.28 served the complete stack. Migration ran successfully and was reapplied without resetting inventory.
- Final `ALLOW_TEST_RESET=1 npm test`: **5 passed, 0 failed, 0 skipped**. Includes concurrent 120 × 5-unit allocations against 500 units, duplicate processing, 237+263-unit purchases, decline/timeout/release/resale, expiry sweep, atomic Redis lease cap/expiry, duplicate HTTP requests and conflict/authorization checks, accepted requests before workers start, and HTTP → inbox → RabbitMQ → worker → confirmed status.
- Full Compose/Nginx functional checkout: 3-unit request returned 202 and subsequently confirmed. The destructive test run afterwards reset this demo purchase.
- Final load-generator smoke: 25 requests at configured concurrency 10 through Nginx; **20 HTTP 202, 5 HTTP 429**, no network errors. This validates script execution and explicit overload semantics only. It is not a capacity benchmark. The 20 accepted single-unit demo orders are retained in the running stack.
- Gateway file-descriptor configuration corrected using explicit Compose `nofile` limits. Final gateway starts without the earlier `setrlimit` warnings.
- JavaScript module: 3,770 source bytes, 1,679 source-gzip bytes. This is not a minified-bundle or browser TTI measurement.
- `git diff --check` and Node syntax checks passed. Application source is left uncommitted for review.

Not validated: 100,000-request scenario, real device TTI/LCP/INP, CDN/waiting room, assistive technology, real payments or shipping, replicated database/broker failover, disk-loss recovery, exhaustive chaos tests, production authentication/bot protection. The architecture documents conditional correctness/durability assumptions and required production work explicitly.
