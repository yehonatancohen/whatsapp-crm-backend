import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../shared/middleware/auth';
import { prisma } from '../shared/db';

const router = Router();
router.use(authenticate);

// GET /api/analytics/campaign-stats — aggregated campaign performance
router.get('/campaign-stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const campaigns = await prisma.campaign.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        status: true,
        type: true,
        totalMessages: true,
        sentCount: true,
        deliveredCount: true,
        failedCount: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const totalSent = campaigns.reduce((sum, c) => sum + c.sentCount, 0);
    const totalDelivered = campaigns.reduce((sum, c) => sum + c.deliveredCount, 0);
    const totalFailed = campaigns.reduce((sum, c) => sum + c.failedCount, 0);
    const totalMessages = campaigns.reduce((sum, c) => sum + c.totalMessages, 0);

    res.json({
      campaigns,
      summary: {
        totalCampaigns: campaigns.length,
        totalMessages,
        totalSent,
        totalDelivered,
        totalFailed,
        deliveryRate: totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 0,
        failureRate: totalMessages > 0 ? Math.round((totalFailed / totalMessages) * 100) : 0,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/analytics/message-trends — messages sent per day (last 30 days)
router.get('/message-trends', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const days = Math.min(parseInt(req.query.days as string) || 30, 90);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const messages = await prisma.campaignMessage.findMany({
      where: {
        campaign: { userId },
        sentAt: { gte: since },
        status: { in: ['SENT', 'DELIVERED'] },
      },
      select: { sentAt: true, status: true },
    });

    // Group by date
    const byDate = new Map<string, { sent: number; delivered: number }>();
    for (let d = 0; d < days; d++) {
      const date = new Date(since);
      date.setDate(date.getDate() + d);
      byDate.set(date.toISOString().split('T')[0], { sent: 0, delivered: 0 });
    }

    for (const msg of messages) {
      if (!msg.sentAt) continue;
      const key = msg.sentAt.toISOString().split('T')[0];
      const entry = byDate.get(key);
      if (entry) {
        entry.sent++;
        if (msg.status === 'DELIVERED') entry.delivered++;
      }
    }

    res.json(
      Array.from(byDate.entries()).map(([date, counts]) => ({
        date,
        ...counts,
      })),
    );
  } catch (err) { next(err); }
});

// GET /api/analytics/account-health — account status + warmup overview
router.get('/account-health', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const accounts = await prisma.account.findMany({
      where: { userId },
      select: {
        id: true,
        label: true,
        status: true,
        phoneNumber: true,
        isWarmupEnabled: true,
        createdAt: true,
        _count: { select: { campaignMessages: true, warmupLogs: true } },
      },
    });

    res.json(accounts);
  } catch (err) { next(err); }
});

// GET /api/analytics/usage — current usage vs plan limits
router.get('/usage', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      accountCount,
      contactCount,
      campaignsThisMonth,
      messagesToday,
      subscription,
    ] = await Promise.all([
      prisma.account.count({ where: { userId } }),
      prisma.contact.count({
        where: {
          listEntries: {
            some: { contactList: { userId } },
          },
        },
      }),
      prisma.campaign.count({
        where: { userId, createdAt: { gte: monthStart } },
      }),
      prisma.campaignMessage.count({
        where: {
          status: { in: ['SENT', 'DELIVERED'] },
          sentAt: { gte: today },
          campaign: { userId },
        },
      }),
      prisma.subscription.findUnique({
        where: { userId },
        select: { planTier: true, status: true, trialEndsAt: true, currentPeriodEnd: true },
      }),
    ]);

    res.json({
      planTier: subscription?.planTier || 'STARTER',
      subscriptionStatus: subscription?.status || 'TRIALING',
      usage: {
        accounts: accountCount,
        contacts: contactCount,
        campaignsThisMonth,
        messagesToday,
      },
    });
  } catch (err) { next(err); }
});

export default router;
