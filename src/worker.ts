import { prisma } from './shared/db';
import { logger } from './shared/logger';
import { redis } from './shared/redis';

// Warmup
import { warmupSchedulerQueue } from './warmup/warmupQueue';
import { createSchedulerWorker, createCycleWorker } from './warmup/warmupWorker';
import { resetDailyCounts } from './warmup/warmupService';

// Campaigns
import { campaignSchedulerQueue } from './campaigns/campaignQueue';
import { createCampaignSchedulerWorker, createCampaignProcessorWorker } from './campaigns/services/campaignWorker';

// Promotions
import { promotionSchedulerQueue } from './promotions/promotionQueue';
import { createPromotionSchedulerWorker } from './promotions/services/promotionScheduler';
import { createPromotionProcessorWorker } from './promotions/services/promotionWorker';

async function start() {
  await prisma.$connect();
  logger.info('Worker connected to PostgreSQL');

  // Verify Redis is reachable
  await redis.ping();
  logger.info('Worker connected to Redis');

  // ─── Register BullMQ workers ──────────────────────────────────────────────

  const workers = [
    // Warmup
    createSchedulerWorker(),
    createCycleWorker(),

    // Campaigns
    createCampaignSchedulerWorker(),
    createCampaignProcessorWorker(),

    // Promotions
    createPromotionSchedulerWorker(),
    createPromotionProcessorWorker(),
  ];

  logger.info('All workers registered (Warmup, Campaigns, Promotions)');

  // ─── Add repeatable scheduler jobs (every 60 seconds) ─────────────────────

  await warmupSchedulerQueue.upsertJobScheduler(
    'warmup-scheduler-repeat',
    { every: 60_000 },
    { name: 'warmup-tick' },
  );

  await campaignSchedulerQueue.upsertJobScheduler(
    'campaign-scheduler-repeat',
    { every: 60_000 },
    { name: 'campaign-tick' },
  );

  await promotionSchedulerQueue.upsertJobScheduler(
    'promotion-scheduler-repeat',
    { every: 60_000 },
    { name: 'promotion-tick' },
  );

  logger.info('All repeatable scheduler jobs started (every 60s)');

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

  logger.info('Worker started — processing all background jobs');

  // ─── Graceful shutdown ────────────────────────────────────────────────────

  const shutdown = async () => {
    logger.info('Worker shutting down...');
    for (const worker of workers) {
      await worker.close();
    }
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
