import { Queue } from 'bullmq';
import { redis } from '../shared/redis';

// BullMQ bundles its own ioredis types which can conflict with the top-level
// ioredis package. Casting to `any` is the standard workaround for duplicate-type
// mismatches when the underlying runtime instances are fully compatible.
const connection = redis as any;

/** Queue for processing individual warmup activities for an account. */
export const warmupCycleQueue = new Queue('warmup-cycle', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

/** Queue for the repeatable scheduler that triggers warmup cycles. */
export const warmupSchedulerQueue = new Queue('warmup-scheduler', {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 10 },
  },
});
