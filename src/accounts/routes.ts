import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../shared/middleware/auth';
import { validate } from '../shared/middleware/validate';
import { ClientManager } from './services/ClientManager';
import { NotFoundError } from '../shared/errors';

const router = Router();

// All routes require authentication
router.use(authenticate);

const createAccountSchema = z.object({
  label: z
    .string()
    .min(1, 'Label is required')
    .max(50)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Only letters, numbers, hyphens and underscores allowed'),
  proxy: z.string().optional(),
});

const updateAccountSchema = z.object({
  isWarmupEnabled: z.boolean().optional(),
  proxy: z.string().optional(),
});

// GET /api/accounts
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const manager = ClientManager.getInstance();
    const isAdmin = req.user!.role === 'ADMIN';
    const accounts = await manager.getAllAccounts(req.user!.userId, isAdmin);
    res.json(accounts);
  } catch (err) {
    next(err);
  }
});

// GET /api/accounts/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const manager = ClientManager.getInstance();
    const isAdmin = req.user!.role === 'ADMIN';
    const account = await manager.getAccount(
      req.params.id,
      isAdmin ? undefined : req.user!.userId,
    );
    if (!account) throw new NotFoundError('Account');
    res.json(account);
  } catch (err) {
    next(err);
  }
});

// GET /api/accounts/:id/qr
router.get('/:id/qr', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const manager = ClientManager.getInstance();
    const isAdmin = req.user!.role === 'ADMIN';
    const account = await manager.getAccount(
      req.params.id,
      isAdmin ? undefined : req.user!.userId,
    );
    if (!account) throw new NotFoundError('Account');

    if (!account.qrCode) {
      res.status(404).json({ error: 'No QR code available', status: account.status });
      return;
    }

    res.json({ id: account.id, qrCode: account.qrCode });
  } catch (err) {
    next(err);
  }
});

// GET /api/accounts/:id/groups
router.get('/:id/groups', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const manager = ClientManager.getInstance();
    const isAdmin = req.user!.role === 'ADMIN';
    const account = await manager.getAccount(
      req.params.id,
      isAdmin ? undefined : req.user!.userId,
    );
    if (!account) throw new NotFoundError('Account');

    const instance = manager.getInstanceById(req.params.id);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.json([]);
      return;
    }

    const groups = await instance.getGroups();
    res.json(groups);
  } catch (err) {
    next(err);
  }
});

// POST /api/accounts
router.post(
  '/',
  validate(createAccountSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const manager = ClientManager.getInstance();
      const account = await manager.addAccount(
        req.user!.userId,
        req.body.label,
        req.body.proxy,
      );
      res.status(201).json(account);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/accounts/:id
router.patch(
  '/:id',
  validate(updateAccountSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const manager = ClientManager.getInstance();
      const isAdmin = req.user!.role === 'ADMIN';
      const account = await manager.getAccount(
        req.params.id,
        isAdmin ? undefined : req.user!.userId,
      );
      if (!account) throw new NotFoundError('Account');

      // For now just return account — full PATCH logic in Phase 4 (warmup toggle)
      res.json(account);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/accounts/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const manager = ClientManager.getInstance();
    const isAdmin = req.user!.role === 'ADMIN';
    const removed = await manager.removeAccount(
      req.params.id,
      isAdmin ? undefined : req.user!.userId,
    );
    if (!removed) throw new NotFoundError('Account');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/accounts/:id/reconnect
router.post('/:id/reconnect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const manager = ClientManager.getInstance();
    const account = await manager.reconnectAccount(req.params.id, req.user!.userId);
    res.json(account);
  } catch (err) {
    next(err);
  }
});

export default router;
