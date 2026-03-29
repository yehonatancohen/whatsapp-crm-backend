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

// BullMQ bundles its own ioredis types — cast to avoid duplicate-type mismatches.
const redis = redisInstance as any;

// ─── Message templates ──────────────────────────────────────────────────────

const MESSAGE_TEMPLATES = [
  "{Hey|Hi|{Yo|Sup}} {bro|man|dude}, {what's up?|how are you?|how's it going?}",
  "Just checking in, {everything good?|all good?|how have you been?}",
  "{Good morning|Morning}, {hope you have a good one|have a great day}!",
  "{Yo|Hey}, let me know when you're {free|around} to chat.",
  "{What's good|What's up}? {Haven't heard from you|Been a while}!",
  "{Hope you're doing well|Hope all is well}! {Talk soon|Catch up soon}.",
  "{Hey there|Hi there}, {just wanted to say hi|thought I'd reach out}!",
  "{Happy {Monday|Tuesday|Wednesday|Thursday|Friday}}! {Have a great one|Enjoy your day}.",
];

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

        // Check if enough time has passed since last activity
        if (progress.lastMessageAt) {
          const elapsed = now - progress.lastMessageAt.getTime();
          if (elapsed < levelConfig.intervalMinMs) {
            continue;
          }
        }

        // Randomize: only add a job if we're within the interval window
        // This creates natural variance rather than firing exactly at intervalMin
        if (progress.lastMessageAt) {
          const elapsed = now - progress.lastMessageAt.getTime();
          const intervalRange = levelConfig.intervalMaxMs - levelConfig.intervalMinMs;
          const threshold = Math.random() * intervalRange;
          if (elapsed - levelConfig.intervalMinMs < threshold) {
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

      try {
        switch (activityType) {
          case WarmupActivityType.MESSAGE_SENT:
            details = await executeMessageSent(accountId);
            break;
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
          messagesSentToday: { increment: 1 },
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

async function executeMessageSent(accountId: string): Promise<string> {
  const manager = ClientManager.getInstance();
  const senderInstance = manager.getInstanceById(accountId);
  if (!senderInstance) throw new Error(`No instance found for account ${accountId}`);

  const senderClient = senderInstance.getClient();
  if (!senderClient) throw new Error(`No client for account ${accountId}`);

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
  if (!recipientWid) throw new Error(`Cannot resolve WID for recipient ${recipientInstance.id}`);

  const template = pickRandom(MESSAGE_TEMPLATES);
  const message = resolveSpintax(template);

  await simulateHumanSend(senderClient, recipientWid, message);

  return `Sent to ${recipientInstance.id}: "${message}"`;
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
