# Legacy RPA delivery and recovery

`POST /devices/:id/rpa` accepts an optional `idempotencyKey` of 8–100 characters. Reuse the same key and payload when retrying an HTTP request. The response includes the saved `jobId` and `delivery`:

- `queued`: the queue acknowledged the saved intent.
- `pending`: the database saved the intent and automatic queue reconciliation will retry. Do not submit another request with a new key.
- `settled`: this idempotency key already reached its current terminal or remote-submission state; no new provider submission is scheduled.

The worker uses a stable queue identity and a database claim before remote dispatch. A lost provider response becomes `unconfirmed` and retains phone ownership. Submitted, submitting, and unconfirmed jobs are never retried automatically. The outbox repairs only `enqueue_pending` and `queued` records, including retained failed queue records.

Authenticated operators can inspect `GET /devices/:id/rpa` and resolve a job through `POST /devices/:id/rpa/:jobId/resolve`. Resolution requires a current `expectedUpdatedAt`, `providerIdleConfirmed: true`, an evidence note, and outcome `completed` or `cancelled`. Completion is accepted only for a possibly submitted job. The original status/error and operator evidence are retained in a device event. Check and stop/finish the remote task before confirming; elapsed time alone never proves completion.

## Isolated tests

Run `npm test`, `npm run test:warmup`, and `npm run test:rpa` after generating the SQLite Prisma client. The RPA integration requires `redis-server` on `PATH`, or `REDIS_SERVER_BINARY` pointing to its executable. It starts a temporary Redis bound to loopback on a free port and creates a temporary SQLite database. All provider submissions are stubbed, and resources are removed after the run. It does not use deployed databases, Redis services, or devices. This test is intentionally separate from the production build.
