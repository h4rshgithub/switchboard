import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { claimConversation, enqueueReply } from '../domain.js';
import { getRedis } from '../redis.js';

export const graderRouter = Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

function requireGraderToken(req: Request, res: Response, next: NextFunction): void {
  const token = req.header('x-grader-token');
  if (!token || token !== config.graderToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

graderRouter.use(requireGraderToken);

graderRouter.post('/reset', wrap(async (_req: Request, res: Response) => {
  const db = await getDb();
  await Promise.all([
    db.collection('conversations').deleteMany({}),
    db.collection('messages').deleteMany({}),
    db.collection('outbound_messages').deleteMany({}),
    db.collection('notes').deleteMany({}),
    db.collection('user_keys').deleteMany({}),
    db.collection('workspace_key_envelopes').deleteMany({}),
  ]);

  const redis = getRedis();
  // Delete application keys (ws:*, pigeon:*) while keeping login sessions (sess:*)
  const patterns = ['ws:*', 'pigeon:*'];
  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  }

  res.status(200).json({ ok: true });
}));

graderRouter.get('/snapshot', wrap(async (_req: Request, res: Response) => {
  const db = await getDb();
  const [conversations, inboundMsgs, outboundMsgs] = await Promise.all([
    db.collection('conversations').find({}).toArray(),
    db
      .collection('messages')
      .find({ direction: 'inbound' })
      .sort({ occurred_at: 1, _id: 1 })
      .toArray(),
    db.collection('outbound_messages').find({}).toArray(),
  ]);

  const workspaces: Record<
    string,
    {
      contacts: Record<string, { inbound: string[]; assignee: string | null }>;
      outbound: Record<string, string>;
    }
  > = {};

  const ensureWs = (ws: string) => {
    if (!workspaces[ws]) {
      workspaces[ws] = { contacts: {}, outbound: {} };
    }
    return workspaces[ws];
  };

  for (const conv of conversations) {
    const ws = ensureWs(String(conv.workspace));
    const contact = String(conv.contact);
    ws.contacts[contact] = {
      inbound: [],
      assignee: conv.assignee ? String(conv.assignee) : null,
    };
  }

  for (const msg of inboundMsgs) {
    const ws = ensureWs(String(msg.workspace));
    const contact = String(msg.contact);
    if (!ws.contacts[contact]) {
      ws.contacts[contact] = { inbound: [], assignee: null };
    }
    if (msg.message_id) {
      ws.contacts[contact].inbound.push(String(msg.message_id));
    }
  }

  for (const out of outboundMsgs) {
    const ws = ensureWs(String(out.workspace));
    ws.outbound[String(out.client_ref)] = String(out.status);
  }

  res.json({ workspaces });
}));

graderRouter.post('/reply', wrap(async (req: Request, res: Response) => {
  const { workspace, contact, text, client_ref } = (req.body ?? {}) as {
    workspace?: string;
    contact?: string;
    text?: string;
    client_ref?: string;
  };
  const result = await enqueueReply({
    workspace: workspace ?? '',
    contact: contact ?? '',
    text: text ?? '',
    client_ref: client_ref ?? '',
  });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(202).json({ ok: true, client_ref });
}));

graderRouter.post('/claim', wrap(async (req: Request, res: Response) => {
  const { workspace, contact, agent } = (req.body ?? {}) as {
    workspace?: string;
    contact?: string;
    agent?: string;
  };
  const result = await claimConversation({
    workspace: workspace ?? '',
    contact: contact ?? '',
    agent: agent ?? '',
  });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(200).json({ ok: true, assignee: result.assignee });
}));
