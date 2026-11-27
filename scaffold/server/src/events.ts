import { getRedis } from './redis.js';

export type WorkspaceEventPayload =
  | {
      type: 'message.inbound';
      contact: string;
      message_id: string;
      text?: string;
      occurred_at?: string;
    }
  | {
      type: 'message.status';
      contact: string;
      client_ref: string;
      status: string;
    }
  | {
      type: 'conversation.assigned';
      contact: string;
      assignee: string | null;
    }
  | {
      type: 'conversation.updated';
      contact: string;
      status: string;
    }
  | {
      type: 'message.outbound';
      contact: string;
      client_ref: string;
      text: string;
      status: string;
      created_at: string;
    }
  | {
      type: 'note.created';
      contact: string;
      note_id: string;
      author: string;
      ciphertext: string;
      iv: string;
      aad: string;
      created_at: string;
    };

export type SequencedEvent = WorkspaceEventPayload & {
  seq: number;
};

const MAX_EVENT_HISTORY = 5000;

export function channelForWorkspace(workspace: string): string {
  return `ws:pub:${workspace}`;
}

export function historyKeyForWorkspace(workspace: string): string {
  return `ws:events:${workspace}`;
}

export function seqKeyForWorkspace(workspace: string): string {
  return `ws:seq:${workspace}`;
}

/**
 * Assigns a strictly increasing per-workspace sequence number, persists the
 * frame in Redis for replay (`?after=N`), and broadcasts it to all instances.
 */
export async function emitWorkspaceEvent(
  workspace: string,
  payload: WorkspaceEventPayload
): Promise<SequencedEvent> {
  const redis = getRedis();
  const seq = await redis.incr(seqKeyForWorkspace(workspace));
  const event: SequencedEvent = { seq, ...payload };
  const serialized = JSON.stringify(event);

  const histKey = historyKeyForWorkspace(workspace);
  const pipeline = redis.pipeline();
  pipeline.zadd(histKey, seq, serialized);
  if (seq > MAX_EVENT_HISTORY) {
    pipeline.zremrangebyrank(histKey, 0, -MAX_EVENT_HISTORY - 1);
  }
  pipeline.publish(channelForWorkspace(workspace), serialized);
  await pipeline.exec();

  return event;
}

export async function getEventsAfter(workspace: string, afterSeq: number): Promise<SequencedEvent[]> {
  const redis = getRedis();
  const raw = await redis.zrangebyscore(historyKeyForWorkspace(workspace), `(${afterSeq}`, '+inf');
  const out: SequencedEvent[] = [];
  for (const item of raw) {
    try {
      out.push(JSON.parse(item) as SequencedEvent);
    } catch {
      // ignore malformed entry
    }
  }
  return out;
}
