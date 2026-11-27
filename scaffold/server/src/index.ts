import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { handleCallback, handleLogin, handleLogout } from './auth.js';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { handlePigeonWebhook, startOutboundWorker, stopOutboundWorker } from './pigeon.js';
import { closeRedis, getRedis } from './redis.js';
import { apiRouter } from './routes/api.js';
import { graderRouter } from './routes/grader.js';
import { attachWebSocketServer } from './ws.js';

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export function createApp() {
  const app = express();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // Raw body required for HMAC signature verification on Pigeon webhooks
  app.post(
    '/webhooks/pigeon',
    express.raw({ type: '*/*', limit: '2mb' }),
    wrap(handlePigeonWebhook)
  );

  app.use(express.json({ limit: '1mb' }));

  // OIDC Auth routes
  app.get('/auth/login', wrap(handleLogin));
  app.get('/auth/callback', wrap(handleCallback));
  app.post('/auth/logout', wrap(handleLogout));

  // Product API & Grader contract routes
  app.use('/api', apiRouter);
  app.use('/__grader', graderRouter);

  // Error handler (including malformed JSON from express.json)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number })?.status;
    if (status === 400) {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}

async function main() {
  await getDb();
  await getRedis().ping();

  const app = createApp();
  const server = createServer(app);
  attachWebSocketServer(server);
  startOutboundWorker();

  server.listen(config.port, () => {
    console.log(`server on http://localhost:${config.port} (instance ${config.instanceId.slice(0, 8)})`);
  });

  const shutdown = async () => {
    stopOutboundWorker();
    server.close();
    await Promise.all([closeDb(), closeRedis()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
