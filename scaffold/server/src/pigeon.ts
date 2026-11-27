import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { getDb } from './db.js';
import { ensureConversation, isKnownWorkspace } from './domain.js';
import { emitWorkspaceEvent } from './events.js';
import { getRedis, getSubRedis } from './redis.js';

export const STATUS_RANK: Record<string, number> = {
  queued: 1,
  sent: 2,
  delivered: 3,
  failed: 3,
};

export function shouldAdvanceStatus(currentRank: number, nextStatus: string): number | null {
  const rank = STATUS_RANK[nextStatus];
  if (!rank || rank <= currentRank) return null;
  return rank;
}

const MAX_TIMESTAMP_SKEW_SEC = 300; // 5 minutes
const PIGEON_TIMEOUT_MS = 14_000;
const LEASE_MS = 18_000;

/**
 * Verifies Pigeon's `x-pigeon-signature: t=<unix>,v1=<hex>` header against raw body.
 */
export function verifyPigeonSignature(
  header: string | undefined,
  rawBody: Buffer,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  if (!header || typeof header !== 'string') return false;

  let timestampStr: string | undefined;
  let sigHex: string | undefined;

  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') timestampStr = v;
    else if (k === 'v1') sigHex = v;
  }

  if (!timestampStr || !sigHex) return false;
  if (!/^\d+$/.test(timestampStr)) return false;
  if (!/^[0-9a-f]{64}$/i.test(sigHex)) return false;

  const t = Number(timestampStr);
  if (!Number.isSafeInteger(t)) return false;

  // Reject timestamps more than 5 minutes old (or far in the future)
  if (nowSec - t > MAX_TIMESTAMP_SKEW_SEC || t - nowSec > MAX_TIMESTAMP_SKEW_SEC) {
    return false;
  }

  const payload = Buffer.concat([Buffer.from(`${timestampStr}.`, 'utf8'), rawBody]);
  const expected = createHmac('sha256', secret).update(payload).digest();
  const provided = Buffer.from(sigHex, 'hex');
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}

export async function handlePigeonWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === 'string' ? req.body : '', 'utf8');

  const sigHeader = req.header('x-pigeon-signature');
  if (!verifyPigeonSignature(sigHeader, rawBody, config.pigeon.webhookSecret)) {
    res.status(401).json({ error: 'Invalid or stale signature' });
    return;
  }

  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    event = parsed as Record<string, unknown>;
  } catch {
    res.status(400).json({ error: 'Malformed JSON' });
    return;
  }

  const workspace = event.workspace;
  if (!isKnownWorkspace(workspace)) {
    res.status(200).json({ ok: true, ignored: 'unknown_workspace' });
    return;
  }

  const eventType = event.type;
  const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<string, unknown>;
  const db = await getDb();

  if (eventType === 'message.inbound') {
    const messageId = data.message_id;
    const from = data.from;
    const text = typeof data.text === 'string' ? data.text : '';
    if (typeof messageId !== 'string' || !messageId || typeof from !== 'string' || !from) {
      res.status(400).json({ error: 'Missing message_id or from' });
      return;
    }

    const parsedDate = typeof event.occurred_at === 'string' ? new Date(event.occurred_at) : new Date();
    const occurredAt = Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
    const now = new Date();

    await ensureConversation(workspace, from, occurredAt, text);

    let inserted = false;
    try {
      await db.collection('messages').insertOne({
        workspace,
        contact: from,
        direction: 'inbound',
        message_id: messageId,
        text,
        occurred_at: occurredAt,
        created_at: now,
      });
      inserted = true;
    } catch (err: unknown) {
      if ((err as { code?: number })?.code !== 11000) {
        throw err;
      }
    }

    if (inserted) {
      await emitWorkspaceEvent(workspace, {
        type: 'message.inbound',
        contact: from,
        message_id: messageId,
        text,
        occurred_at: occurredAt.toISOString(),
      });
    }

    res.status(200).json({ ok: true });
    return;
  }

  if (eventType === 'message.status') {
    const clientRef = data.client_ref;
    const status = data.status;
    const pigeonMsgId = typeof data.message_id === 'string' ? data.message_id : null;
    if (typeof clientRef !== 'string' || typeof status !== 'string') {
      res.status(200).json({ ok: true, ignored: 'invalid_status_payload' });
      return;
    }

    const rank = STATUS_RANK[status];
    if (!rank) {
      res.status(200).json({ ok: true, ignored: 'unknown_status' });
      return;
    }

    const updated = await db.collection('outbound_messages').findOneAndUpdate(
      { workspace, client_ref: clientRef, status_rank: { $lt: rank } },
      {
        $set: {
          status,
          status_rank: rank,
          ...(pigeonMsgId ? { pigeon_message_id: pigeonMsgId } : {}),
          updated_at: new Date(),
        },
      },
      { returnDocument: 'after' }
    );

    if (updated) {
      await emitWorkspaceEvent(workspace, {
        type: 'message.status',
        contact: String(updated.contact),
        client_ref: clientRef,
        status,
      });
    }

    res.status(200).json({ ok: true });
    return;
  }

  // Unknown event type: acknowledge 2xx so Pigeon does not retry
  res.status(200).json({ ok: true, ignored: 'unknown_type' });
}

// ---------------------------------------------------------------------------
// Distributed per-workspace rate limiter + Retry-After cooldown (Redis Lua)
// Pigeon bucket: capacity 8, refill 4/sec. We use capacity 7, refill 3.5/sec
// to leave a small safety margin against clock skew across instances.
// ---------------------------------------------------------------------------
const ACQUIRE_SLOT_LUA = `
local cooldown_key = KEYS[1]
local bucket_key   = KEYS[2]
local now_ms       = tonumber(ARGV[1])
local capacity     = tonumber(ARGV[2])
local refill_per_ms = tonumber(ARGV[3])

local pttl = redis.call('PTTL', cooldown_key)
if pttl > 0 then
  return pttl
end

local data = redis.call('HMGET', bucket_key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now_ms
else
  local elapsed = math.max(0, now_ms - ts)
  tokens = math.min(capacity, tokens + elapsed * refill_per_ms)
  ts = now_ms
end

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HMSET', bucket_key, 'tokens', tokens, 'ts', ts)
  redis.call('PEXPIRE', bucket_key, 10000)
  return 0
else
  redis.call('HMSET', bucket_key, 'tokens', tokens, 'ts', ts)
  redis.call('PEXPIRE', bucket_key, 10000)
  local wait_ms = math.ceil((1 - tokens) / refill_per_ms)
  return math.max(50, wait_ms)
end
`;

async function acquireSendSlot(workspace: string): Promise<number> {
  const redis = getRedis();
  const waitMs = await redis.eval(
    ACQUIRE_SLOT_LUA,
    2,
    `pigeon:cooldown:${workspace}`,
    `pigeon:bucket:${workspace}`,
    String(Date.now()),
    '7',
    String(3.5 / 1000)
  );
  return Number(waitMs) || 0;
}

async function setWorkspaceCooldown(workspace: string, ms: number): Promise<void> {
  if (ms <= 0) return;
  const redis = getRedis();
  const key = `pigeon:cooldown:${workspace}`;
  // Only extend cooldown if longer than current PTTL
  const current = await redis.pttl(key);
  if (ms > current) {
    await redis.set(key, '1', 'PX', Math.ceil(ms));
  }
}

let workerRunning = false;
let workerTimer: NodeJS.Timeout | undefined;
let wakeRequested = false;

export function startOutboundWorker(): void {
  if (workerRunning) return;
  workerRunning = true;

  const sub = getSubRedis();
  sub.subscribe('pigeon:outbound:wake').catch(() => {});
  sub.on('message', (channel) => {
    if (channel === 'pigeon:outbound:wake') {
      wakeRequested = true;
      scheduleNextPoll(10);
    }
  });

  scheduleNextPoll(50);
}

export function stopOutboundWorker(): void {
  workerRunning = false;
  if (workerTimer) {
    clearTimeout(workerTimer);
    workerTimer = undefined;
  }
}

function scheduleNextPoll(delayMs: number): void {
  if (!workerRunning) return;
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = setTimeout(() => {
    void drainOutboundQueue();
  }, delayMs);
}

async function processOneJob(): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);

  const job = await db.collection('outbound_messages').findOneAndUpdate(
    {
      $or: [
        { delivery_state: 'pending', next_attempt_at: { $lte: now } },
        { delivery_state: 'sending', lease_until: { $lte: now } },
      ],
    },
    {
      $set: {
        delivery_state: 'sending',
        lease_owner: config.instanceId,
        lease_until: leaseUntil,
        updated_at: now,
      },
      $inc: { attempts: 1 },
    },
    {
      sort: { next_attempt_at: 1, created_at: 1 },
      returnDocument: 'after',
    }
  );

  if (!job) return false;

  const workspace = String(job.workspace);
  const apiKey = config.pigeon.apiKeys[workspace];
  if (!apiKey) {
    await db.collection('outbound_messages').updateOne(
      { _id: job._id },
      { $set: { delivery_state: 'failed', status: 'failed', status_rank: 3, updated_at: new Date() } }
    );
    return true;
  }

  const waitMs = await acquireSendSlot(workspace);
  if (waitMs > 0) {
    await db.collection('outbound_messages').updateOne(
      { _id: job._id, lease_owner: config.instanceId },
      {
        $set: {
          delivery_state: 'pending',
          lease_until: new Date(0),
          lease_owner: null,
          next_attempt_at: new Date(Date.now() + waitMs),
          updated_at: new Date(),
        },
        $inc: { attempts: -1 },
      }
    );
    return true;
  }

  try {
    const res = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': `${workspace}:${job.client_ref}`,
      },
      body: JSON.stringify({
        to: job.contact,
        text: job.text,
        client_ref: job.client_ref,
      }),
      signal: AbortSignal.timeout(PIGEON_TIMEOUT_MS),
    });

    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { id?: string };
      await db.collection('outbound_messages').updateOne(
        { _id: job._id },
        {
          $set: {
            delivery_state: 'accepted',
            lease_owner: null,
            ...(body.id ? { pigeon_message_id: body.id } : {}),
            updated_at: new Date(),
          },
        }
      );
      return true;
    }

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : 1;
      const cooldownMs = Math.max(250, Math.ceil((Number.isFinite(retryAfterSec) ? retryAfterSec : 1) * 1000) + 200);
      await setWorkspaceCooldown(workspace, cooldownMs);
      await db.collection('outbound_messages').updateOne(
        { _id: job._id, lease_owner: config.instanceId },
        {
          $set: {
            delivery_state: 'pending',
            lease_until: new Date(0),
            lease_owner: null,
            next_attempt_at: new Date(Date.now() + cooldownMs),
            updated_at: new Date(),
          },
        }
      );
      return true;
    }

    // 503 or other 5xx: back off and set a short shared cooldown so we don't flood during outage
    const attempts = Number(job.attempts || 1);
    const backoffMs = Math.min(4000, 1000 * Math.pow(1.5, Math.min(attempts - 1, 4)));
    await setWorkspaceCooldown(workspace, Math.min(2000, backoffMs));
    await db.collection('outbound_messages').updateOne(
      { _id: job._id, lease_owner: config.instanceId },
      {
        $set: {
          delivery_state: 'pending',
          lease_until: new Date(0),
          lease_owner: null,
          next_attempt_at: new Date(Date.now() + backoffMs),
          updated_at: new Date(),
        },
      }
    );
    return true;
  } catch {
    // Timeout (e.g. 12s Pigeon slow response) or network error: retry with Idempotency-Key
    const attempts = Number(job.attempts || 1);
    const backoffMs = Math.min(4000, 1000 * Math.pow(1.5, Math.min(attempts - 1, 4)));
    await db.collection('outbound_messages').updateOne(
      { _id: job._id, lease_owner: config.instanceId },
      {
        $set: {
          delivery_state: 'pending',
          lease_until: new Date(0),
          lease_owner: null,
          next_attempt_at: new Date(Date.now() + backoffMs),
          updated_at: new Date(),
        },
      }
    );
    return true;
  }
}

let draining = false;
async function drainOutboundQueue(): Promise<void> {
  if (!workerRunning || draining) return;
  draining = true;
  try {
    // Run up to 4 concurrent sends in this instance so 12s slow responses don't block other jobs
    const CONCURRENCY = 4;
    let didWork = true;
    while (workerRunning && didWork) {
      wakeRequested = false;
      const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => processOneJob()));
      didWork = results.some(Boolean);
    }
  } catch (err) {
    console.error('Outbound worker error:', err);
  } finally {
    draining = false;
    if (workerRunning) {
      scheduleNextPoll(wakeRequested ? 10 : 300);
    }
  }
}
