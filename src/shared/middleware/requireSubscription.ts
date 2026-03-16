import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db';
import { ForbiddenError } from '../errors';
import { config } from '../../config';

export async function requireActiveSubscription(req: Request, _res: Response, next: NextFunction): Promise<void> {
  // Admins bypass subscription check
  if (req.user!.role === 'ADMIN') return next();

  let sub = await prisma.subscription.findUnique({
    where: { userId: req.user!.userId },
  });

  // Auto-create trial subscription if none exists (handles race condition from registration)
  if (!sub) {
    const trialEndsAt = new Date(Date.now() + (config.trialDays || 30) * 24 * 60 * 60 * 1000);
    sub = await prisma.subscription.create({
      data: {
        userId: req.user!.userId,
        stripeCustomerId: `mock_${req.user!.userId}`,
        status: 'TRIALING',
        planTier: 'STARTER',
        trialEndsAt,
      },
    });
  }

  const activeStatuses = ['TRIALING', 'ACTIVE'];
  if (!activeStatuses.includes(sub.status)) {
    throw new ForbiddenError('Your subscription is not active. Please update your billing.');
  }

  // Check trial expiry
  if (sub.status === 'TRIALING' && sub.trialEndsAt && sub.trialEndsAt < new Date()) {
    throw new ForbiddenError('Your trial has expired. Please choose a plan to continue.');
  }

  next();
}
