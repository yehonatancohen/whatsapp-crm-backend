import { WarmupLevel } from '@prisma/client';
import { prisma } from '../shared/db';
import { logger } from '../shared/logger';
import { NotFoundError, ForbiddenError } from '../shared/errors';
import { getLevelConfig, getNextLevel, LevelConfig } from './levelConfig';

export interface WarmupStatus {
  accountId: string;
  level: WarmupLevel;
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

/** Get the warmup status for a single account. */
export async function getWarmupStatus(accountId: string): Promise<WarmupStatus> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new NotFoundError('Account');

  const levelConfig = getLevelConfig(account.warmupLevel);
  const totalMessagesSent = await getTotalMessagesSent(accountId);
  const daysAtCurrentLevel = getDaysAtLevel(account.warmupStartedAt);

  return {
    accountId: account.id,
    level: account.warmupLevel,
    isWarmupEnabled: account.isWarmupEnabled,
    warmupStartedAt: account.warmupStartedAt,
    messagesSentToday: account.messagesSentToday,
    lastMessageAt: account.lastMessageAt,
    levelConfig,
    totalMessagesSent,
    daysAtCurrentLevel,
    nextLevel: getNextLevel(account.warmupLevel),
  };
}

/** Enable or disable warmup for an account. */
export async function toggleWarmup(
  accountId: string,
  enabled: boolean,
  userId: string,
  role: string,
): Promise<WarmupStatus> {
  await getOwnedAccount(accountId, userId, role);

  const updateData: Record<string, unknown> = {
    isWarmupEnabled: enabled,
  };

  // Set warmupStartedAt when enabling for the first time (or re-enabling)
  if (enabled) {
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account!.warmupStartedAt) {
      updateData.warmupStartedAt = new Date();
    }
  }

  await prisma.account.update({
    where: { id: accountId },
    data: updateData,
  });

  logger.info({ accountId, enabled }, 'Warmup toggled');
  return getWarmupStatus(accountId);
}

/** Check if an account qualifies for level-up and apply it. Returns true if leveled up. */
export async function checkLevelUp(accountId: string): Promise<boolean> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) return false;

  const nextLevel = getNextLevel(account.warmupLevel);
  if (!nextLevel) return false; // Already at max level

  const currentConfig = getLevelConfig(account.warmupLevel);
  const totalMessagesSent = await getTotalMessagesSent(accountId);
  const daysAtCurrentLevel = getDaysAtLevel(account.warmupStartedAt);

  const meetsMessageReq = totalMessagesSent >= currentConfig.minTotalMessages;
  const meetsDayReq = daysAtCurrentLevel >= currentConfig.minDaysAtLevel;

  if (!meetsMessageReq || !meetsDayReq) return false;

  // Apply level-up
  await prisma.account.update({
    where: { id: accountId },
    data: {
      warmupLevel: nextLevel,
      warmupStartedAt: new Date(), // Reset timer for new level
    },
  });

  logger.info(
    { accountId, from: account.warmupLevel, to: nextLevel, totalMessagesSent, daysAtCurrentLevel },
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
  const result = await prisma.account.updateMany({
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
    const levelCfg = getLevelConfig(account.warmupLevel);
    const totalMessages = await getTotalMessagesSent(account.id);
    const daysAtLevel = getDaysAtLevel(account.warmupStartedAt);

    if (account.isWarmupEnabled) totalEnabled++;
    totalMessages24h += account.messagesSentToday;

    overviewAccounts.push({
      accountId: account.id,
      label: account.label,
      level: account.warmupLevel,
      isEnabled: account.isWarmupEnabled,
      messagesSentToday: account.messagesSentToday,
      maxMessagesPerDay: levelCfg.maxMessagesPerDay,
      warmupStartedAt: account.warmupStartedAt,
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
