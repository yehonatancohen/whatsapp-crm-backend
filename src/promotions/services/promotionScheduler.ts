import { Worker, Job } from 'bullmq';
import { redis as redisInstance } from '../../shared/redis';
import { prisma } from '../../shared/db';
import { logger } from '../../shared/logger';
import { promotionProcessQueue } from '../promotionQueue';

const redis = redisInstance as any;

/**
 * Determine the current HH:mm and day-of-week in the given timezone.
 */
function getNowInTimezone(tz: string): { hhmm: string; dayOfWeek: number; dateKey: string } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';

  const hh = get('hour').padStart(2, '0');
  // Handle case where some environments return '24' for midnight
  const normalizedHh = hh === '24' ? '00' : hh;
  const mm = get('minute').padStart(2, '0');
  const hhmm = `${normalizedHh}:${mm}`;

  // Map JS Date day to 0=Sunday..6=Saturday
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[get('weekday')] ?? now.getDay();

  const dateKey = `${get('year')}-${get('month')}-${get('day')}`;

  const result = { hhmm, dayOfWeek, dateKey };
  logger.info({ tz, ...result, localTime: now.toISOString() }, 'Calculated time in timezone');
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
