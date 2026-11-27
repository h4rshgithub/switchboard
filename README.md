# Switchboard

A shared team inbox for support agents. Multiple workspaces (`ws_acme`, `ws_globex`) share one deployment with strict tenant isolation, real-time WebSocket updates, crash-safe outbound delivery, and end-to-end encrypted private notes.

## Quick start (from a clean clone)

```bash
# 1. Start MongoDB, Redis, Pigeon, Mock IdP, and Paybox
npm run up
npm run doctor

# 2. Install dependencies
npm run scaffold:install

# 3. Start the server (uses PORT, default 4000)
npm --prefix scaffold/server start

# 4. Start the React web UI (http://localhost:5173)
npm --prefix scaffold/web run dev
```

## Running tests & checks

```bash
# Unit tests (signature verification, out-of-order status protection, cookie/role helpers)
npm --prefix scaffold/server test

# Typecheck server and web
npm --prefix scaffold/server run typecheck
npm --prefix scaffold/web run typecheck

# Grader harness (stop your dev server first)
npm run check
npm run check:full
```

## Architecture

- **Server (`scaffold/server`)**: Express + TypeScript (`tsx`), MongoDB (`mongodb`), Redis (`ioredis`), WebSockets (`ws`).
- **Web (`scaffold/web`)**: React 19 + Vite + Web Crypto API (ECDH P-256 + HKDF-SHA256 + AES-256-GCM for private notes; see `PROTOCOL.md`).
- **Reliability**:
  - **Inbound webhooks (`POST /webhooks/pigeon`)**: Raw-body HMAC-SHA256 verification with 5-minute replay window, `400` on malformed JSON, `200` on unknown event types/workspaces/statuses, and MongoDB unique index `{ workspace, message_id }` for idempotent deduplication. Messages are ordered by `occurred_at`.
  - **Outbound replies**: Stored in MongoDB (`outbound_messages`) before returning `202`. Workers claim jobs with an 18s lease for multi-instance failover, send `Idempotency-Key`, and coordinate per-workspace token-bucket rate limiting and `Retry-After` cooldowns in Redis via Lua.
  - **Atomic claim**: MongoDB `findOneAndUpdate` with `{ $or: [{ assignee: null }, { assignee: agent }] }` guarantees at most one winner.
  - **Real-time & replay (`GET /ws`)**: Authenticated by OIDC session cookie and workspace membership; per-workspace `seq` via Redis `INCR`, history in Redis sorted set for `?after=<seq>` replay, and cross-instance fan-out via Redis Pub/Sub.
