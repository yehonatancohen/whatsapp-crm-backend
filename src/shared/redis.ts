import Redis from 'ioredis';
import { config } from '../config';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null, // Required by BullMQ
});

export const redisSubscriber = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
});
