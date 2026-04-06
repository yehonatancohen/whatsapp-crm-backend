import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../shared/middleware/auth';
import { validate } from '../shared/middleware/validate';
import {
  listScheduledMessages,
  createScheduledMessage,
  cancelScheduledMessage,
  deleteScheduledMessage,
} from './services/scheduledMessageService';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  chatId: z.string().min(1),
  chatName: z.string().optional(),
  body: z.string().min(1).max(5000),
  scheduledAt: z.string().datetime(),
  accountId: z.string().min(1),
});

// GET /api/scheduled-messages
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accountId = req.query.accountId as string | undefined;
    const messages = await listScheduledMessages(req.user!.userId, accountId);
    res.json(messages);
  } catch (err) { next(err); }
});

// POST /api/scheduled-messages
router.post('/', validate(createSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const msg = await createScheduledMessage(req.user!.userId, req.body);
    res.status(201).json(msg);
  } catch (err) { next(err); }
});

// POST /api/scheduled-messages/:id/cancel
router.post('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const msg = await cancelScheduledMessage(req.params.id, req.user!.userId);
    res.json(msg);
  } catch (err) { next(err); }
});

// DELETE /api/scheduled-messages/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteScheduledMessage(req.params.id, req.user!.userId);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
