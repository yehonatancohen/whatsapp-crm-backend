import { Worker, Job } from 'bullmq';
import { redis as redisInstance } from '../../shared/redis';
import { prisma } from '../../shared/db';
import { logger } from '../../shared/logger';
import { emitToUser } from '../../shared/socket';
import { ClientManager } from '../../accounts/services/ClientManager';
import { resolveSpintax } from '../../warmup/spintax';
import { simulateHumanSend } from '../../warmup/humanDelay';
import { selectPromotionAccount } from './promotionAccountSelector';
import { promotionProcessQueue } from '../promotionQueue';

const redis = redisInstance as any;

/**
 * Processes one group send per job, then chains to the next with delay.
 * Same pattern as the campaign processor worker.
 */
export function createPromotionProcessorWorker(): Worker {
  const worker = new Worker(
    'promotion-process',
    async (job: Job<{ promotionId: string }>) => {
      const { promotionId } = job.data;

      const promotion = await prisma.groupPromotion.findUnique({
        where: { id: promotionId },
        include: { messages: { where: { isActive: true } } },
      });

      if (!promotion || !promotion.isActive) return;
      if (promotion.messages.length === 0) return;

      // Find next PENDING log entry
      const pendingLog = await prisma.groupPromotionLog.findFirst({
        where: { promotionId, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
      });

      if (!pendingLog) {
        // All done for this batch
        await prisma.groupPromotion.update({
          where: { id: promotionId },
          data: { lastSentAt: new Date() },
        });
        emitToUser(promotion.userId, 'promotion:batch-complete', { promotionId });
        logger.info({ promotionId }, 'Promotion batch complete');
        return;
      }

      // Pick a random message from the pool
      const randomMessage = promotion.messages[
        Math.floor(Math.random() * promotion.messages.length)
      ];
      const resolvedText = resolveSpintax(randomMessage.content);

      // Select an account with group membership verification
      let account: { id: string; userId: string } | null = null;
      const manager = ClientManager.getInstance();
      const excludeIds: string[] = [];

      while (true) {
        const candidate = await selectPromotionAccount(
          promotionId,
          promotion.accountIds,
          promotion.dailyLimitPerAccount,
          excludeIds,
        );
        if (!candidate) break;

        const instance = manager.getInstanceById(candidate.id);
        if (instance && instance.status === 'AUTHENTICATED') {
          const groups = await instance.getGroups();
          if (groups.some((g) => g.id === pendingLog.groupJid)) {
            account = candidate;
            break;
          }
          logger.debug(
            { accountId: candidate.id, groupJid: pendingLog.groupJid },
            'Account not in target group, trying next',
          );
        }
        excludeIds.push(candidate.id);
      }

      if (!account) {
        await prisma.groupPromotionLog.update({
          where: { id: pendingLog.id },
          data: {
            status: 'FAILED',
            errorMessage: 'No eligible account is a member of the target group',
          },
        });
        await scheduleNextJob(promotionId, promotion.messagesPerMinute);
        return;
      }

      // Mark as SENDING
      await prisma.groupPromotionLog.update({
        where: { id: pendingLog.id },
        data: {
          status: 'SENDING',
          accountId: account.id,
          messageId: randomMessage.id,
        },
      });

      try {
        const instance = manager.getInstanceById(account.id);
        const client = instance!.getClient();
        if (!client) throw new Error('WhatsApp client not ready');

        // Send with human simulation + link preview enabled
        await simulateHumanSend(client, pendingLog.groupJid, resolvedText, { linkPreview: true });

        await prisma.groupPromotionLog.update({
          where: { id: pendingLog.id },
          data: {
            status: 'SENT',
            resolvedText,
            sentAt: new Date(),
          },
        });

        await prisma.groupPromotion.update({
          where: { id: promotionId },
          data: { totalSendCount: { increment: 1 } },
        });

        emitToUser(promotion.userId, 'promotion:progress', {
          promotionId,
          logId: pendingLog.id,
          groupJid: pendingLog.groupJid,
          status: 'SENT',
        });

        logger.info(
          { promotionId, logId: pendingLog.id, accountId: account.id, groupJid: pendingLog.groupJid },
          'Promotion message sent',
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';

        await prisma.groupPromotionLog.update({
          where: { id: pendingLog.id },
          data: { status: 'FAILED', errorMessage },
        });

        emitToUser(promotion.userId, 'promotion:progress', {
          promotionId,
          logId: pendingLog.id,
          groupJid: pendingLog.groupJid,
          status: 'FAILED',
          error: errorMessage,
        });

        logger.error(
          { promotionId, logId: pendingLog.id, accountId: account.id, err: errorMessage },
          'Promotion message failed',
        );
      }

      await scheduleNextJob(promotionId, promotion.messagesPerMinute);
    },
    { connection: redis, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, promotionId: job?.data?.promotionId, err }, 'Promotion process job failed');
  });

  return worker;
}

async function scheduleNextJob(promotionId: string, messagesPerMinute: number): Promise<void> {
  const delayMs = Math.round(60_000 / messagesPerMinute);
  await promotionProcessQueue.add(
    'process-promotion',
    { promotionId },
    {
      jobId: `promotion-${promotionId}-${Date.now()}`,
      delay: delayMs,
    },
  );
}
