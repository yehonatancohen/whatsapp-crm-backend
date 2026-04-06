import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../shared/middleware/auth';
import { validate } from '../shared/middleware/validate';
import {
  listAutoReplies,
  getAutoReply,
  createAutoReply,
  updateAutoReply,
  deleteAutoReply,
  toggleAutoReply,
} from './services/autoReplyService';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  matchType: z.enum(['EXACT', 'CONTAINS', 'STARTS_WITH', 'REGEX']).optional(),
  matchValue: z.string().min(1).max(500),
  replyMessage: z.string().min(1).max(5000),
  accountIds: z.array(z.string()).optional(),
  onlyPrivate: z.boolean().optional(),
  cooldownSec: z.number().int().min(0).max(86400).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  matchType: z.enum(['EXACT', 'CONTAINS', 'STARTS_WITH', 'REGEX']).optional(),
  matchValue: z.string().min(1).max(500).optional(),
  replyMessage: z.string().min(1).max(5000).optional(),
  accountIds: z.array(z.string()).optional(),
  onlyPrivate: z.boolean().optional(),
  cooldownSec: z.number().int().min(0).max(86400).optional(),
});

// GET /api/auto-replies
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rules = await listAutoReplies(req.user!.userId);
    res.json(rules);
  } catch (err) { next(err); }
});

// GET /api/auto-replies/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rule = await getAutoReply(req.params.id, req.user!.userId);
    res.json(rule);
  } catch (err) { next(err); }
});

// POST /api/auto-replies
router.post('/', validate(createSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rule = await createAutoReply(req.user!.userId, req.body);
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

// PATCH /api/auto-replies/:id
router.patch('/:id', validate(updateSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rule = await updateAutoReply(req.params.id, req.user!.userId, req.body);
    res.json(rule);
  } catch (err) { next(err); }
});

// POST /api/auto-replies/:id/toggle
router.post('/:id/toggle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rule = await toggleAutoReply(req.params.id, req.user!.userId);
    res.json(rule);
  } catch (err) { next(err); }
});

// DELETE /api/auto-replies/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteAutoReply(req.params.id, req.user!.userId);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
