import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db';
import { ForbiddenError } from '../errors';

export async function requireActiveSubscription(req: Request, _res: Response, next: NextFunction): Promise<void> {
  // Admins bypass subscription check
  if (req.user!.role === 'ADMIN') return next();

  const sub = await prisma.subscription.findUnique({
    where: { userId: req.user!.userId },
  });

  if (!sub) {
    throw new ForbiddenError('No subscription found. Please choose a plan.');
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
