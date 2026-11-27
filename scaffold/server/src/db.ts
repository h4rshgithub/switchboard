import { MongoClient, type Db } from 'mongodb';
import { config } from './config.js';

let client: MongoClient | undefined;
let initPromise: Promise<Db> | undefined;

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection('conversations').createIndexes([
      { key: { workspace: 1, contact: 1 }, unique: true },
      { key: { workspace: 1, last_activity_at: -1, _id: -1 } },
    ]),
    db.collection('messages').createIndexes([
      {
        key: { workspace: 1, message_id: 1 },
        unique: true,
        partialFilterExpression: { message_id: { $type: 'string' } },
      },
      { key: { workspace: 1, contact: 1, occurred_at: 1, _id: 1 } },
    ]),
    db.collection('outbound_messages').createIndexes([
      { key: { workspace: 1, client_ref: 1 }, unique: true },
      { key: { delivery_state: 1, next_attempt_at: 1 } },
      { key: { delivery_state: 1, lease_until: 1 } },
      { key: { workspace: 1, contact: 1, created_at: 1 } },
    ]),
    db.collection('notes').createIndexes([
      { key: { workspace: 1, contact: 1, created_at: 1 } },
    ]),
    db.collection('user_keys').createIndexes([
      { key: { workspace: 1, sub: 1 }, unique: true },
    ]),
    db.collection('workspace_key_envelopes').createIndexes([
      { key: { workspace: 1, recipient_sub: 1 }, unique: true },
    ]),
  ]);
}

// Connects on first use and ensures indexes are present.
export async function getDb(): Promise<Db> {
  if (!initPromise) {
    initPromise = (async () => {
      client = new MongoClient(config.mongoUrl);
      await client.connect();
      const db = client.db();
      await ensureIndexes(db);
      return db;
    })();
  }
  return initPromise;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = undefined;
    initPromise = undefined;
  }
}
