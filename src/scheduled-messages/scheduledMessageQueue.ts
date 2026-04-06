import { Queue } from 'bullmq';
import { redis } from '../shared/redis';

const connection = redis as any;

/** Queue for the repeatable scheduler that checks for pending scheduled messages. */
export const scheduledMessageSchedulerQueue = new Queue('scheduled-message-scheduler', {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 10 },
  },
});
