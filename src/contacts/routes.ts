import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { authenticate } from '../shared/middleware/auth';
import { validate } from '../shared/middleware/validate';
import { NotFoundError, ValidationError } from '../shared/errors';
import { prisma } from '../shared/db';
import {
  listContacts,
  createContact,
  updateContact,
  deleteContact,
  listContactLists,
  createContactList,
  getContactListWithContacts,
  addContactsToList,
  removeContactsFromList,
} from './services/contactService';
import { importFromBuffer } from './services/importService';

const router = Router();
router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(csv|xlsx|xls)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files are accepted'));
    }
  },
});

const createContactSchema = z.object({
  phoneNumber: z.string().min(7, 'Phone number must be at least 7 digits').max(15, 'Phone number must be at most 15 digits'),
  name: z.string().max(200, 'Name must be 200 characters or less').optional(),
  tags: z.array(z.string()).optional(),
});

const updateContactSchema = z.object({
  name: z.string().max(200, 'Name must be 200 characters or less').optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.any().optional(),
});

const createListSchema = z.object({
  name: z.string().min(1, 'List name is required').max(100, 'List name must be 100 characters or less'),
  description: z.string().max(500, 'Description must be 500 characters or less').optional(),
});

const contactIdsSchema = z.object({
  contactIds: z.array(z.string()).min(1, 'At least one contact must be selected'),
});

// ─── Contacts CRUD ───

// GET /api/contacts
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const search = (req.query.search as string) || undefined;
    const tags = req.query.tags ? (req.query.tags as string).split(',') : undefined;

    const result = await listContacts({ page, limit, search, tags, userId: req.user!.userId, isAdmin: req.user!.role === 'ADMIN' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts
router.post(
  '/',
  validate(createContactSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const contact = await createContact(req.body.phoneNumber, req.body.name, req.body.tags, req.user!.userId);
      res.status(201).json(contact);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/contacts/import
router.post(
  '/import',
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) throw new ValidationError('File is required');

      const listName = req.body.listName as string | undefined;
      const result = await importFromBuffer(req.file.buffer, req.file.originalname, {
        listName: listName || undefined,
        userId: req.user!.userId,
      });

      res.json({
        message: 'Import completed',
        ...result,
      });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/contacts/:id
router.patch(
  '/:id',
  validate(updateContactSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const contact = await updateContact(req.params.id, req.body);
      res.json(contact);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/contacts/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteContact(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ─── Contact Lists ───

// GET /api/contacts/lists
router.get('/lists', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lists = await listContactLists(req.user!.userId);
    res.json(lists);
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/lists
router.post(
  '/lists',
  validate(createListSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const list = await createContactList(req.user!.userId, req.body.name, req.body.description);
      res.status(201).json(list);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/contacts/lists/:id
router.delete('/lists/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await prisma.contactList.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!list) throw new NotFoundError('Contact list');
    await prisma.contactList.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/lists/:id
router.get('/lists/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await getContactListWithContacts(req.params.id, req.user!.userId);
    if (!list) throw new NotFoundError('Contact list');
    res.json(list);
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/lists/:id/contacts
router.post(
  '/lists/:id/contacts',
  validate(contactIdsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await addContactsToList(req.params.id, req.body.contactIds);
      res.json({ message: 'Contacts added to list' });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/contacts/lists/:id/contacts
router.delete(
  '/lists/:id/contacts',
  validate(contactIdsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await removeContactsFromList(req.params.id, req.body.contactIds);
      res.json({ message: 'Contacts removed from list' });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
