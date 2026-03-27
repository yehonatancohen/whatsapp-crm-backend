import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../shared/middleware/auth';
import { requireRole } from '../shared/middleware/rbac';
import { validate } from '../shared/middleware/validate';
import { prisma } from '../shared/db';
import { NotFoundError } from '../shared/errors';
import { generateAccessToken, generateRefreshToken } from '../auth/services/tokenService';

const router = Router();

router.use(authenticate);
router.use(requireRole('ADMIN'));

const updateUserSchema = z.object({
  role: z.enum(['ADMIN', 'USER']).optional(),
  isActive: z.boolean().optional(),
  emailVerified: z.boolean().optional(),
  planTier: z.enum(['STARTER', 'PRO', 'ENTERPRISE']).optional(),
  subscriptionStatus: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID']).optional(),
});

// GET /api/users/stats/overview
router.get('/stats/overview', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      verifiedUsers,
      activeUsers,
      newUsersWeek,
      newUsersMonth,
      subscriptions,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { emailVerified: true } }),
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: monthAgo } } }),
      prisma.subscription.groupBy({
        by: ['status', 'planTier'],
        _count: { id: true },
      }),
    ]);

    // Build subscription breakdown
    const subsByStatus: Record<string, number> = {};
    const subsByTier: Record<string, number> = {};
    for (const row of subscriptions) {
      subsByStatus[row.status] = (subsByStatus[row.status] || 0) + row._count.id;
      subsByTier[row.planTier] = (subsByTier[row.planTier] || 0) + row._count.id;
    }

    res.json({
      totalUsers,
      verifiedUsers,
      activeUsers,
      newUsersWeek,
      newUsersMonth,
      subsByStatus,
      subsByTier,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/users
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        emailVerified: true,
        createdAt: true,
        _count: { select: { accounts: true, campaigns: true } },
        subscription: {
          select: { planTier: true, status: true, trialEndsAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/users/:id
router.patch(
  '/:id',
  validate(updateUserSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        include: { subscription: true },
      });
      if (!user) throw new NotFoundError('User');

      const { planTier, subscriptionStatus, ...userData } = req.body;

      // Update user fields (role, isActive, emailVerified) if provided
      if (Object.keys(userData).length > 0) {
        await prisma.user.update({
          where: { id: req.params.id },
          data: userData,
        });
      }

      // Update subscription plan tier and/or status if provided
      if ((planTier || subscriptionStatus) && user.subscription) {
        await prisma.subscription.update({
          where: { id: user.subscription.id },
          data: {
            ...(planTier && { planTier }),
            ...(subscriptionStatus && {
              status: subscriptionStatus,
              // Clear trialEndsAt when ending a trial
              ...(subscriptionStatus === 'ACTIVE' && { trialEndsAt: null }),
            }),
          },
        });
      }

      const updated = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          emailVerified: true,
          createdAt: true,
          subscription: {
            select: { planTier: true, status: true, trialEndsAt: true },
          },
        },
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/users/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { subscription: true },
    });
    if (!user) throw new NotFoundError('User');

    // Don't allow deleting yourself
    if (user.id === req.user!.userId) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ message: 'User deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:id/impersonate
router.post('/:id/impersonate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUser = await prisma.user.findUnique({
      where: { id: req.params.id },
    });

    if (!targetUser) {
      throw new NotFoundError('User');
    }

    if (!targetUser.isActive) {
      res.status(400).json({ error: 'Cannot impersonate an inactive user' });
      return;
    }

    const accessToken = generateAccessToken({
      userId: targetUser.id,
      email: targetUser.email,
      role: targetUser.role,
      emailVerified: targetUser.emailVerified,
    });
    const refreshToken = await generateRefreshToken(targetUser.id);

    await prisma.activityLog.create({
      data: {
        type: 'USER_LOGIN',
        message: `Admin ${req.user!.email} impersonated user ${targetUser.email}`,
        userId: targetUser.id,
        metadata: { impersonatedBy: req.user!.userId },
      },
    });

    res.json({
      user: {
        id: targetUser.id,
        email: targetUser.email,
        name: targetUser.name,
        role: targetUser.role,
        emailVerified: targetUser.emailVerified,
      },
      tokens: { accessToken, refreshToken },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
