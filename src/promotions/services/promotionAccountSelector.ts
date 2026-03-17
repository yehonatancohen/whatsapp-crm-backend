import { prisma } from '../../shared/db';
import { logger } from '../../shared/logger';

/**
 * Select the best account for sending a promotion group message.
 *
 * Strategy (same as campaign account selector but reads from GroupPromotionLog):
 *  1. Filter accountIds to AUTHENTICATED accounts.
 *  2. Exclude any in excludeAccountIds.
 *  3. Count sends today from GroupPromotionLog — filter out those at daily limit.
 *  4. Round-robin: pick the account with fewest total sends for this promotion.
 */
export async function selectPromotionAccount(
  promotionId: string,
  accountIds: string[],
  dailyLimitPerAccount: number,
  excludeAccountIds: string[] = [],
): Promise<{ id: string; userId: string } | null> {
  const filteredIds = accountIds.filter((id) => !excludeAccountIds.includes(id));
  if (filteredIds.length === 0) return null;

  // Get authenticated accounts from the provided list
  const accounts = await prisma.account.findMany({
    where: {
      id: { in: filteredIds },
      status: 'AUTHENTICATED',
    },
    select: { id: true, userId: true },
  });

  if (accounts.length === 0) {
    logger.warn({ promotionId }, 'No authenticated accounts for promotion');
    return null;
  }

  // Count sends today per account
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const todayCounts = await prisma.groupPromotionLog.groupBy({
    by: ['accountId'],
    where: {
      promotionId,
      accountId: { in: accounts.map((a) => a.id) },
      sentAt: { gte: startOfDay },
      status: { in: ['SENT', 'SENDING'] },
    },
    _count: { id: true },
  });

  const todayMap = new Map<string, number>();
  for (const tc of todayCounts) {
    if (tc.accountId) todayMap.set(tc.accountId, tc._count.id);
  }

  // Filter out accounts at daily limit
  const available = accounts.filter((a) => (todayMap.get(a.id) || 0) < dailyLimitPerAccount);

  if (available.length === 0) {
    logger.warn({ promotionId }, 'All accounts hit daily promotion limit');
    return null;
  }

  // Round-robin: pick account with fewest total sends for this promotion
  const totalCounts = await prisma.groupPromotionLog.groupBy({
    by: ['accountId'],
    where: {
      promotionId,
      accountId: { in: available.map((a) => a.id) },
    },
    _count: { id: true },
  });

  const totalMap = new Map<string, number>();
  for (const tc of totalCounts) {
    if (tc.accountId) totalMap.set(tc.accountId, tc._count.id);
  }

  available.sort((a, b) => (totalMap.get(a.id) || 0) - (totalMap.get(b.id) || 0));

  return available[0];
}
