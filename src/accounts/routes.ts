import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { MessageMedia } from 'whatsapp-web.js';
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
  label: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Only letters, numbers, hyphens and underscores allowed')
    .optional(),
  isWarmupEnabled: z.boolean().optional(),
  proxy: z.string().optional(),
});

// GET /api/accounts
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const manager = ClientManager.getInstance();
    const accounts = await manager.getAllAccounts(req.user!.userId, false);
    res.json(accounts);
  } catch (err) {
    next(err);
  }
});

// GET /api/accounts/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const manager = ClientManager.getInstance();
    const account = await manager.getAccount(req.params.id, req.user!.userId);
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
    const account = await manager.getAccount(req.params.id, req.user!.userId);
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
    const account = await manager.getAccount(req.params.id, req.user!.userId);
    if (!account) throw new NotFoundError('Account');

    const instance = manager.getInstanceById(req.params.id);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.json([]);
      return;
    }

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Groups fetch timed out')), 90_000),
    );
    const groups = await Promise.race([instance.getGroups(), timeout]);
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
      const account = await manager.updateAccount(
        req.params.id,
        req.user!.userId,
        req.body
      );
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
    const removed = await manager.removeAccount(req.params.id, req.user!.userId);
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

// ─── Profile Management ──────────────────────────────────────────────────────

const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG and WebP images are accepted'));
    }
  },
});

const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(25).optional(),
  status: z.string().max(139).optional(),
});

/** Helper: get an authenticated client for the given account, with ownership check. */
async function getAuthenticatedClient(req: Request) {
  const manager = ClientManager.getInstance();
  const account = await manager.getAccount(req.params.id, req.user!.userId);
  if (!account) throw new NotFoundError('Account');

  const instance = manager.getInstanceById(req.params.id);
  if (!instance || instance.status !== 'AUTHENTICATED') {
    return null;
  }
  return instance.getClient();
}

// GET /api/accounts/:id/profile
router.get('/:id/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = await getAuthenticatedClient(req);
    if (!client) {
      res.status(409).json({ error: 'Account is not connected' });
      return;
    }

    let profilePicUrl: string | null = null;
    try {
      const url = await client.getProfilePicUrl(client.info.wid._serialized);
      profilePicUrl = url || null;
    } catch {
      // Profile picture may not be set
    }

    res.json({
      displayName: client.info.pushname || null,
      phoneNumber: client.info.wid.user || null,
      profilePicUrl,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/accounts/:id/profile
router.post(
  '/:id/profile',
  validate(updateProfileSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const client = await getAuthenticatedClient(req);
      if (!client) {
        res.status(409).json({ error: 'Account is not connected' });
        return;
      }

      const { displayName, status } = req.body;
      const results: Record<string, boolean> = {};

      if (displayName !== undefined) {
        results.displayName = await client.setDisplayName(displayName);
      }
      if (status !== undefined) {
        await client.setStatus(status);
        results.status = true;
      }

      res.json({ success: true, results });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/accounts/:id/profile-picture
router.post(
  '/:id/profile-picture',
  profileUpload.single('image'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const client = await getAuthenticatedClient(req);
      if (!client) {
        res.status(409).json({ error: 'Account is not connected' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ error: 'No image provided' });
        return;
      }

      const base64 = req.file.buffer.toString('base64');
      const media = new MessageMedia(req.file.mimetype, base64, req.file.originalname);
      const success = await client.setProfilePicture(media);

      res.json({ success });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/accounts/:id/profile-picture
router.delete('/:id/profile-picture', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = await getAuthenticatedClient(req);
    if (!client) {
      res.status(409).json({ error: 'Account is not connected' });
      return;
    }

    const success = await client.deleteProfilePicture();
    res.json({ success });
  } catch (err) {
    next(err);
  }
});

export default router;
