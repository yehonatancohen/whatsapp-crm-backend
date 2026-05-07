import Redis from 'ioredis';
import { config } from '../config';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null, // Required by BullMQ
});

export const redisSubscriber = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

// Attempt to gracefully handle MISCONF errors in Redis
redis.on('connect', () => {
  redis.config('SET', 'stop-writes-on-bgsave-error', 'no').catch(() => {
    // Ignore errors if the user doesn't have permissions to run CONFIG
  });
});

