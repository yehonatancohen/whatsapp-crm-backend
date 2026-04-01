import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../shared/middleware/auth';
import { prisma } from '../shared/db';

const router = Router();

router.use(authenticate);

// GET /api/activity — recent activity for the user
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const type = req.query.type as string | undefined;

    const where: any = { userId: req.user!.userId };
    if (type) where.type = type;

    const logs = await prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        type: true,
        message: true,
        metadata: true,
        createdAt: true,
        account: { select: { id: true, label: true } },
      },
    });

    res.json(logs);
  } catch (err) {
    next(err);
  }
});

// GET /api/activity/stats — dashboard stats
router.get('/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userFilter = { userId: req.user!.userId };

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [
      totalAccounts,
      authenticatedAccounts,
      totalContacts,
      totalCampaigns,
      activeCampaigns,
      messagesToday,
      warmupEnabled,
    ] = await Promise.all([
      prisma.account.count({ where: userFilter }),
      prisma.account.count({ where: { ...userFilter, status: 'AUTHENTICATED' } }),
      prisma.contact.count({
        where: {
          listEntries: {
            some: { contactList: { userId: req.user!.userId } },
          },
        },
      }),
      prisma.campaign.count({ where: userFilter }),
      prisma.campaign.count({ where: { ...userFilter, status: { in: ['RUNNING', 'SCHEDULED'] } } }),
      prisma.campaignMessage.count({
        where: {
          status: 'SENT',
          sentAt: { gte: today },
          campaign: userFilter,
        },
      }),
      prisma.account.count({ where: { ...userFilter, isWarmupEnabled: true } }),
    ]);

    res.json({
      totalAccounts,
      authenticatedAccounts,
      totalContacts,
      totalCampaigns,
      activeCampaigns,
      messagesToday,
      warmupEnabled,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
