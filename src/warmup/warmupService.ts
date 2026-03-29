import { WarmupLevel, WarmupIntensity } from '@prisma/client';
import { prisma } from '../shared/db';
import { logger } from '../shared/logger';
import { NotFoundError, ForbiddenError } from '../shared/errors';
import { getLevelConfig, getNextLevel, LevelConfig } from './levelConfig';

export interface WarmupStatus {
  accountId: string;
  level: WarmupLevel;
  intensity: WarmupIntensity;
  isWarmupEnabled: boolean;
  warmupStartedAt: Date | null;
  messagesSentToday: number;
  lastMessageAt: Date | null;
  levelConfig: LevelConfig;
  totalMessagesSent: number;
  daysAtCurrentLevel: number;
  nextLevel: WarmupLevel | null;
}

export interface WarmupOverviewAccount {
  accountId: string;
  label: string;
  level: WarmupLevel;
  intensity: WarmupIntensity;
  isEnabled: boolean;
  messagesSentToday: number;
  maxMessagesPerDay: number;
  warmupStartedAt: Date | null;
  daysAtLevel: number;
  minDaysForLevelUp: number;
  totalMessages: number;
  minMessagesForLevelUp: number;
  progress: number; // 0-100
}

export interface WarmupOverviewResponse {
  accounts: WarmupOverviewAccount[];
  totalEnabled: number;
  totalMessages24h: number;
}

/** Get the total warmup messages sent by an account. */
async function getTotalMessagesSent(accountId: string): Promise<number> {
  return prisma.warmupLog.count({
    where: {
      accountId,
      activityType: 'MESSAGE_SENT',
    },
  });
}

/** Calculate how many days the account has been at the current warmup level. */
function getDaysAtLevel(warmupStartedAt: Date | null): number {
  if (!warmupStartedAt) return 0;
  const now = new Date();
  const diffMs = now.getTime() - warmupStartedAt.getTime();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

/** Verify account exists and belongs to the user (unless admin). */
async function getOwnedAccount(accountId: string, userId: string, role: string) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new NotFoundError('Account');
  if (role !== 'ADMIN' && account.userId !== userId) {
    throw new ForbiddenError('You do not own this account');
  }
  return account;
}

export async function getAccountProgress(accountId: string) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new NotFoundError('Account');

  let progress = null;
  if (account.phoneNumber) {
    progress = await prisma.warmupProgress.findUnique({ where: { phoneNumber: account.phoneNumber } });
    if (!progress) {
      progress = await prisma.warmupProgress.create({ data: { phoneNumber: account.phoneNumber } });
    }
  }

  return { account, progress };
}

/** Get the warmup status for a single account. */
export async function getWarmupStatus(accountId: string): Promise<WarmupStatus> {
  const { account, progress } = await getAccountProgress(accountId);

  const level = progress ? progress.warmupLevel : 'L1';
  const intensity = progress ? progress.warmupIntensity : WarmupIntensity.NORMAL;
  const warmupStartedAt = progress ? progress.warmupStartedAt : null;
  const messagesSentToday = progress ? progress.messagesSentToday : 0;

  const levelConfig = getLevelConfig(level);
  const totalMessagesSent = await getTotalMessagesSent(accountId);
  const daysAtCurrentLevel = getDaysAtLevel(warmupStartedAt);

  return {
    accountId: account.id,
    level,
    intensity,
    isWarmupEnabled: account.isWarmupEnabled,
    warmupStartedAt,
    messagesSentToday,
    lastMessageAt: progress ? progress.lastMessageAt : null,
    levelConfig,
    totalMessagesSent,
    daysAtCurrentLevel,
    nextLevel: getNextLevel(level),
  };
}

/** Enable or disable warmup for an account. */
export async function toggleWarmup(
  accountId: string,
  enabled: boolean,
  userId: string,
  role: string,
): Promise<WarmupStatus> {
  const account = await getOwnedAccount(accountId, userId, role);

  await prisma.account.update({
    where: { id: accountId },
    data: { isWarmupEnabled: enabled },
  });

  // Set warmupStartedAt when enabling for the first time (or re-enabling), on the phone number
  if (enabled && account.phoneNumber) {
    const progress = await prisma.warmupProgress.findUnique({ where: { phoneNumber: account.phoneNumber } });
    if (progress && !progress.warmupStartedAt) {
      await prisma.warmupProgress.update({
        where: { phoneNumber: account.phoneNumber },
        data: { warmupStartedAt: new Date() }
      });
    } else if (!progress) {
      await prisma.warmupProgress.create({
        data: { phoneNumber: account.phoneNumber, warmupStartedAt: new Date() }
      });
    }
  }

  logger.info({ accountId, enabled }, 'Warmup toggled');
  return getWarmupStatus(accountId);
}

/** Check if an account qualifies for level-up and apply it. Returns true if leveled up. */
export async function checkLevelUp(accountId: string): Promise<boolean> {
  const { account, progress } = await getAccountProgress(accountId);
  if (!account || !progress) return false;

  const nextLevel = getNextLevel(progress.warmupLevel);
  if (!nextLevel) return false; // Already at max level

  const currentConfig = getLevelConfig(progress.warmupLevel);
  const totalMessagesSent = await getTotalMessagesSent(accountId);
  const daysAtCurrentLevel = getDaysAtLevel(progress.warmupStartedAt);

  const meetsMessageReq = totalMessagesSent >= currentConfig.minTotalMessages;
  const meetsDayReq = daysAtCurrentLevel >= currentConfig.minDaysAtLevel;

  if (!meetsMessageReq || !meetsDayReq) return false;

  // Apply level-up
  await prisma.warmupProgress.update({
    where: { phoneNumber: account.phoneNumber! },
    data: {
      warmupLevel: nextLevel,
      warmupStartedAt: new Date(), // Reset timer for new level
    },
  });

  logger.info(
    { accountId, from: progress.warmupLevel, to: nextLevel, totalMessagesSent, daysAtCurrentLevel },
    'Account leveled up',
  );

  return true;
}

/** Get recent warmup log entries for an account. */
export async function getWarmupHistory(accountId: string, limit = 50) {
  return prisma.warmupLog.findMany({
    where: { accountId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/** Reset messagesSentToday for all accounts. Called daily. */
export async function resetDailyCounts(): Promise<number> {
  const result = await prisma.warmupProgress.updateMany({
    where: { messagesSentToday: { gt: 0 } },
    data: { messagesSentToday: 0 },
  });

  logger.info({ count: result.count }, 'Reset daily warmup counts');
  return result.count;
}

/** Calculate progress percentage toward next level (0-100). */
function calculateProgress(
  totalMessages: number,
  daysAtLevel: number,
  levelCfg: LevelConfig,
): number {
  if (levelCfg.minTotalMessages === 0 && levelCfg.minDaysAtLevel === 0) return 100; // L5, fully warmed

  const msgProgress = levelCfg.minTotalMessages > 0
    ? Math.min(100, (totalMessages / levelCfg.minTotalMessages) * 100)
    : 100;
  const dayProgress = levelCfg.minDaysAtLevel > 0
    ? Math.min(100, (daysAtLevel / levelCfg.minDaysAtLevel) * 100)
    : 100;

  // Average of both requirements
  return Math.round((msgProgress + dayProgress) / 2);
}

/** Set the warmup intensity for an account. */
export async function setWarmupIntensity(
  accountId: string,
  intensity: WarmupIntensity,
  userId: string,
  role: string,
): Promise<WarmupStatus> {
  const account = await getOwnedAccount(accountId, userId, role);
  if (!account.phoneNumber) throw new NotFoundError('Account phone number');

  await prisma.warmupProgress.upsert({
    where: { phoneNumber: account.phoneNumber },
    update: { warmupIntensity: intensity },
    create: { phoneNumber: account.phoneNumber, warmupIntensity: intensity },
  });

  logger.info({ accountId, intensity }, 'Warmup intensity updated');
  return getWarmupStatus(accountId);
}

/**
 * Reset warmup progress to L1 with GHOST intensity for ban recovery.
 * Also enables warmup so the slow recovery begins immediately.
 */
export async function startBanRecovery(
  accountId: string,
  userId: string,
  role: string,
): Promise<WarmupStatus> {
  const account = await getOwnedAccount(accountId, userId, role);
  if (!account.phoneNumber) throw new NotFoundError('Account phone number');

  await prisma.warmupProgress.upsert({
    where: { phoneNumber: account.phoneNumber },
    update: {
      warmupLevel: WarmupLevel.L1,
      warmupIntensity: WarmupIntensity.GHOST,
      warmupStartedAt: new Date(),
      messagesSentToday: 0,
      lastMessageAt: null,
    },
    create: {
      phoneNumber: account.phoneNumber,
      warmupLevel: WarmupLevel.L1,
      warmupIntensity: WarmupIntensity.GHOST,
      warmupStartedAt: new Date(),
    },
  });

  await prisma.account.update({
    where: { id: accountId },
    data: { isWarmupEnabled: true },
  });

  logger.info({ accountId }, 'Ban recovery warmup started');
  return getWarmupStatus(accountId);
}

/** Get warmup overview for all accounts belonging to a user (shows all authenticated, not just enabled). */
export async function getWarmupOverview(userId: string, role: string): Promise<WarmupOverviewResponse> {
  const where = role === 'ADMIN'
    ? { status: 'AUTHENTICATED' as const }
    : { userId, status: 'AUTHENTICATED' as const };

  const accounts = await prisma.account.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  const overviewAccounts: WarmupOverviewAccount[] = [];
  let totalMessages24h = 0;
  let totalEnabled = 0;

  for (const account of accounts) {
    let level: WarmupLevel = 'L1';
    let intensity: WarmupIntensity = WarmupIntensity.NORMAL;
    let warmupStartedAt: Date | null = null;
    let messagesSentToday = 0;

    if (account.phoneNumber) {
      const progress = await prisma.warmupProgress.findUnique({ where: { phoneNumber: account.phoneNumber } });
      if (progress) {
        level = progress.warmupLevel;
        intensity = progress.warmupIntensity;
        warmupStartedAt = progress.warmupStartedAt;
        messagesSentToday = progress.messagesSentToday;
      }
    }

    const levelCfg = getLevelConfig(level);
    const totalMessages = await getTotalMessagesSent(account.id);
    const daysAtLevel = getDaysAtLevel(warmupStartedAt);

    if (account.isWarmupEnabled) totalEnabled++;
    totalMessages24h += messagesSentToday;

    overviewAccounts.push({
      accountId: account.id,
      label: account.label,
      level,
      intensity,
      isEnabled: account.isWarmupEnabled,
      messagesSentToday,
      maxMessagesPerDay: levelCfg.maxMessagesPerDay,
      warmupStartedAt,
      daysAtLevel,
      minDaysForLevelUp: levelCfg.minDaysAtLevel,
      totalMessages,
      minMessagesForLevelUp: levelCfg.minTotalMessages,
      progress: calculateProgress(totalMessages, daysAtLevel, levelCfg),
    });
  }

  return {
    accounts: overviewAccounts,
    totalEnabled,
    totalMessages24h,
  };
}
