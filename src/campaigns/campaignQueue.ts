import { Queue } from 'bullmq';
import { redis } from '../shared/redis';

// BullMQ bundles its own ioredis types — cast to avoid duplicate-type mismatches.
const connection = redis as any;

/** Queue for processing individual campaign messages (one message per job). */
export const campaignProcessQueue = new Queue('campaign-process', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
  },
});

/** Queue for the repeatable scheduler that checks for scheduled campaigns. */
export const campaignSchedulerQueue = new Queue('campaign-scheduler', {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 10 },
  },
});
