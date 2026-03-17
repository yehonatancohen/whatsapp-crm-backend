import { prisma } from './shared/db';
import { logger } from './shared/logger';
import { redis } from './shared/redis';

// Warmup
import { warmupSchedulerQueue } from './warmup/warmupQueue';
import { createSchedulerWorker } from './warmup/warmupWorker';
import { resetDailyCounts } from './warmup/warmupService';

/**
 * The 'worker' container handles background tasks that DON'T require
 * an active WhatsApp client instance (e.g. scheduling, daily resets).
 *
 * Workers that DO require a client (campaignProcessor, promotionProcessor, cycleWorker)
 * are hosted in the 'api' container where the ClientManager resides.
 */
async function start() {
  await prisma.$connect();
  logger.info('Worker connected to PostgreSQL');

  await redis.ping();
  logger.info('Worker connected to Redis');

  // ─── Register BullMQ workers ──────────────────────────────────────────────

  // Warmup Scheduler (finds accounts to warmup and enqueues jobs)
  const schedulerWorker = createSchedulerWorker();

  logger.info('Background scheduler workers registered');

  // ─── Add repeatable scheduler jobs (every 60 seconds) ─────────────────────

  await warmupSchedulerQueue.upsertJobScheduler(
    'warmup-scheduler-repeat',
    { every: 60_000 },
    { name: 'warmup-tick' },
  );

  // Note: Campaign and Promotion schedulers are also running in the API container 
  // for now since they were already there, but they could be moved here.
  // To avoid double-scheduling, we keep them in API or move them here.
  // Given the API needs to know about them for immediate starts, keeping them there is okay.

  logger.info('Warmup scheduler repeatable job started (every 60s)');

  // ─── Daily reset job (every 24 hours at midnight UTC) ─────────────────────

  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setUTCHours(24, 0, 0, 0);
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  setTimeout(() => {
    resetDailyCounts().catch((err) => {
      logger.error({ err }, 'Failed to reset daily warmup counts');
    });

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

  logger.info('Worker started — processing background scheduling jobs');

  const shutdown = async () => {
    logger.info('Worker shutting down...');
    await schedulerWorker.close();
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

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Worker unhandled rejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Worker uncaught exception');
});
