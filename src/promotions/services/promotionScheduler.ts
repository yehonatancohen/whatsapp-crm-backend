import { Worker, Job } from 'bullmq';
import { redis as redisInstance } from '../../shared/redis';
import { prisma } from '../../shared/db';
import { logger } from '../../shared/logger';
import { promotionProcessQueue } from '../promotionQueue';

const redis = redisInstance as any;

/**
 * Determine the current HH:mm and day-of-week in the given timezone.
 * Uses en-CA locale for a stable YYYY-MM-DD date string, avoids parsing
 * weekday abbreviations which can vary by Node/ICU version.
 */
function getNowInTimezone(tz: string): { hhmm: string; dayOfWeek: number; dateKey: string } {
  const now = new Date();

  // en-CA reliably produces YYYY-MM-DD
  const dateKey = now.toLocaleDateString('en-CA', { timeZone: tz });

  // Get HH:mm in the target timezone
  const timeStr = now.toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [rawHh, mm] = timeStr.split(':');
  const hhmm = `${rawHh === '24' ? '00' : rawHh}:${mm}`;

  // Derive day-of-week from UTC noon on that calendar date to avoid DST edge cases
  const [year, month, day] = dateKey.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay(); // 0=Sun … 6=Sat

  const result = { hhmm, dayOfWeek, dateKey };
  logger.info({ tz, ...result, utc: now.toISOString() }, 'Calculated time in timezone');
  return result;
}

/**
 * Check if a promotion should fire right now.
 */
function shouldFireNow(
  promotionId: string,
  sendTimes: string[],
  daysOfWeek: number[],
  tz: string,
): { fire: boolean; matchedTime: string; dateKey: string } {
  const { hhmm, dayOfWeek, dateKey } = getNowInTimezone(tz);

  // Check day-of-week (empty array = every day)
  if (daysOfWeek.length > 0 && !daysOfWeek.includes(dayOfWeek)) {
    logger.info({ promotionId, dayOfWeek, daysOfWeek }, 'Promotion skipped: day of week mismatch');
    return { fire: false, matchedTime: '', dateKey };
  }

  // Check if current HH:mm matches any sendTime
  const matched = sendTimes.find((t) => t === hhmm);
  if (!matched) {
    // Only log this at debug to avoid spamming every minute for every promotion
    logger.debug({ promotionId, hhmm, sendTimes }, 'Promotion skipped: time mismatch');
  }

  return { fire: !!matched, matchedTime: matched || '', dateKey };
}

/**
 * Promotion scheduler worker.
 * Runs every 60 seconds, checks all active promotions, and fires those whose time has come.
 */
export function createPromotionSchedulerWorker(): Worker {
  const worker = new Worker(
    'promotion-scheduler',
    async (_job: Job) => {
      logger.info('Promotion scheduler tick');

      const promotions = await prisma.groupPromotion.findMany({
        where: { isActive: true },
        include: {
          groups: true,
          messages: { where: { isActive: true } },
        },
      });

      logger.info({ activePromotionsCount: promotions.length }, 'Checked active promotions');

      for (const promotion of promotions) {
        try {
          if (promotion.groups.length === 0 || promotion.messages.length === 0) {
            logger.info({ promotionId: promotion.id }, 'Promotion has no groups or active messages - skipping');
            continue;
          }
          if (promotion.accountIds.length === 0) {
            logger.info({ promotionId: promotion.id }, 'Promotion has no accounts assigned - skipping');
            continue;
          }

          const { fire, matchedTime, dateKey } = shouldFireNow(
            promotion.id,
            promotion.sendTimes,
            promotion.daysOfWeek,
            promotion.timezone,
          );

          if (!fire) continue;

          // Dedup via Redis key — prevent double-fire within same minute
          const dedupKey = `promotion:dedup:${promotion.id}:${dateKey}:${matchedTime}`;
          const alreadyFired = await redisInstance.get(dedupKey);
          if (alreadyFired) {
            logger.info({ promotionId: promotion.id, matchedTime }, 'Promotion already fired for this minute - skipping');
            continue;
          }
          await redisInstance.set(dedupKey, '1', 'EX', 120);

          logger.info(
            { promotionId: promotion.id, name: promotion.name, time: matchedTime },
            'Triggering promotion send',
          );

          // Create PENDING log entries for each group
          for (const group of promotion.groups) {
            await prisma.groupPromotionLog.create({
              data: {
                promotionId: promotion.id,
                groupJid: group.groupJid,
                groupName: group.groupName,
                status: 'PENDING',
              },
            });
          }

          // Enqueue processing job
          await promotionProcessQueue.add(
            'process-promotion',
            { promotionId: promotion.id },
            { jobId: `promotion-${promotion.id}-${Date.now()}` },
          );
        } catch (err) {
          logger.error({ promotionId: promotion.id, err }, 'Scheduler error for promotion');
        }
      }
    },
    { connection: redis, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Promotion scheduler job failed');
  });

  return worker;
}
