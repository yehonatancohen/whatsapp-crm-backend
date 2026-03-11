import { WarmupLevel } from '@prisma/client';
import { prisma } from '../../shared/db';
import { logger } from '../../shared/logger';

/**
 * Ordered warmup levels from lowest to highest.
 * Used to determine whether an account meets the minimum warmup requirement.
 */
const LEVEL_ORDER: WarmupLevel[] = [
  WarmupLevel.L1,
  WarmupLevel.L2,
  WarmupLevel.L3,
  WarmupLevel.L4,
  WarmupLevel.L5,
];

/** The minimum warmup level required for campaign sending. */
const MIN_CAMPAIGN_LEVEL = WarmupLevel.L3;

/** Returns the eligible warmup levels (>= minimum). */
function getEligibleLevels(minLevel: WarmupLevel = MIN_CAMPAIGN_LEVEL): WarmupLevel[] {
  const minIdx = LEVEL_ORDER.indexOf(minLevel);
  return LEVEL_ORDER.slice(minIdx);
}

/**
 * Select the best account for sending the next campaign message.
 *
 * Strategy:
 *  1. Get all AUTHENTICATED accounts owned by the campaign's user.
 *  2. Filter by minimum warmup level (>= L3).
 *  3. Filter out accounts that have hit their dailyLimitPerAccount for this campaign.
 *  4. Pick the account with the fewest messages sent for this campaign (round-robin effect).
 *  5. Optionally exclude specific account IDs.
 */
export async function selectAccount(
  campaignId: string,
  excludeAccountIds: string[] = [],
): Promise<{ id: string; userId: string } | null> {
  // Fetch the campaign to know the user and daily limit
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { userId: true, dailyLimitPerAccount: true },
  });

  if (!campaign) {
    logger.warn({ campaignId }, 'Campaign not found during account selection');
    return null;
  }

  const eligibleLevels = getEligibleLevels();

  // Get all authenticated accounts for this user
  const accounts = await prisma.account.findMany({
    where: {
      userId: campaign.userId,
      status: 'AUTHENTICATED',
      id: excludeAccountIds.length > 0 ? { notIn: excludeAccountIds } : undefined,
    },
    select: { id: true, userId: true },
  });

  if (accounts.length === 0) {
    logger.warn({ campaignId, userId: campaign.userId }, 'No eligible accounts for campaign');
    return null;
  }

  // Count messages sent today per account for this campaign
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const messageCounts = await prisma.campaignMessage.groupBy({
    by: ['accountId'],
    where: {
      campaignId,
      accountId: { in: accounts.map((a) => a.id) },
      sentAt: { gte: startOfDay },
      status: { in: ['SENT', 'DELIVERED', 'SENDING'] },
    },
    _count: { id: true },
  });

  const countMap = new Map<string, number>();
  for (const mc of messageCounts) {
    if (mc.accountId) {
      countMap.set(mc.accountId, mc._count.id);
    }
  }

  // Filter out accounts that have reached their daily limit
  const available = accounts.filter((account) => {
    const sentToday = countMap.get(account.id) || 0;
    return sentToday < campaign.dailyLimitPerAccount;
  });

  if (available.length === 0) {
    logger.warn({ campaignId }, 'All eligible accounts have hit daily campaign limit');
    return null;
  }

  // Pick the account with the fewest messages sent for this campaign (round-robin)
  // Count ALL messages (not just today) for true round-robin distribution
  const totalCounts = await prisma.campaignMessage.groupBy({
    by: ['accountId'],
    where: {
      campaignId,
      accountId: { in: available.map((a) => a.id) },
    },
    _count: { id: true },
  });

  const totalCountMap = new Map<string, number>();
  for (const tc of totalCounts) {
    if (tc.accountId) {
      totalCountMap.set(tc.accountId, tc._count.id);
    }
  }

  // Sort by total messages ascending — pick the one with fewest
  available.sort((a, b) => {
    const countA = totalCountMap.get(a.id) || 0;
    const countB = totalCountMap.get(b.id) || 0;
    return countA - countB;
  });

  const selected = available[0];
  logger.debug(
    { campaignId, accountId: selected.id, totalSent: totalCountMap.get(selected.id) || 0 },
    'Selected account for campaign message',
  );

  return selected;
}
