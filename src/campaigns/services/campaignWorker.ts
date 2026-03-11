import { Worker, Job } from 'bullmq';
import { redis as redisInstance } from '../../shared/redis';
import { prisma } from '../../shared/db';
import { logger } from '../../shared/logger';
import { emitToUser, emitToCampaign } from '../../shared/socket';
import { ClientManager } from '../../accounts/services/ClientManager';
import { resolveSpintax } from '../../warmup/spintax';
import { simulateHumanSend } from '../../warmup/humanDelay';
import { selectAccount } from './accountSelector';
import { campaignProcessQueue } from '../campaignQueue';

// BullMQ bundles its own ioredis types — cast to avoid duplicate-type mismatches.
const redis = redisInstance as any;

// ─── Campaign Processor Worker ──────────────────────────────────────────────

/**
 * Processes one campaign message per job, then schedules the next job
 * with a delay based on the campaign's messagesPerMinute setting.
 */
export function createCampaignProcessorWorker(): Worker {
  const worker = new Worker(
    'campaign-process',
    async (job: Job<{ campaignId: string }>) => {
      const { campaignId } = job.data;

      // Fetch campaign to check current status
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
      });

      if (!campaign) {
        logger.warn({ campaignId }, 'Campaign not found — skipping');
        return;
      }

      // Stop processing if campaign is no longer RUNNING
      if (campaign.status !== 'RUNNING') {
        logger.debug({ campaignId, status: campaign.status }, 'Campaign not RUNNING — stopping');
        return;
      }

      // Pick the next PENDING message
      const message = await prisma.campaignMessage.findFirst({
        where: {
          campaignId,
          status: 'PENDING',
        },
        include: {
          contact: { select: { id: true, phoneNumber: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      });

      if (!message) {
        // No more pending messages — campaign is complete
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
          },
        });

        await prisma.activityLog.create({
          data: {
            type: 'CAMPAIGN_COMPLETED',
            message: `Campaign "${campaign.name}" completed`,
            userId: campaign.userId,
          },
        });

        emitToUser(campaign.userId, 'campaign:status', {
          campaignId,
          status: 'COMPLETED',
        });

        logger.info({ campaignId }, 'Campaign completed — all messages processed');
        return;
      }

      // Select an account for sending (round-robin, level-gated)
      const account = await selectAccount(campaignId);

      if (!account) {
        // No eligible accounts — fail this message and try the next one
        await prisma.campaignMessage.update({
          where: { id: message.id },
          data: {
            status: 'FAILED',
            errorMessage: 'No eligible accounts — all accounts may have reached their daily limit or are disconnected',
          },
        });

        await prisma.campaign.update({
          where: { id: campaignId },
          data: { failedCount: { increment: 1 } },
        });

        logger.warn({ campaignId, messageId: message.id }, 'No eligible account — message failed');

        // Schedule next job immediately to try the next message
        await scheduleNextJob(campaignId, campaign.messagesPerMinute);
        return;
      }

      // Mark message as SENDING and assign the account
      await prisma.campaignMessage.update({
        where: { id: message.id },
        data: {
          status: 'SENDING',
          accountId: account.id,
        },
      });

      try {
        // Resolve spintax on the message template
        const resolvedText = resolveSpintax(campaign.messageTemplate);

        // Get the WhatsApp client for the selected account
        const manager = ClientManager.getInstance();
        const instance = manager.getInstanceById(account.id);

        if (!instance || instance.status !== 'AUTHENTICATED') {
          throw new Error('Account is no longer connected to WhatsApp. Please reconnect it.');
        }

        const client = instance.getClient();
        if (!client) {
          throw new Error('Account has no active WhatsApp session. It may need to be reconnected.');
        }

        // Determine chat ID based on campaign type
        let chatId: string;

        if (campaign.type === 'GROUP_MESSAGE') {
          if (!message.groupJid) {
            throw new Error('Message is missing target group information');
          }
          chatId = message.groupJid;
        } else {
          const phoneNumber = message.contact?.phoneNumber;
          if (!phoneNumber) {
            throw new Error('Contact does not have a valid phone number');
          }
          const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
          chatId = `${cleanPhone}@c.us`;
        }

        // Send the message with human-like behavior
        await simulateHumanSend(client, chatId, resolvedText);

        // Mark as SENT
        await prisma.campaignMessage.update({
          where: { id: message.id },
          data: {
            status: 'SENT',
            resolvedText,
            sentAt: new Date(),
          },
        });

        await prisma.campaign.update({
          where: { id: campaignId },
          data: { sentCount: { increment: 1 } },
        });

        // Emit progress
        const progress = await getQuickProgress(campaignId, campaign.totalMessages);

        emitToCampaign(campaignId, 'campaign:progress', {
          campaignId,
          messageId: message.id,
          status: 'SENT',
          ...progress,
        });

        emitToUser(campaign.userId, 'campaign:progress', {
          campaignId,
          messageId: message.id,
          status: 'SENT',
          ...progress,
        });

        logger.info(
          { campaignId, messageId: message.id, accountId: account.id },
          'Campaign message sent',
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown send error';

        await prisma.campaignMessage.update({
          where: { id: message.id },
          data: {
            status: 'FAILED',
            errorMessage,
          },
        });

        await prisma.campaign.update({
          where: { id: campaignId },
          data: { failedCount: { increment: 1 } },
        });

        const progress = await getQuickProgress(campaignId, campaign.totalMessages);

        emitToCampaign(campaignId, 'campaign:progress', {
          campaignId,
          messageId: message.id,
          status: 'FAILED',
          ...progress,
        });

        emitToUser(campaign.userId, 'campaign:progress', {
          campaignId,
          messageId: message.id,
          status: 'FAILED',
          ...progress,
        });

        logger.error(
          { campaignId, messageId: message.id, accountId: account.id, err: errorMessage },
          'Campaign message failed',
        );
      }

      // Schedule the next message processing job with delay
      await scheduleNextJob(campaignId, campaign.messagesPerMinute);
    },
    { connection: redis, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, campaignId: job?.data?.campaignId, err },
      'Campaign process job failed',
    );
  });

  return worker;
}

// ─── Campaign Scheduler Worker ──────────────────────────────────────────────

/**
 * Runs every 60 seconds to check for scheduled campaigns
 * whose scheduledAt time has arrived.
 */
export function createCampaignSchedulerWorker(): Worker {
  const worker = new Worker(
    'campaign-scheduler',
    async (_job: Job) => {
      logger.debug('Campaign scheduler tick');

      const now = new Date();

      // Find campaigns that are SCHEDULED and ready to start
      const scheduledCampaigns = await prisma.campaign.findMany({
        where: {
          status: 'SCHEDULED',
          scheduledAt: { lte: now },
        },
      });

      for (const campaign of scheduledCampaigns) {
        try {
          logger.info(
            { campaignId: campaign.id, scheduledAt: campaign.scheduledAt },
            'Starting scheduled campaign',
          );

          if (!campaign.contactListId) {
            logger.warn({ campaignId: campaign.id }, 'Scheduled campaign has no contact list — marking FAILED');
            await prisma.campaign.update({
              where: { id: campaign.id },
              data: {
                status: 'FAILED',
                completedAt: new Date(),
              },
            });

            await prisma.activityLog.create({
              data: {
                type: 'CAMPAIGN_FAILED',
                message: `Scheduled campaign "${campaign.name}" failed: no contact list`,
                userId: campaign.userId,
              },
            });
            continue;
          }

          // Get contacts from the contact list
          const entries = await prisma.contactListEntry.findMany({
            where: { contactListId: campaign.contactListId },
            select: { contactId: true },
          });

          if (entries.length === 0) {
            logger.warn({ campaignId: campaign.id }, 'Scheduled campaign has empty contact list — marking FAILED');
            await prisma.campaign.update({
              where: { id: campaign.id },
              data: {
                status: 'FAILED',
                completedAt: new Date(),
              },
            });

            await prisma.activityLog.create({
              data: {
                type: 'CAMPAIGN_FAILED',
                message: `Scheduled campaign "${campaign.name}" failed: empty contact list`,
                userId: campaign.userId,
              },
            });
            continue;
          }

          // Create CampaignMessage records
          const messageData = entries.map((entry) => ({
            campaignId: campaign.id,
            contactId: entry.contactId,
            status: 'PENDING' as const,
          }));

          await prisma.campaignMessage.createMany({ data: messageData });

          // Update campaign to RUNNING
          await prisma.campaign.update({
            where: { id: campaign.id },
            data: {
              status: 'RUNNING',
              startedAt: new Date(),
              totalMessages: entries.length,
            },
          });

          // Add processing job
          await campaignProcessQueue.add(
            'process-message',
            { campaignId: campaign.id },
            { jobId: `campaign-${campaign.id}-${Date.now()}` },
          );

          await prisma.activityLog.create({
            data: {
              type: 'CAMPAIGN_STARTED',
              message: `Scheduled campaign "${campaign.name}" started with ${entries.length} messages`,
              userId: campaign.userId,
            },
          });

          emitToUser(campaign.userId, 'campaign:status', {
            campaignId: campaign.id,
            status: 'RUNNING',
            totalMessages: entries.length,
          });

          logger.info(
            { campaignId: campaign.id, totalMessages: entries.length },
            'Scheduled campaign started',
          );
        } catch (err) {
          logger.error({ campaignId: campaign.id, err }, 'Failed to start scheduled campaign');

          await prisma.campaign.update({
            where: { id: campaign.id },
            data: {
              status: 'FAILED',
              completedAt: new Date(),
            },
          });

          await prisma.activityLog.create({
            data: {
              type: 'CAMPAIGN_FAILED',
              message: `Scheduled campaign "${campaign.name}" failed to start`,
              userId: campaign.userId,
            },
          });
        }
      }
    },
    { connection: redis, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Campaign scheduler job failed');
  });

  return worker;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Schedule the next campaign message processing job with appropriate delay. */
async function scheduleNextJob(campaignId: string, messagesPerMinute: number): Promise<void> {
  const delayMs = Math.round(60_000 / messagesPerMinute);

  await campaignProcessQueue.add(
    'process-message',
    { campaignId },
    {
      jobId: `campaign-${campaignId}-${Date.now()}`,
      delay: delayMs,
    },
  );
}

/** Quick progress calculation using campaign counters (avoids heavy groupBy). */
async function getQuickProgress(
  campaignId: string,
  totalMessages: number,
): Promise<{ total: number; sent: number; failed: number }> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { sentCount: true, failedCount: true },
  });

  return {
    total: totalMessages,
    sent: campaign?.sentCount || 0,
    failed: campaign?.failedCount || 0,
  };
}
