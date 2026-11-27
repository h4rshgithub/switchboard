import { config } from './config.js';
import { getDb } from './db.js';
import { emitWorkspaceEvent } from './events.js';
import { getRedis } from './redis.js';

export function isKnownWorkspace(workspace: unknown): workspace is string {
  return typeof workspace === 'string' && Object.prototype.hasOwnProperty.call(config.pigeon.apiKeys, workspace);
}

export async function ensureConversation(
  workspace: string,
  contact: string,
  activityAt: Date,
  preview?: string
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const update: Record<string, unknown> = {
    $setOnInsert: {
      workspace,
      contact,
      assignee: null,
      status: 'open',
      created_at: now,
    },
    $max: { last_activity_at: activityAt },
    $set: {
      updated_at: now,
      ...(preview !== undefined ? { last_message_preview: preview.slice(0, 120) } : {}),
    },
  };

  try {
    await db.collection('conversations').updateOne({ workspace, contact }, update, { upsert: true });
  } catch (err: unknown) {
    // Concurrent upsert race on unique index { workspace, contact }
    if ((err as { code?: number })?.code === 11000) {
      await db.collection('conversations').updateOne(
        { workspace, contact },
        {
          $max: { last_activity_at: activityAt },
          $set: {
            updated_at: now,
            ...(preview !== undefined ? { last_message_preview: preview.slice(0, 120) } : {}),
          },
        }
      );
      return;
    }
    throw err;
  }
}

export type EnqueueReplyResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; status: number; error: string };

export async function enqueueReply(input: {
  workspace: string;
  contact: string;
  text: string;
  client_ref: string;
}): Promise<EnqueueReplyResult> {
  const { workspace, contact, text, client_ref } = input;
  if (!isKnownWorkspace(workspace)) {
    return { ok: false, status: 404, error: 'Unknown workspace' };
  }
  if (!contact || typeof contact !== 'string') {
    return { ok: false, status: 400, error: 'Missing contact' };
  }
  if (typeof text !== 'string' || !text.length) {
    return { ok: false, status: 400, error: 'Missing text' };
  }
  if (!client_ref || typeof client_ref !== 'string') {
    return { ok: false, status: 400, error: 'Missing client_ref' };
  }

  const db = await getDb();
  const now = new Date();

  await ensureConversation(workspace, contact, now, text);

  try {
    await db.collection('outbound_messages').insertOne({
      workspace,
      contact,
      text,
      client_ref,
      status: 'queued',
      status_rank: 1,
      delivery_state: 'pending',
      lease_until: new Date(0),
      lease_owner: null,
      attempts: 0,
      next_attempt_at: now,
      pigeon_message_id: null,
      created_at: now,
      updated_at: now,
    });
  } catch (err: unknown) {
    if ((err as { code?: number })?.code === 11000) {
      return { ok: true, duplicate: true };
    }
    throw err;
  }

  await emitWorkspaceEvent(workspace, {
    type: 'message.outbound',
    contact,
    client_ref,
    text,
    status: 'queued',
    created_at: now.toISOString(),
  });

  // Wake outbound workers across instances
  getRedis().publish('pigeon:outbound:wake', workspace).catch(() => {});

  return { ok: true, duplicate: false };
}

export type ClaimResult =
  | { ok: true; status: 200; assignee: string }
  | { ok: false; status: number; error: string };

export async function claimConversation(input: {
  workspace: string;
  contact: string;
  agent: string;
}): Promise<ClaimResult> {
  const { workspace, contact, agent } = input;
  if (!isKnownWorkspace(workspace)) {
    return { ok: false, status: 404, error: 'Unknown workspace' };
  }
  if (!contact || typeof contact !== 'string' || !agent || typeof agent !== 'string') {
    return { ok: false, status: 400, error: 'Missing contact or agent' };
  }

  const db = await getDb();
  const now = new Date();
  await ensureConversation(workspace, contact, now);

  const prev = await db.collection('conversations').findOneAndUpdate(
    {
      workspace,
      contact,
      $or: [{ assignee: null }, { assignee: agent }],
    },
    {
      $set: { assignee: agent, updated_at: now },
    },
    { returnDocument: 'before' }
  );

  if (!prev) {
    return { ok: false, status: 409, error: 'Conversation already claimed by another agent' };
  }

  if (prev.assignee !== agent) {
    await emitWorkspaceEvent(workspace, {
      type: 'conversation.assigned',
      contact,
      assignee: agent,
    });
  }

  return { ok: true, status: 200, assignee: agent };
}

export async function unclaimConversation(input: {
  workspace: string;
  contact: string;
  agent: string;
  isAdmin: boolean;
}): Promise<{ ok: boolean; status: number; error?: string }> {
  const { workspace, contact, agent, isAdmin } = input;
  if (!isKnownWorkspace(workspace)) {
    return { ok: false, status: 404, error: 'Unknown workspace' };
  }
  const db = await getDb();
  const filter = isAdmin
    ? { workspace, contact }
    : { workspace, contact, $or: [{ assignee: agent }, { assignee: null }] };

  const prev = await db.collection('conversations').findOneAndUpdate(
    filter,
    { $set: { assignee: null, updated_at: new Date() } },
    { returnDocument: 'before' }
  );

  if (!prev) {
    return { ok: false, status: 409, error: 'Only the assignee or an admin can release this conversation' };
  }
  if (prev.assignee !== null) {
    await emitWorkspaceEvent(workspace, {
      type: 'conversation.assigned',
      contact,
      assignee: null,
    });
  }
  return { ok: true, status: 200 };
}

export async function setConversationStatus(input: {
  workspace: string;
  contact: string;
  status: 'open' | 'closed';
}): Promise<{ ok: boolean; status: number; error?: string }> {
  const { workspace, contact, status } = input;
  if (!isKnownWorkspace(workspace)) {
    return { ok: false, status: 404, error: 'Unknown workspace' };
  }
  const db = await getDb();
  const res = await db.collection('conversations').findOneAndUpdate(
    { workspace, contact },
    { $set: { status, updated_at: new Date() } },
    { returnDocument: 'before' }
  );
  if (!res) {
    return { ok: false, status: 404, error: 'Conversation not found' };
  }
  if (res.status !== status) {
    await emitWorkspaceEvent(workspace, {
      type: 'conversation.updated',
      contact,
      status,
    });
  }
  return { ok: true, status: 200 };
}
