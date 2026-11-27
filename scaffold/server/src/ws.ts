import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { getSessionFromCookie, getWorkspaceRole } from './auth.js';
import { channelForWorkspace, getEventsAfter, type SequencedEvent } from './events.js';
import { getSubRedis } from './redis.js';

const subscribers = new Map<string, Set<(msg: string) => void>>();
let subInitialized = false;

function ensureRedisSubscriber(): void {
  if (subInitialized) return;
  subInitialized = true;
  const sub = getSubRedis();
  sub.on('message', (channel, message) => {
    const handlers = subscribers.get(channel);
    if (!handlers) return;
    for (const fn of handlers) {
      fn(message);
    }
  });
}

function subscribeChannel(channel: string, handler: (msg: string) => void): () => void {
  ensureRedisSubscriber();
  let set = subscribers.get(channel);
  if (!set) {
    set = new Set();
    subscribers.set(channel, set);
    getSubRedis().subscribe(channel).catch(() => {});
  }
  set.add(handler);
  return () => {
    const s = subscribers.get(channel);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) {
      subscribers.delete(channel);
      getSubRedis().unsubscribe(channel).catch(() => {});
    }
  };
}

export function attachWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const workspace = url.searchParams.get('workspace') || '';
      if (!workspace) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      const user = await getSessionFromCookie(req.headers.cookie);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      if (!getWorkspaceRole(user, workspace)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      const afterParam = url.searchParams.get('after');
      const afterSeq = afterParam !== null && afterParam !== '' ? Number(afterParam) : null;

      wss.handleUpgrade(req, socket, head, (ws) => {
        void handleClient(ws, workspace, afterSeq);
      });
    } catch {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });

  return wss;
}

async function handleClient(ws: WebSocket, workspace: string, afterSeq: number | null): Promise<void> {
  let ready = afterSeq === null || !Number.isFinite(afterSeq);
  const buffer: string[] = [];
  let maxReplayedSeq = afterSeq ?? 0;

  const unsubscribe = subscribeChannel(channelForWorkspace(workspace), (msg) => {
    if (ws.readyState !== ws.OPEN) return;
    if (!ready) {
      buffer.push(msg);
      return;
    }
    try {
      const parsed = JSON.parse(msg) as SequencedEvent;
      if (parsed.seq > maxReplayedSeq) {
        maxReplayedSeq = parsed.seq;
        ws.send(msg);
      }
    } catch {
      // ignore
    }
  });

  ws.on('close', () => unsubscribe());
  ws.on('error', () => unsubscribe());

  if (!ready && afterSeq !== null) {
    try {
      const missed = await getEventsAfter(workspace, afterSeq);
      for (const ev of missed) {
        if (ws.readyState !== ws.OPEN) break;
        if (ev.seq > maxReplayedSeq) {
          maxReplayedSeq = ev.seq;
          ws.send(JSON.stringify(ev));
        }
      }
      ready = true;
      for (const msg of buffer) {
        if (ws.readyState !== ws.OPEN) break;
        try {
          const parsed = JSON.parse(msg) as SequencedEvent;
          if (parsed.seq > maxReplayedSeq) {
            maxReplayedSeq = parsed.seq;
            ws.send(msg);
          }
        } catch {
          // ignore
        }
      }
      buffer.length = 0;
    } catch {
      unsubscribe();
      ws.close();
    }
  }
}
