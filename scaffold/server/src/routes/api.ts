import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { getWorkspaceRole, requireAuth, type SessionUser } from '../auth.js';
import { getDb } from '../db.js';
import {
  claimConversation,
  enqueueReply,
  setConversationStatus,
  unclaimConversation,
} from '../domain.js';
import { emitWorkspaceEvent } from '../events.js';

export const apiRouter = Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

apiRouter.use(wrap(requireAuth));

apiRouter.get('/me', (req: Request, res: Response) => {
  const user = (req as Request & { user: SessionUser }).user;
  res.json(user);
});

function requireWorkspaceMember(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user: SessionUser }).user;
  const workspace =
    (typeof req.query.workspace === 'string' && req.query.workspace) ||
    (typeof req.body?.workspace === 'string' && req.body.workspace) ||
    '';
  if (!workspace) {
    res.status(400).json({ error: 'Missing workspace' });
    return;
  }
  const role = getWorkspaceRole(user, workspace);
  if (!role) {
    res.status(403).json({ error: 'Forbidden: not a member of this workspace' });
    return;
  }
  (req as Request & { workspace: string; workspaceRole: string }).workspace = workspace;
  (req as Request & { workspace: string; workspaceRole: string }).workspaceRole = role;
  next();
}

apiRouter.get('/conversations', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = (req as Request & { workspace: string }).workspace;
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : 'all';
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const query: Record<string, unknown> = { workspace };
  if (statusFilter === 'open' || statusFilter === 'closed') {
    query.status = statusFilter;
  }

  const db = await getDb();
  const [items, total] = await Promise.all([
    db
      .collection('conversations')
      .find(query)
      .sort({ last_activity_at: -1, _id: -1 })
      .skip(offset)
      .limit(limit)
      .toArray(),
    db.collection('conversations').countDocuments(query),
  ]);

  res.json({
    conversations: items.map((c) => ({
      contact: c.contact,
      assignee: c.assignee ?? null,
      status: c.status ?? 'open',
      last_activity_at: c.last_activity_at,
      last_message_preview: c.last_message_preview ?? '',
    })),
    total,
    limit,
    offset,
  });
});

apiRouter.get('/conversations/:contact/messages', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = (req as Request & { workspace: string }).workspace;
  const contact = req.params.contact;
  const db = await getDb();

  const [conversation, inbound, outbound] = await Promise.all([
    db.collection('conversations').findOne({ workspace, contact }),
    db
      .collection('messages')
      .find({ workspace, contact, direction: 'inbound' })
      .sort({ occurred_at: 1, _id: 1 })
      .toArray(),
    db
      .collection('outbound_messages')
      .find({ workspace, contact })
      .sort({ created_at: 1, _id: 1 })
      .toArray(),
  ]);

  const combined = [
    ...inbound.map((m) => ({
      id: String(m.message_id),
      direction: 'inbound' as const,
      text: String(m.text ?? ''),
      status: 'received',
      timestamp: (m.occurred_at instanceof Date ? m.occurred_at : new Date(m.occurred_at)).toISOString(),
    })),
    ...outbound.map((m) => ({
      id: String(m.client_ref),
      client_ref: String(m.client_ref),
      direction: 'outbound' as const,
      text: String(m.text ?? ''),
      status: String(m.status ?? 'queued'),
      timestamp: (m.created_at instanceof Date ? m.created_at : new Date(m.created_at)).toISOString(),
    })),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  res.json({
    conversation: conversation
      ? {
          contact: conversation.contact,
          assignee: conversation.assignee ?? null,
          status: conversation.status ?? 'open',
          last_activity_at: conversation.last_activity_at,
        }
      : null,
    messages: combined,
  });
});

apiRouter.post('/conversations/:contact/reply', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = (req as Request & { workspace: string }).workspace;
  const contact = req.params.contact;
  const { text, client_ref } = (req.body ?? {}) as { text?: string; client_ref?: string };
  const ref = client_ref && typeof client_ref === 'string' ? client_ref : `ui_${randomUUID()}`;

  const result = await enqueueReply({
    workspace,
    contact,
    text: text ?? '',
    client_ref: ref,
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.status(202).json({ ok: true, client_ref: ref });
});

apiRouter.post('/conversations/:contact/claim', requireWorkspaceMember, async (req: Request, res: Response) => {
  const user = (req as Request & { user: SessionUser }).user;
  const workspace = (req as Request & { workspace: string }).workspace;
  const contact = req.params.contact;

  const result = await claimConversation({
    workspace,
    contact,
    agent: user.sub,
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.json({ ok: true, assignee: result.assignee });
});

apiRouter.post('/conversations/:contact/unclaim', requireWorkspaceMember, async (req: Request, res: Response) => {
  const user = (req as Request & { user: SessionUser }).user;
  const workspace = (req as Request & { workspace: string }).workspace;
  const role = (req as Request & { workspaceRole: string }).workspaceRole;
  const contact = req.params.contact;

  const result = await unclaimConversation({
    workspace,
    contact,
    agent: user.sub,
    isAdmin: role === 'admin',
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

apiRouter.post('/conversations/:contact/status', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = (req as Request & { workspace: string }).workspace;
  const contact = req.params.contact;
  const status = req.body?.status;
  if (status !== 'open' && status !== 'closed') {
    res.status(400).json({ error: 'status must be open or closed' });
    return;
  }

  const result = await setConversationStatus({ workspace, contact, status });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, status });
});

// ---------------------------------------------------------------------------
// End-to-End Encrypted Private Notes & Key Directory (server stores only
// public keys, wrapped workspace key envelopes, and AES-GCM ciphertexts)
// ---------------------------------------------------------------------------

apiRouter.put('/keys/me', requireWorkspaceMember, async (req: Request, res: Response) => {
  const user = (req as Request & { user: SessionUser }).user;
  const workspace = (req as Request & { workspace: string }).workspace;
  const publicKeyJwk = req.body?.publicKeyJwk;
  if (!publicKeyJwk || typeof publicKeyJwk !== 'object') {
    res.status(400).json({ error: 'Missing publicKeyJwk' });
    return;
  }
  const db = await getDb();
  await db.collection('user_keys').updateOne(
    { workspace, sub: user.sub },
    { $set: { workspace, sub: user.sub, publicKeyJwk, updated_at: new Date() } },
    { upsert: true }
  );
  res.json({ ok: true });
});

apiRouter.get('/keys/workspace', requireWorkspaceMember, async (req: Request, res: Response) => {
  const user = (req as Request & { user: SessionUser }).user;
  const workspace = (req as Request & { workspace: string }).workspace;
  const db = await getDb();
  const [myEnvelope, members] = await Promise.all([
    db.collection('workspace_key_envelopes').findOne({ workspace, recipient_sub: user.sub }),
    db.collection('user_keys').find({ workspace }).toArray(),
  ]);
  const existingEnvelopes = await db
    .collection('workspace_key_envelopes')
    .find({ workspace }, { projection: { recipient_sub: 1 } })
    .toArray();
  const wrappedFor = new Set(existingEnvelopes.map((e) => String(e.recipient_sub)));

  res.json({
    envelope: myEnvelope
      ? {
          ephemeralPubJwk: myEnvelope.ephemeralPubJwk,
          iv: myEnvelope.iv,
          wrappedKey: myEnvelope.wrappedKey,
        }
      : null,
    hasAnyKey: existingEnvelopes.length > 0,
    members: members.map((m) => ({
      sub: String(m.sub),
      publicKeyJwk: m.publicKeyJwk,
      hasKey: wrappedFor.has(String(m.sub)),
    })),
  });
});

apiRouter.post('/keys/workspace', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = (req as Request & { workspace: string }).workspace;
  const { recipient_sub, ephemeralPubJwk, iv, wrappedKey } = (req.body ?? {}) as {
    recipient_sub?: string;
    ephemeralPubJwk?: unknown;
    iv?: string;
    wrappedKey?: string;
  };
  if (!recipient_sub || !ephemeralPubJwk || !iv || !wrappedKey) {
    res.status(400).json({ error: 'Missing key envelope fields' });
    return;
  }
  const db = await getDb();
  await db.collection('workspace_key_envelopes').updateOne(
    { workspace, recipient_sub },
    {
      $set: {
        workspace,
        recipient_sub,
        ephemeralPubJwk,
        iv,
        wrappedKey,
        updated_at: new Date(),
      },
    },
    { upsert: true }
  );
  res.json({ ok: true });
});

apiRouter.get('/conversations/:contact/notes', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = (req as Request & { workspace: string }).workspace;
  const contact = req.params.contact;
  const db = await getDb();
  const docs = await db
    .collection('notes')
    .find({ workspace, contact })
    .sort({ created_at: 1, _id: 1 })
    .toArray();

  res.json({
    notes: docs.map((n) => ({
      note_id: String(n.note_id),
      author: String(n.author),
      ciphertext: String(n.ciphertext),
      iv: String(n.iv),
      aad: String(n.aad),
      created_at: (n.created_at instanceof Date ? n.created_at : new Date(n.created_at)).toISOString(),
    })),
  });
});

apiRouter.post('/conversations/:contact/notes', requireWorkspaceMember, async (req: Request, res: Response) => {
  const user = (req as Request & { user: SessionUser }).user;
  const workspace = (req as Request & { workspace: string }).workspace;
  const contact = req.params.contact;
  const { ciphertext, iv, aad } = (req.body ?? {}) as {
    ciphertext?: string;
    iv?: string;
    aad?: string;
  };
  if (!ciphertext || !iv || !aad) {
    res.status(400).json({ error: 'Missing ciphertext, iv, or aad' });
    return;
  }

  const noteId = `note_${randomUUID()}`;
  const now = new Date();
  const db = await getDb();
  await db.collection('notes').insertOne({
    note_id: noteId,
    workspace,
    contact,
    author: user.sub,
    ciphertext,
    iv,
    aad,
    created_at: now,
  });

  await emitWorkspaceEvent(workspace, {
    type: 'note.created',
    contact,
    note_id: noteId,
    author: user.sub,
    ciphertext,
    iv,
    aad,
    created_at: now.toISOString(),
  });

  res.status(201).json({ ok: true, note_id: noteId });
});
