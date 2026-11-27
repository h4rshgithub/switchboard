# Switchboard

A shared team inbox for support agents. Multiple businesses (workspaces) use a single deployment; agents log in, see conversations in real time, claim and reply to them.

## Quick start (from a clean clone)

```bash
# 1. Start MongoDB and Redis (must be running on default ports)
# If you have Docker:
npm run up

# 2. Install dependencies
npm run scaffold:install   # or: npm install --prefix scaffold/server && npm install --prefix scaffold/web

# 3. Start the server
npm --prefix scaffold/server start   # PORT defaults to 4000

# 4. (Optional) Start the web UI
npm --prefix scaffold/web run dev    # on http://localhost:5173
```

## Configuration

All configuration comes from environment variables. Copy `.env.example` to `.env` to override defaults.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | Server port |
| `MONGO_URL` | `mongodb://localhost:27017/switchboard` | MongoDB connection |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `PIGEON_WEBHOOK_SECRET` | `whsec_pigeon_dev` | Webhook signing secret |
| `GRADER_TOKEN` | `grader-dev-token` | Check harness token |
| `OIDC_ISSUER` | `http://localhost:4020` | OpenID Connect issuer |

## Check commands

```bash
npm run check           # Level 1 only (~90s)
npm run check:full      # Levels 1,2,3,5 (~4m), writes CHECK_REPORT.json
npm run doctor          # Verify all services are reachable
```

**Stop your dev server before running checks** – the check starts its own server.

## Architecture

- **Server**: Express + TypeScript, `tsx` runtime
- **Database**: MongoDB (conversations, messages, outbound queue, WS events)
- **Cache/Queue**: Redis (sessions, distributed locks, rate-limit state, pub/sub)
- **WebSocket**: `ws` library with Redis pub/sub for cross-instance delivery
- **Frontend**: React + Vite

### Key design decisions

- Webhook deduplication via Redis `SET NX` on `x-pigeon-event-id`
- Atomic conversation claim via MongoDB `findOneAndUpdate` with `{assignee: null}` filter
- Outbound queue stored in MongoDB + Redis list; processor holds a Redis lock per workspace
- WebSocket events persisted to MongoDB for replay (`?after=N`)
- Rate limit state shared in Redis (key `rate:retry:<workspace>`)
