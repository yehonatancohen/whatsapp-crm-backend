import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../shared/middleware/validate';
import { NotFoundError } from '../shared/errors';
import {
  listGroupCollections,
  createGroupCollection,
  getGroupCollectionWithEntries,
  updateGroupCollection,
  deleteGroupCollection,
  replaceGroupsInCollection,
} from './services/groupCollectionService';

const router = Router();

const createSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  description: z.string().max(500).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

const replaceGroupsSchema = z.object({
  groups: z
    .array(z.object({ jid: z.string().min(1), name: z.string().optional() }))
    .min(1, 'At least one group is required'),
});

// GET /api/group-collections
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const collections = await listGroupCollections(req.user!.userId);
    res.json(collections);
  } catch (err) {
    next(err);
  }
});

// POST /api/group-collections
router.post(
  '/',
  validate(createSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const collection = await createGroupCollection(
        req.user!.userId,
        req.body.name,
        req.body.description,
      );
      res.status(201).json(collection);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/group-collections/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const collection = await getGroupCollectionWithEntries(req.params.id, req.user!.userId);
    if (!collection) throw new NotFoundError('Group collection');
    res.json(collection);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/group-collections/:id
router.patch(
  '/:id',
  validate(updateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const collection = await updateGroupCollection(req.params.id, req.user!.userId, req.body);
      if (!collection) throw new NotFoundError('Group collection');
      res.json(collection);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/group-collections/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await deleteGroupCollection(req.params.id, req.user!.userId);
    if (!deleted) throw new NotFoundError('Group collection');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// PUT /api/group-collections/:id/groups
router.put(
  '/:id/groups',
  validate(replaceGroupsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Verify ownership first
      const collection = await getGroupCollectionWithEntries(req.params.id, req.user!.userId);
      if (!collection) throw new NotFoundError('Group collection');

      await replaceGroupsInCollection(req.params.id, req.body.groups);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
