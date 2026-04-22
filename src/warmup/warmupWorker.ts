import { Worker, Job } from 'bullmq';
import { WarmupActivityType } from '@prisma/client';
import { redis as redisInstance } from '../shared/redis';
import { prisma } from '../shared/db';
import { logger } from '../shared/logger';
import { emitToUser } from '../shared/socket';
import { ClientManager } from '../accounts/services/ClientManager';
import { getLevelConfig, applyIntensity } from './levelConfig';
import { checkLevelUp, getAccountProgress } from './warmupService';
import { warmupCycleQueue } from './warmupQueue';
import { resolveSpintax } from './spintax';
import { simulateHumanSend } from './humanDelay';
import {
  getDailyProfile,
  isInsideActiveHours,
  isInsideBurst,
  targetMessagesByNow,
  burstIntervalMs,
} from './activityWindow';
import { generateWarmupMessage } from './messageGenerator';
import { buildOwnVCard } from './vcard';

// BullMQ bundles its own ioredis types — cast to avoid duplicate-type mismatches.
const redis = redisInstance as any;

// ─── Message templates ──────────────────────────────────────────────────────

// Message templates moved to messageGenerator.ts (length-bucketed + entropy layers).

const STATUS_MESSAGES = [
  "Living life one day at a time",
  "Busy building something great",
  "Available for a chat",
  "Working hard, playing harder",
  "Good vibes only",
  "Making moves in silence",
  "On my grind",
  "Blessed and grateful",
];

const STORY_MESSAGES = [
  "{Good morning|Hello} everyone! {Hope you all have a great day|Wishing you all well}!",
  "{Happy {Monday|Tuesday|Wednesday|Thursday|Friday}}! {Let's make it count|Let's crush it}!",
  "Just a {quick|little} reminder to {stay positive|keep pushing|be kind}!",
  "{Feeling {grateful|blessed|motivated}} today!",
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Warmup Scheduler Worker ────────────────────────────────────────────────

export function createSchedulerWorker(): Worker {
  const worker = new Worker(
    'warmup-scheduler',
    async (_job: Job) => {
      logger.debug('Warmup scheduler tick');

      // Find all warmup-enabled accounts that are authenticated
      const accounts = await prisma.account.findMany({
        where: {
          isWarmupEnabled: true,
          status: 'AUTHENTICATED',
        },
      });

      const now = Date.now();

      for (const account of accounts) {
        if (!account.phoneNumber) continue;

        const progress = await prisma.warmupProgress.findUnique({
          where: { phoneNumber: account.phoneNumber }
        });

        if (!progress) continue;

        const levelConfig = applyIntensity(getLevelConfig(progress.warmupLevel), progress.warmupIntensity);

        // Check daily message limit
        if (progress.messagesSentToday >= levelConfig.maxMessagesPerDay) {
          continue;
        }

        // Activity window gate: skip if outside active hours or not inside a burst.
        const nowDate = new Date(now);
        const profile = getDailyProfile(account.phoneNumber, nowDate);
        if (!isInsideActiveHours(profile, nowDate)) {
          continue;
        }
        if (isInsideBurst(profile, nowDate) === null) {
          continue;
        }

        // Burst-quota gate: don't spend more than today's cumulative burst target.
        const target = targetMessagesByNow(profile, levelConfig.maxMessagesPerDay, nowDate);
        if (progress.messagesSentToday >= target) {
          continue;
        }

        // Inside a burst, use tighter intervals (human typing-session spacing)
        // rather than the level's baseline intervals.
        const { minMs: intervalMinMs, maxMs: intervalMaxMs } = burstIntervalMs();

        // Check if enough time has passed since last activity
        if (progress.lastMessageAt) {
          const elapsed = now - progress.lastMessageAt.getTime();
          if (elapsed < intervalMinMs) {
            continue;
          }
        }

        // Randomize: only add a job if we're within the interval window
        // This creates natural variance rather than firing exactly at intervalMin
        if (progress.lastMessageAt) {
          const elapsed = now - progress.lastMessageAt.getTime();
          const intervalRange = intervalMaxMs - intervalMinMs;
          const threshold = Math.random() * intervalRange;
          if (elapsed - intervalMinMs < threshold) {
            continue;
          }
        }

        // Add a warmup cycle job for this account
        await warmupCycleQueue.add(
          'warmup-activity',
          { accountId: account.id },
          { jobId: `warmup-${account.id}-${Date.now()}` },
        );

        logger.debug({ accountId: account.id, level: progress.warmupLevel }, 'Queued warmup cycle');
      }
    },
    { connection: redis, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Warmup scheduler job failed');
  });

  return worker;
}

// ─── Warmup Cycle Worker ────────────────────────────────────────────────────

export function createCycleWorker(): Worker {
  const worker = new Worker(
    'warmup-cycle',
    async (job: Job<{ accountId: string }>) => {
      const { accountId } = job.data;

      const account = await prisma.account.findUnique({ where: { id: accountId } });
      if (!account || !account.isWarmupEnabled || account.status !== 'AUTHENTICATED' || !account.phoneNumber) {
        logger.debug({ accountId }, 'Skipping warmup cycle — account not eligible');
        return;
      }

      const progress = await prisma.warmupProgress.findUnique({
        where: { phoneNumber: account.phoneNumber }
      });

      if (!progress) return;

      const levelConfig = applyIntensity(getLevelConfig(progress.warmupLevel), progress.warmupIntensity);

      // Re-check daily limit
      if (progress.messagesSentToday >= levelConfig.maxMessagesPerDay) {
        logger.debug({ accountId }, 'Skipping warmup cycle — daily limit reached');
        return;
      }

      // Pick a random allowed activity type
      // Filter out MESSAGE_RECEIVED since that's passive (not something we initiate)
      const initiableActivities = levelConfig.activities.filter(
        (a) => a !== WarmupActivityType.MESSAGE_RECEIVED,
      );
      if (initiableActivities.length === 0) {
        logger.warn({ accountId }, 'No initiable activities for this level');
        return;
      }

      const activityType = pickRandom(initiableActivities);
      let details: string | undefined;
      // Some activities (vCard nudge, typo correction) send more than one
      // WhatsApp message per cycle; count them all against the daily quota.
      let messageCount = 1;

      try {
        switch (activityType) {
          case WarmupActivityType.MESSAGE_SENT: {
            const result = await executeMessageSent(accountId);
            details = result.details;
            messageCount = result.messageCount;
            break;
          }
          case WarmupActivityType.PROFILE_UPDATE:
            details = await executeProfileUpdate(accountId);
            break;
          case WarmupActivityType.STATUS_POST:
            details = await executeStatusPost(accountId);
            break;
          default:
            logger.warn({ accountId, activityType }, 'Unknown activity type');
            return;
        }
      } catch (err) {
        logger.error({ accountId, activityType, err }, 'Warmup activity failed');
        return;
      }

      // Log the activity
      await prisma.warmupLog.create({
        data: {
          accountId,
          activityType,
          details,
        },
      });

      // Increment daily counter and update last message time
      await prisma.warmupProgress.update({
        where: { phoneNumber: account.phoneNumber },
        data: {
          messagesSentToday: { increment: messageCount },
          lastMessageAt: new Date()
        }
      });

      // Emit socket event
      emitToUser(account.userId, 'warmup:activity', {
        accountId,
        type: activityType,
        details,
      });

      // Check for level-up
      const didLevelUp = await checkLevelUp(accountId);
      if (didLevelUp) {
        const { progress: updated } = await getAccountProgress(accountId);

        // Create activity log entry for level-up
        await prisma.activityLog.create({
          data: {
            type: 'WARMUP_LEVEL_UP',
            message: `Account leveled up to ${updated!.warmupLevel}`,
            userId: account.userId,
            accountId,
          },
        });

        emitToUser(account.userId, 'warmup:levelup', {
          accountId,
          newLevel: updated!.warmupLevel,
        });
      }

      logger.info({ accountId, activityType, details }, 'Warmup activity completed');
    },
    { connection: redis, concurrency: 3 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, accountId: job?.data?.accountId, err }, 'Warmup cycle job failed');
  });

  return worker;
}

// ─── Activity Executors ─────────────────────────────────────────────────────

interface MessageSentResult {
  details: string;
  messageCount: number;
}

async function executeMessageSent(accountId: string): Promise<MessageSentResult> {
  const manager = ClientManager.getInstance();
  const senderInstance = manager.getInstanceById(accountId);
  if (!senderInstance) throw new Error(`No instance found for account ${accountId}`);

  const senderClient = senderInstance.getClient();
  if (!senderClient) throw new Error(`No client for account ${accountId}`);

  const senderAccount = await prisma.account.findUnique({ where: { id: accountId } });
  if (!senderAccount?.phoneNumber) {
    throw new Error(`Sender account ${accountId} has no phone number`);
  }

  // Pick a random authenticated account as recipient (must be different)
  const authenticatedInstances = manager.getAuthenticatedInstances();
  const otherInstances = authenticatedInstances.filter((inst) => inst.id !== accountId);

  if (otherInstances.length === 0) {
    throw new Error('No other authenticated accounts available for inter-account messaging');
  }

  const recipientInstance = pickRandom(otherInstances);
  const recipientClient = recipientInstance.getClient();
  if (!recipientClient) throw new Error(`No client for recipient ${recipientInstance.id}`);

  const recipientWid = recipientClient.info?.wid?._serialized;
  const recipientUser = recipientClient.info?.wid?.user;
  if (!recipientWid || !recipientUser) {
    throw new Error(`Cannot resolve WID for recipient ${recipientInstance.id}`);
  }

  let messageCount = 0;
  const detailParts: string[] = [];

  // vCard contact nudge: only on the very first message from this sender to
  // this recipient. Renders as a tappable "save contact" card in WhatsApp —
  // a strong positive trust signal if the recipient saves the number.
  const alreadySeen = await prisma.warmupContactSeen.findUnique({
    where: {
      senderAccountId_recipientPhone: {
        senderAccountId: accountId,
        recipientPhone: recipientUser,
      },
    },
  });

  if (!alreadySeen) {
    const displayName = senderClient.info?.pushname || senderAccount.phoneNumber;
    const vcard = buildOwnVCard(senderAccount.phoneNumber, displayName);

    // Short presence + pause before dropping the card, then a short gap
    // before the text message so the card arrives first in chat order.
    await senderClient.sendPresenceAvailable();
    await sleep(randInt(1000, 2000));
    await senderClient.sendMessage(recipientWid, vcard, { parseVCards: true });
    messageCount++;
    detailParts.push(`vcard:${recipientInstance.id}`);

    await prisma.warmupContactSeen.create({
      data: {
        senderAccountId: accountId,
        recipientPhone: recipientUser,
      },
    });

    await sleep(randInt(2000, 4000));
  }

  // Primary text message (with typo-and-correction entropy layer)
  const msg = generateWarmupMessage();
  await simulateHumanSend(senderClient, recipientWid, msg.primary);
  messageCount++;
  detailParts.push(`${msg.bucket}:"${msg.primary}"`);

  if (msg.correction) {
    // Short pause before the starred correction, mimicking "oh I typo'd".
    await sleep(randInt(3000, 6000));
    await simulateHumanSend(senderClient, recipientWid, msg.correction);
    messageCount++;
    detailParts.push(`fix:"${msg.correction}"`);
  }

  return {
    details: `→${recipientInstance.id} ${detailParts.join(' | ')}`,
    messageCount,
  };
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function executeProfileUpdate(accountId: string): Promise<string> {
  const manager = ClientManager.getInstance();
  const instance = manager.getInstanceById(accountId);
  if (!instance) throw new Error(`No instance found for account ${accountId}`);

  const client = instance.getClient();
  if (!client) throw new Error(`No client for account ${accountId}`);

  const statusText = pickRandom(STATUS_MESSAGES);
  await client.setStatus(statusText);

  return `Profile status updated: "${statusText}"`;
}

async function executeStatusPost(accountId: string): Promise<string> {
  const manager = ClientManager.getInstance();
  const instance = manager.getInstanceById(accountId);
  if (!instance) throw new Error(`No instance found for account ${accountId}`);

  const client = instance.getClient();
  if (!client) throw new Error(`No client for account ${accountId}`);

  const template = pickRandom(STORY_MESSAGES);
  const storyText = resolveSpintax(template);
  await client.sendMessage('status@broadcast', storyText);

  return `Status posted: "${storyText}"`;
}
