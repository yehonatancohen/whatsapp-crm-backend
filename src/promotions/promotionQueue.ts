import { Queue } from 'bullmq';
import { redis } from '../shared/redis';

const connection = redis as any;

/** Queue for processing individual promotion group sends (one group per job). */
export const promotionProcessQueue = new Queue('promotion-process', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
  },
});

/** Queue for the repeatable scheduler that checks if promotions should fire. */
export const promotionSchedulerQueue = new Queue('promotion-scheduler', {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 10 },
  },
});
