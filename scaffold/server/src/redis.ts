import { Redis } from 'ioredis';
import { config } from './config.js';

let redis: Redis | undefined;
let subRedis: Redis | undefined;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
  }
  return redis;
}

export function getSubRedis(): Redis {
  if (!subRedis) {
    subRedis = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
  }
  return subRedis;
}

export async function closeRedis(): Promise<void> {
  await Promise.all([
    redis ? redis.quit().catch(() => redis?.disconnect()) : Promise.resolve(),
    subRedis ? subRedis.quit().catch(() => subRedis?.disconnect()) : Promise.resolve(),
  ]);
  redis = undefined;
  subRedis = undefined;
}
