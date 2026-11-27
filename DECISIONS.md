# Decisions

## What I built

- **Core product & resilience (Levels 1, 2, 3, 5 + Level 4 rules)**:
  - **Inbound webhooks (`POST /webhooks/pigeon`)**: Verifies `x-pigeon-signature` against the exact raw request body (`express.raw`) with `timingSafeEqual` and a 300-second replay window (`401` on missing/invalid/stale, `400` on malformed JSON, `200` on unknown `type` or unknown `workspace`). Deduplicates on MongoDB unique index `{ workspace, message_id }` and sorts inbound messages by `occurred_at`.
  - **Outbound outbox & worker**: `POST /__grader/reply` and `POST /api/conversations/:contact/reply` persist to `outbound_messages` in MongoDB before returning `202`. Background workers across all instances claim jobs using an 18s MongoDB lease (`lease_until`), send `Idempotency-Key: <workspace>:<client_ref>`, and share a Redis Lua token-bucket rate limiter (7 capacity, 3.5/s refill) + `Retry-After` cooldown key (`pigeon:cooldown:<workspace>`). Status webhooks advance monotonically via `status_rank` (`queued < sent < delivered|failed`) so out-of-order `sent` after `delivered` is ignored.
  - **Atomic claim**: `findOneAndUpdate` on `{ workspace, contact, $or: [{ assignee: null }, { assignee: agent }] }`.
  - **OIDC Login & Tenant Isolation**: Authorization Code + PKCE (`S256`), `id_token` RS256 verification against `/jwks`, Redis-backed `HttpOnly` session cookies (`sb_session`), workspace membership checks on `/api/*` and `/ws`.
  - **Real-time WebSocket**: Redis `INCR` for per-workspace `seq`, Redis `ZSET` for `?after=N` replay, and Redis Pub/Sub for cross-instance delivery with buffering during replay so no frames are missed or duplicated.
- **Frontend (`scaffold/web`)**: React inbox with workspace switcher, open/closed/all filters, pagination, real-time WebSocket updates with auto-reconnect (`?after=`), claim/release/close/reopen controls, and outbound status badges.
- **End-to-End Encrypted Private Notes (`PROTOCOL.md`)**: Browser-side ECDH P-256 identity keys + HKDF-SHA256 + AES-256-GCM workspace key wrapping and note encryption.
- **Tests**: Unit tests in `scaffold/server/src/pigeon.test.ts` and `auth.test.ts` using `node:test`.

## What I cut

- **Elasticsearch search**: Skipped due to 4 GB RAM limit on the development machine (`npm run doctor` warning).
- **Bonus billing (Paybox)**: Skipped to focus on core reliability, E2EE notes, and tests.

## Assumptions

- Known workspaces are defined by `config.pigeon.apiKeys` (`ws_acme`, `ws_globex`); unknown workspaces return `404` on `/__grader/reply` and `/__grader/claim`, and `200` (ignored) on `/webhooks/pigeon`.
- `claim` for an already-held conversation by the same agent returns `200` without emitting a duplicate `conversation.assigned` event.

## Known issues / what I know is still wrong

- **Key distribution trust**: Public keys (`user_keys`) are served by the server without out-of-band fingerprint verification (documented in `PROTOCOL.md`).
- **Windows local check environment**: `harness/check.js` spawns `sh -c` and uses POSIX negative-PID `SIGKILL`; on Windows, Git Bash `sh` is required in `PATH` and `SIGKILL` process-group termination behaves differently than on Linux.
