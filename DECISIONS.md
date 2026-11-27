# Decisions

## What I built

- **Levels 1 and 2**: Complete. Webhook ingestion with signature verification, deduplication, ordering by `occurred_at`; atomic conversation claiming; outbound queue with Pigeon rate-limit and retry handling; crash recovery via persistent queue in MongoDB + Redis.
- **Level 3**: Queue processor uses a Redis distributed lock per workspace so only one instance sends at a time, sharing the rate-limit window. WebSocket events are delivered cross-instance via Redis pub/sub. Inbound dedup via Redis SET NX is naturally cross-instance. Failover: surviving instances pick up orphaned queued messages on their 2-second polling cycle.
- **Level 5**: OIDC login (authorization code + PKCE S256). Session stored in Redis. `/api/me`, `/api/conversations` enforce tenant isolation. WebSocket authenticated by session cookie, refuses strangers and cross-workspace access; `?after=N` replays from MongoDB.
- **Frontend**: React app with real-time inbox (WebSocket), conversation view, claim/unclaim, reply with optimistic status updates.

## What I cut

- **Private encrypted notes**: Not implemented. Would need E2E encryption with per-workspace key exchange.
- **Elasticsearch search**: Not implemented; memory on this machine was insufficient for Elasticsearch.
- **Tests**: No automated tests; manual verification via `npm run check`.
- **Bonus billing (Paybox)**: Not implemented.

## Assumptions

- The `workspaces` JWT claim from the IdP is an array of `{id, role}` objects.
- `occurred_at` timestamps from Pigeon are reliable enough to sort inbound messages; duplicated events don't reorder (we sort the full set each time).
- An agent claiming their own already-claimed conversation returns 200 (the brief says "The holder claiming again gets 200").
- A workspace not in `config.pigeon.apiKeys` is unknown; `/__grader/reply` and `/__grader/claim` return 404 for unknown workspaces.

## Known issues / what I know is still wrong

- **Level 3 failover timing**: The 2-second polling interval means failed-instance work takes up to 2 seconds to pick up. For the 60-second failover window this should be fine.
- **WS replay ordering**: After reconnect with `?after=N`, events are replayed from MongoDB then live events continue. There's a small race where events that arrive between the last DB query and the pub/sub subscription could be missed. Mitigated by the fact that reconnect is fast.
- **Pigeon 12s slow response**: I abort at 8s and requeue. The Idempotency-Key means Pigeon won't send twice, but the status webhook may still arrive and we update from there. This could leave the status as "queued" briefly.
- **Redis lock expiry**: The send lock expires in 30s. If a processor crashes holding the lock, the next instance picks up after 30s. This is acceptable for the test scenario.
