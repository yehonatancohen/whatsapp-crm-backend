import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { CampaignStatus } from '@prisma/client';
import { authenticate } from '../shared/middleware/auth';
import { validate } from '../shared/middleware/validate';
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
  deleteCampaign,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  getCampaignProgress,
  getCampaignFailures,
} from './services/campaignService';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ─── Zod Schemas ────────────────────────────────────────────────────────────

const createSchema = z.object({
  name: z.string().min(1, 'Campaign name is required').max(200, 'Campaign name must be 200 characters or less'),
  messageTemplate: z.string().min(1, 'Message template is required').max(5000, 'Message template must be 5000 characters or less'),
  type: z.enum(['DIRECT_MESSAGE', 'GROUP_MESSAGE']).optional(),
  contactListId: z.string().optional(),
  scheduledAt: z.string().datetime('Invalid date format').optional(),
  messagesPerMinute: z.number().int('Must be a whole number').min(1, 'Minimum 1 message per minute').max(10, 'Maximum 10 messages per minute').optional(),
  dailyLimitPerAccount: z.number().int('Must be a whole number').min(1, 'Minimum 1 message per day').max(200, 'Maximum 200 messages per day per account').optional(),
  groupJids: z.array(z.object({
    jid: z.string(),
    name: z.string().optional(),
  })).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1, 'Campaign name is required').max(200, 'Campaign name must be 200 characters or less').optional(),
  messageTemplate: z.string().min(1, 'Message template is required').max(5000, 'Message template must be 5000 characters or less').optional(),
  type: z.enum(['DIRECT_MESSAGE', 'GROUP_MESSAGE']).optional(),
  contactListId: z.string().optional(),
  scheduledAt: z.string().datetime('Invalid date format').optional(),
  messagesPerMinute: z.number().int('Must be a whole number').min(1, 'Minimum 1 message per minute').max(10, 'Maximum 10 messages per minute').optional(),
  dailyLimitPerAccount: z.number().int('Must be a whole number').min(1, 'Minimum 1 message per day').max(200, 'Maximum 200 messages per day per account').optional(),
});

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET /api/campaigns
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as CampaignStatus | undefined;
    const campaigns = await listCampaigns(req.user!.userId, req.user!.role, status);
    res.json(campaigns);
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await getCampaign(req.params.id, req.user!.userId, req.user!.role);
    res.json(campaign);
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id/progress
router.get('/:id/progress', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const progress = await getCampaignProgress(req.params.id);
    res.json(progress);
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id/failures
router.get('/:id/failures', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const failures = await getCampaignFailures(
      req.params.id,
      req.user!.userId,
      req.user!.role,
      limit,
    );
    res.json(failures);
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns
router.post(
  '/',
  validate(createSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const campaign = await createCampaign(req.user!.userId, req.body);
      res.status(201).json(campaign);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/campaigns/:id
router.patch(
  '/:id',
  validate(updateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const campaign = await updateCampaign(
        req.params.id,
        req.user!.userId,
        req.user!.role,
        req.body,
      );
      res.json(campaign);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/campaigns/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteCampaign(req.params.id, req.user!.userId, req.user!.role);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/:id/start
router.post('/:id/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await startCampaign(req.params.id, req.user!.userId, req.user!.role);
    res.json(campaign);
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/:id/pause
router.post('/:id/pause', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await pauseCampaign(req.params.id, req.user!.userId, req.user!.role);
    res.json(campaign);
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/:id/resume
router.post('/:id/resume', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await resumeCampaign(req.params.id, req.user!.userId, req.user!.role);
    res.json(campaign);
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/:id/cancel
router.post('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await cancelCampaign(req.params.id, req.user!.userId, req.user!.role);
    res.json(campaign);
  } catch (err) {
    next(err);
  }
});

export default router;
