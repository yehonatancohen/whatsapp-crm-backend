import { prisma } from './shared/db';
import { logger } from './shared/logger';
import { redis } from './shared/redis';
import { warmupSchedulerQueue } from './warmup/warmupQueue';
import { createSchedulerWorker, createCycleWorker } from './warmup/warmupWorker';
import { resetDailyCounts } from './warmup/warmupService';

async function start() {
  await prisma.$connect();
  logger.info('Worker connected to PostgreSQL');

  // Verify Redis is reachable
  await redis.ping();
  logger.info('Worker connected to Redis');

  // ─── Register BullMQ workers ──────────────────────────────────────────────

  const schedulerWorker = createSchedulerWorker();
  const cycleWorker = createCycleWorker();

  logger.info('Warmup scheduler and cycle workers registered');

  // ─── Add repeatable scheduler job (every 60 seconds) ──────────────────────

  await warmupSchedulerQueue.upsertJobScheduler(
    'warmup-scheduler-repeat',
    { every: 60_000 },
    { name: 'warmup-tick' },
  );

  logger.info('Warmup scheduler repeatable job started (every 60s)');

  // ─── Daily reset job (every 24 hours at midnight UTC) ─────────────────────

  // Schedule a daily reset of messagesSentToday counters
  // Using a simple setInterval since this is a lightweight operation
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  // Calculate ms until next midnight UTC
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setUTCHours(24, 0, 0, 0);
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  setTimeout(() => {
    // Run immediately at first midnight
    resetDailyCounts().catch((err) => {
      logger.error({ err }, 'Failed to reset daily warmup counts');
    });

    // Then repeat every 24 hours
    setInterval(() => {
      resetDailyCounts().catch((err) => {
        logger.error({ err }, 'Failed to reset daily warmup counts');
      });
    }, TWENTY_FOUR_HOURS);
  }, msUntilMidnight);

  logger.info(
    { msUntilMidnight, nextReset: nextMidnight.toISOString() },
    'Daily warmup counter reset scheduled',
  );

  logger.info('Worker started — processing warmup jobs');

  // ─── Graceful shutdown ────────────────────────────────────────────────────

  const shutdown = async () => {
    logger.info('Worker shutting down...');
    await schedulerWorker.close();
    await cycleWorker.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start worker');
  process.exit(1);
});

// Keep the process alive
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Worker unhandled rejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Worker uncaught exception');
});
