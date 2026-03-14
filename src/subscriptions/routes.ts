import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../shared/middleware/auth';
import { validate } from '../shared/middleware/validate';
import { getSubscription, createCheckoutSession, createBillingPortalSession } from './services/stripeService';
import { PLAN_INFO, PLAN_LIMITS } from './planLimits';
import { NotFoundError } from '../shared/errors';

const router = Router();

// GET /api/subscriptions/plans — public, no auth
router.get('/plans', (_req: Request, res: Response) => {
  res.json(PLAN_INFO.map((p) => ({
    ...p,
    limits: PLAN_LIMITS[p.tier],
  })));
});

// All other routes require auth
router.use(authenticate);

// GET /api/subscriptions/current
router.get('/current', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sub = await getSubscription(req.user!.userId);
    if (!sub) {
      throw new NotFoundError('Subscription');
    }
    res.json(sub);
  } catch (err) {
    next(err);
  }
});

// POST /api/subscriptions/checkout
router.post(
  '/checkout',
  validate(z.object({ priceId: z.string().min(1, 'Price ID is required') })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const url = await createCheckoutSession(req.user!.userId, req.body.priceId);
      res.json({ url });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/subscriptions/portal
router.post('/portal', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const url = await createBillingPortalSession(req.user!.userId);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

export default router;
