import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../shared/middleware/auth';
import { validate } from '../shared/middleware/validate';
import * as service from './services/promotionService';

const router = Router();
router.use(authenticate);

// ─── Zod Schemas ────────────────────────────────────────────────────

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

const createSchema = z.object({
  name: z.string().min(1).max(200),
  sendTimes: z.array(z.string().regex(timeRegex, 'Must be HH:mm')).min(1).max(24),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  timezone: z.string().optional(),
  accountIds: z.array(z.string()).min(1),
  dailyLimitPerAccount: z.number().int().min(1).max(200).optional(),
  messagesPerMinute: z.number().int().min(1).max(10).optional(),
  groups: z.array(z.object({ jid: z.string(), name: z.string().optional() })).min(1),
  messages: z.array(z.object({
    content: z.string().min(1).max(5000),
    mediaUrl: z.string().url().optional(),
  })).min(1),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  sendTimes: z.array(z.string().regex(timeRegex)).optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  timezone: z.string().optional(),
  accountIds: z.array(z.string()).optional(),
  dailyLimitPerAccount: z.number().int().min(1).max(200).optional(),
  messagesPerMinute: z.number().int().min(1).max(10).optional(),
});

const addMessageSchema = z.object({
  content: z.string().min(1).max(5000),
  mediaUrl: z.string().url().optional(),
});

const updateMessageSchema = z.object({
  content: z.string().min(1).max(5000).optional(),
  mediaUrl: z.string().url().optional().nullable(),
  isActive: z.boolean().optional(),
});

const updateGroupsSchema = z.object({
  groups: z.array(z.object({ jid: z.string(), name: z.string().optional() })),
});

// ─── Routes ─────────────────────────────────────────────────────────

// List promotions
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await service.listPromotions(req.user!.userId, req.user!.role);
    res.json(data);
  } catch (err) { next(err); }
});

// Get single promotion
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await service.getPromotion(req.params.id, req.user!.userId, req.user!.role);
    res.json(data);
  } catch (err) { next(err); }
});

// Create promotion
router.post('/', validate(createSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await service.createPromotion(req.user!.userId, req.body);
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// Update promotion settings
router.patch('/:id', validate(updateSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await service.updatePromotion(req.params.id, req.user!.userId, req.user!.role, req.body);
    res.json(data);
  } catch (err) { next(err); }
});

// Delete promotion
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await service.deletePromotion(req.params.id, req.user!.userId, req.user!.role);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Toggle active/inactive
router.post('/:id/toggle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await service.togglePromotion(req.params.id, req.user!.userId, req.user!.role);
    res.json(data);
  } catch (err) { next(err); }
});

// ─── Message Pool ───────────────────────────────────────────────────

router.post('/:id/messages', validate(addMessageSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await service.addMessage(req.params.id, req.user!.userId, req.user!.role, req.body);
    res.status(201).json(data);
  } catch (err) { next(err); }
});

router.patch('/:id/messages/:msgId', validate(updateMessageSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await service.updateMessage(req.params.msgId, req.user!.userId, req.user!.role, req.body);
    res.json(data);
  } catch (err) { next(err); }
});

router.delete('/:id/messages/:msgId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await service.removeMessage(req.params.msgId, req.user!.userId, req.user!.role);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── Groups ─────────────────────────────────────────────────────────

router.put('/:id/groups', validate(updateGroupsSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await service.updateGroups(req.params.id, req.user!.userId, req.user!.role, req.body.groups);
    res.json(data);
  } catch (err) { next(err); }
});

// ─── Logs ───────────────────────────────────────────────────────────

router.get('/:id/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const data = await service.getPromotionLogs(req.params.id, req.user!.userId, req.user!.role, limit, offset);
    res.json(data);
  } catch (err) { next(err); }
});

export default router;
