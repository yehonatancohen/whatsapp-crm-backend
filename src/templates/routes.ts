import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../shared/middleware/auth';
import { validate } from '../shared/middleware/validate';
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  listCategories,
} from './services/templateService';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  content: z.string().min(1).max(5000),
  category: z.string().max(100).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(5000).optional(),
  category: z.string().max(100).nullable().optional(),
});

// GET /api/templates
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const category = req.query.category as string | undefined;
    const templates = await listTemplates(req.user!.userId, category);
    res.json(templates);
  } catch (err) { next(err); }
});

// GET /api/templates/categories
router.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const categories = await listCategories(req.user!.userId);
    res.json(categories);
  } catch (err) { next(err); }
});

// GET /api/templates/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const template = await getTemplate(req.params.id, req.user!.userId);
    res.json(template);
  } catch (err) { next(err); }
});

// POST /api/templates
router.post('/', validate(createSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const template = await createTemplate(req.user!.userId, req.body);
    res.status(201).json(template);
  } catch (err) { next(err); }
});

// PATCH /api/templates/:id
router.patch('/:id', validate(updateSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const template = await updateTemplate(req.params.id, req.user!.userId, req.body);
    res.json(template);
  } catch (err) { next(err); }
});

// DELETE /api/templates/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteTemplate(req.params.id, req.user!.userId);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
