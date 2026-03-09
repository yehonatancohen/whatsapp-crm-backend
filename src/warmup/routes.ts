import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../shared/middleware/auth';
import { validate } from '../shared/middleware/validate';
import { NotFoundError, ForbiddenError } from '../shared/errors';
import { prisma } from '../shared/db';
import {
  getWarmupStatus,
  toggleWarmup,
  getWarmupHistory,
  getWarmupOverview,
} from './warmupService';

const router = Router();

// All routes require authentication
router.use(authenticate);

const toggleSchema = z.object({
  enabled: z.boolean(),
});

/** Verify the account belongs to the requesting user (unless admin). */
async function verifyOwnership(accountId: string, userId: string, role: string): Promise<void> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new NotFoundError('Account');
  if (role !== 'ADMIN' && account.userId !== userId) {
    throw new ForbiddenError('You do not own this account');
  }
}

// GET /api/warmup/overview
router.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const overview = await getWarmupOverview(req.user!.userId, req.user!.role);
    res.json(overview);
  } catch (err) {
    next(err);
  }
});

// GET /api/warmup/:accountId
router.get('/:accountId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await verifyOwnership(req.params.accountId, req.user!.userId, req.user!.role);
    const status = await getWarmupStatus(req.params.accountId);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// GET /api/warmup/:accountId/history
router.get('/:accountId/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await verifyOwnership(req.params.accountId, req.user!.userId, req.user!.role);
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const history = await getWarmupHistory(req.params.accountId, limit);
    res.json(history);
  } catch (err) {
    next(err);
  }
});

// POST /api/warmup/:accountId/toggle
router.post(
  '/:accountId/toggle',
  validate(toggleSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await toggleWarmup(
        req.params.accountId,
        req.body.enabled,
        req.user!.userId,
        req.user!.role,
      );
      res.json(status);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
